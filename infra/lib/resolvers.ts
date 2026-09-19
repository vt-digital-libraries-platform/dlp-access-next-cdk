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
  const typenameStep = resolveTypename
    ? `
    if (source.collection_category) {
      source.__typename = 'Collection';
    } else {
      source.__typename = 'Archive';
    }`
    : '';
  return (
    HEADER +
    `export function request(ctx) {
  const args = ctx.args;
  const direction = args.sort && args.sort.direction ? args.sort.direction : 'desc';
  const field = args.sort && args.sort.field ? args.sort.field : 'id';
  const sortField = field === 'visibility' || field === 'start_date' ? field : field + '.keyword';
  const sortClause = {};
  sortClause[sortField] = { order: direction };

  const bool = {};
  if (args.filter) {
    // toElasticsearchQueryDSL returns a JSON string, not an object.
    bool.must = JSON.parse(util.transform.toElasticsearchQueryDSL(args.filter));
  }
  if (args.allFields) {
    bool.should = [
      { multi_match: { query: args.allFields, type: 'phrase', fields: ${JSON.stringify(searchFields)} } },
    ];
    bool.minimum_should_match = 1;
  }
  // AppSync JS forbids reassigning variables, so choose the query in one expression.
  const query = args.filter || args.allFields ? { bool: bool } : { match_all: {} };

  const body = { size: args.limit ? args.limit : 100, sort: [sortClause], query: query };
  if (args.nextToken) {
    body.search_after = [args.nextToken];
  }
  return { operation: 'GET', path: ${JSON.stringify(`/${index}/_search`)}, params: { body: body } };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const hits = ctx.result && ctx.result.hits && ctx.result.hits.hits ? ctx.result.hits.hits : [];
  const total = ctx.result && ctx.result.hits && ctx.result.hits.total ? ctx.result.hits.total.value : 0;
  const items = [];
  for (const hit of hits) {
    const source = hit._source;${typenameStep}
    items.push(source);
  }
  const last = hits.length > 0 ? hits[hits.length - 1] : null;
  const nextToken = last && last.sort ? last.sort[0] : null;
  return { items: items, total: total, nextToken: nextToken };
}
`
  );
}
