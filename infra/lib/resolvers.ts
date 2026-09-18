/**
 * APPSYNC_JS (1.0.0) resolver source generators.
 *
 * Every model here follows one of a handful of shapes the original Amplify
 * VTL resolvers used (GetItem by id, Scan for a plain list, Query against a
 * GSI, or a relation lookup via a foreign-key attribute already present on
 * the parent item). Rather than hand-writing ~27 near-identical resolver
 * files, each shape is a small generator so the CDK stack can stamp out one
 * per field while keeping the DynamoDB key/index names in one place.
 */

const HEADER = `import { util } from '@aws-appsync/utils';\n\n`;

const DEFAULT_RESPONSE = `
export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
`;

/** Query.getX(id: ID!): GetItem on the field's own table by primary key. */
export function getByIdCode(): string {
  return (
    HEADER +
    `export function request(ctx) {
  return { operation: 'GetItem', key: util.dynamodb.toMapValues({ id: ctx.args.id }) };
}
` +
    DEFAULT_RESPONSE
  );
}

/** Query.listX: unfiltered Scan with limit/nextToken pagination. */
export function listScanCode(): string {
  return (
    HEADER +
    `export function request(ctx) {
  return {
    operation: 'Scan',
    limit: ctx.args.limit ?? 100,
    nextToken: ctx.args.nextToken,
  };
}
` +
    DEFAULT_RESPONSE
  );
}

/**
 * Query.xByY: Query against a GSI keyed on a single hash attribute
 * (e.g. archiveByIdentifier -> "Identifier" index on `identifier`).
 */
export function queryByIndexCode(opts: {
  indexName: string;
  keyField: string;
  argName: string;
}): string {
  const { indexName, keyField, argName } = opts;
  return (
    HEADER +
    `export function request(ctx) {
  return {
    operation: 'Query',
    index: ${JSON.stringify(indexName)},
    query: {
      expression: '#k = :v',
      expressionNames: { '#k': ${JSON.stringify(keyField)} },
      expressionValues: util.dynamodb.toMapValues({ ':v': ctx.args.${argName} }),
    },
    scanIndexForward: ctx.args.sortDirection !== 'DESC',
    limit: ctx.args.limit ?? 100,
    nextToken: ctx.args.nextToken,
  };
}
` +
    DEFAULT_RESPONSE
  );
}

/**
 * Single-item relation field (@hasOne equivalent): GetItem on the related
 * table using a foreign-key attribute already present on ctx.source
 * (e.g. Archive.collection reads ctx.source.archiveCollectionId).
 */
export function hasOneCode(foreignKeyField: string): string {
  return (
    `import { util, runtime } from '@aws-appsync/utils';\n\n` +
    `export function request(ctx) {
  const fk = ctx.source.${foreignKeyField};
  if (!fk) {
    runtime.earlyReturn(null);
  }
  return { operation: 'GetItem', key: util.dynamodb.toMapValues({ id: fk }) };
}
` +
    DEFAULT_RESPONSE
  );
}

/**
 * Multi-item relation field (@hasMany equivalent): Query a GSI on the
 * related table keyed by a foreign-key attribute that points back at the
 * parent's id (e.g. Collection.archives -> "gsi-Collection.archives" index
 * on Archive.collectionArchivesId, matched against the Collection's own id).
 */
export function hasManyCode(opts: { indexName: string; foreignKeyField: string }): string {
  const { indexName, foreignKeyField } = opts;
  return (
    HEADER +
    `export function request(ctx) {
  return {
    operation: 'Query',
    index: ${JSON.stringify(indexName)},
    query: {
      expression: '#k = :v',
      expressionNames: { '#k': ${JSON.stringify(foreignKeyField)} },
      expressionValues: util.dynamodb.toMapValues({ ':v': ctx.source.id }),
    },
    limit: ctx.args.limit ?? 100,
    nextToken: ctx.args.nextToken,
  };
}
` +
    DEFAULT_RESPONSE
  );
}

/**
 * Query.fulltextX: OpenSearch _search against a single index, mirroring the
 * Amplify searchable VTL resolvers (structured `filter` via
 * toElasticsearchQueryDSL, optional `allFields` phrase multi_match across
 * `searchFields`, sort on the `.keyword` subfield, search_after paging).
 */
export function openSearchQueryCode(opts: {
  index: string;
  searchFields: string[];
  /** Tag each hit with __typename (Collection if it has collection_category, else Archive) for interface results. */
  resolveTypename?: boolean;
}): string {
  const { index, searchFields, resolveTypename = false } = opts;
  const itemExpr = resolveTypename
    ? `hits.map((hit) => ({
      ...hit._source,
      __typename: hit._source.collection_category ? 'Collection' : 'Archive',
    }))`
    : `hits.map((hit) => hit._source)`;
  return (
    HEADER +
    `const NON_KEYWORD_FIELDS = ['visibility', 'start_date'];
const SEARCH_FIELDS = ${JSON.stringify(searchFields)};

export function request(ctx) {
  const { allFields, filter, sort, limit, nextToken } = ctx.args;
  const direction = sort?.direction ?? 'desc';
  const field = sort?.field ?? 'id';
  const sortField = NON_KEYWORD_FIELDS.includes(field) ? field : field + '.keyword';

  let query = { match_all: {} };
  if (filter || allFields) {
    const bool = {};
    if (filter) {
      bool.must = util.transform.toElasticsearchQueryDSL(filter);
    }
    if (allFields) {
      bool.should = [{ multi_match: { query: allFields, type: 'phrase', fields: SEARCH_FIELDS } }];
      bool.minimum_should_match = 1;
    }
    query = { bool };
  }

  const body = { size: limit ?? 100, sort: [{ [sortField]: { order: direction } }], query };
  if (nextToken) {
    body.search_after = [nextToken];
  }
  return { operation: 'GET', path: ${JSON.stringify(`/${index}/_search`)}, params: { body } };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const hits = ctx.result?.hits?.hits ?? [];
  const total = ctx.result?.hits?.total;
  return {
    items: ${itemExpr},
    total: (typeof total === 'object' ? total?.value : total) ?? 0,
    nextToken: hits.length > 0 ? hits[hits.length - 1].sort?.[0] ?? null : null,
  };
}
`
  );
}
