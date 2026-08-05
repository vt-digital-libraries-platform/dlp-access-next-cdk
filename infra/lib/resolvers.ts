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
