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

/** OpenSearch's default max_result_window: the largest `size` a search accepts. */
export const MAX_SEARCH_LIMIT = 10000;

/**
 * Query.fulltextX: OpenSearch _search against a single index, mirroring the
 * Amplify searchable VTL resolvers (structured `filter` via
 * toElasticsearchQueryDSL, optional `allFields` phrase multi_match across
 * `searchFields`, sort on the `.keyword` subfield, search_after paging).
 *
 * Fields in `numericSortFields` (dates and booleans, which have no
 * `.keyword` subfield) are sorted on the field itself, and OpenSearch returns
 * their sort values as epoch millis or 0/1. Documents without the field sort
 * last, at ±MAX_SAFE_INTEGER rather than OpenSearch's default of ±2^63, which
 * a JS number can't hold exactly. Documents without a `.keyword` value (the
 * field is missing, or longer than `ignore_above`) also sort last, at a fixed
 * string rather than OpenSearch's default, whose sort value is null, so the
 * page token never holds a null.
 *
 * Every sort ends with `id.keyword`, so documents that tie on the requested
 * field still have a unique position and none are skipped at a page
 * boundary. The page token is the last hit's sort values as a JSON array,
 * passed back as `search_after`.
 *
 * `limit` defaults to 100 and is capped at OpenSearch's `max_result_window`
 * (10000). The search ignores an index that doesn't exist yet: indices are
 * created by the first document streamed to them, so a new domain returns no
 * results rather than an error.
 */
export function openSearchQueryCode(opts: {
  index: string;
  searchFields: string[];
  /** Fields sorted on the field itself, with numeric sort values. */
  numericSortFields: string[];
  /** Tag each hit with __typename (Collection if it has collection_category, else Archive) for interface results. */
  resolveTypename?: boolean;
}): string {
  const { index, searchFields, numericSortFields, resolveTypename = false } = opts;
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
  const numeric = ${JSON.stringify(numericSortFields)}.indexOf(field) >= 0;
  const sortField = numeric ? field : field + '.keyword';
  const sortClause = {};
  sortClause[sortField] = numeric
    ? { order: direction, missing: direction === 'asc' ? ${Number.MAX_SAFE_INTEGER} : ${-Number.MAX_SAFE_INTEGER} }
    : { order: direction, missing: direction === 'asc' ? '\\u{10FFFF}' : '' };
  // id is unique, so it breaks ties on the requested field.
  const sort = field === 'id' ? [sortClause] : [sortClause, { 'id.keyword': { order: direction } }];

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

  const limit = args.limit ?? 100;
  const body = { size: Math.max(0, Math.min(limit, ${MAX_SEARCH_LIMIT})), sort: sort, query: query };
  if (args.nextToken) {
    body.search_after = JSON.parse(args.nextToken);
  }
  return {
    operation: 'GET',
    path: ${JSON.stringify(`/${index}/_search`)},
    params: { query: { ignore_unavailable: 'true' }, body: body },
  };
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
  // nextToken is a String, so the sort values travel as JSON, keeping numbers as numbers.
  const nextToken = last && last.sort ? JSON.stringify(last.sort) : null;
  return { items: items, total: total, nextToken: nextToken };
}
`
  );
}
