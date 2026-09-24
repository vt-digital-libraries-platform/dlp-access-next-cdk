/**
 * The DynamoDB-backed models in the schema, and the table shapes copied from
 * the vtdlpdev Amplify tables (hash key `id`, GSIs projecting ALL).
 */
export const MODELS = [
  'Archive',
  'Collection',
  'Site',
  'Partner',
  'History',
  'MetadataField',
  'PageContent',
] as const;
export type ModelName = (typeof MODELS)[number];

// `list${model}s` is right for every model except History, whose Amplify
// (and this schema's) query field is the properly pluralized `listHistories`.
export const LIST_QUERY_FIELD: Record<ModelName, string> = {
  Archive: 'listArchives',
  Collection: 'listCollections',
  Site: 'listSites',
  Partner: 'listPartners',
  History: 'listHistories',
  MetadataField: 'listMetadataFields',
  PageContent: 'listPageContents',
};

export interface GlobalIndex {
  readonly indexName: string;
  /** String partition key attribute. */
  readonly partitionKey: string;
}

export const GLOBAL_INDEXES: Record<ModelName, GlobalIndex[]> = {
  Archive: [
    { indexName: 'Identifier', partitionKey: 'identifier' },
    { indexName: 'gsi-Collection.archives', partitionKey: 'collectionArchivesId' },
  ],
  Collection: [{ indexName: 'Identifier', partitionKey: 'identifier' }],
  Site: [{ indexName: 'SiteId', partitionKey: 'siteId' }],
  Partner: [{ indexName: 'Identifier', partitionKey: 'identifier' }],
  History: [],
  MetadataField: [],
  PageContent: [],
};

/** Models whose table streams are indexed into OpenSearch. */
export const SEARCHABLE_MODELS = ['Archive', 'Collection'] as const satisfies readonly ModelName[];

/**
 * The streaming handler names the index after the table name's first `-`
 * segment, lowercased, so table names must start with `<Model>-` for
 * Archive to land in `archive` and Collection in `collection`.
 */
export const tableName = (model: ModelName, env: string) => `${model}-dlpnext-${env}`;
