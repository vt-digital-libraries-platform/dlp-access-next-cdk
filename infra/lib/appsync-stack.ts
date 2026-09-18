import * as path from 'path';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import { Construct } from 'constructs';
import {
  getByIdCode,
  listScanCode,
  queryByIndexCode,
  hasOneCode,
  hasManyCode,
  openSearchQueryCode,
} from './resolvers';

export interface AppSyncStackProps extends StackProps {
  /**
   * Suffix Amplify appended to each of its DynamoDB table names
   * (`<Model>-<suffix>`), e.g. "bxbkjhe235e3jcwcjcji5txvlm-vtdlpdev" for the
   * vtdlpdev environment. Swap this per environment via CDK context
   * (`-c tableSuffix=...`) once a prod deployment is needed.
   */
  readonly tableSuffix: string;
  /**
   * Name of the existing IAM role used as the Elastic Beanstalk EC2 instance
   * profile role for the dlp-access-next app, which will be granted
   * `appsync:GraphQL` access to this API.
   */
  readonly ebInstanceRoleName: string;
  /**
   * Endpoint of the existing OpenSearch domain holding the `archive` and
   * `collection` indices (e.g. "search-xyz.us-east-1.es.amazonaws.com", with
   * or without https://). Passed via CDK context: `-c openSearchDomainEndpoint=...`.
   */
  readonly openSearchDomainEndpoint: string;
}

const MODELS = [
  'Archive',
  'Collection',
  'Site',
  'Partner',
  'History',
  'MetadataField',
  'PageContent',
] as const;
type ModelName = (typeof MODELS)[number];

// `list${model}s` is right for every model except History, whose Amplify
// (and this schema's) query field is the properly pluralized `listHistories`.
const LIST_QUERY_FIELD: Record<ModelName, string> = {
  Archive: 'listArchives',
  Collection: 'listCollections',
  Site: 'listSites',
  Partner: 'listPartners',
  History: 'listHistories',
  MetadataField: 'listMetadataFields',
  PageContent: 'listPageContents',
};

// GSIs each model's DynamoDB data source role needs `dynamodb:Query` on.
// Table.fromTableAttributes() only grants access to these index ARNs when
// they're listed here (see `globalIndexes` below) — without it, grantReadData()
// only covers the base table, and Query calls against a GSI are denied.
const GLOBAL_INDEXES: Record<ModelName, string[]> = {
  Archive: ['Identifier', 'gsi-Collection.archives'],
  Collection: ['Identifier'],
  Site: ['SiteId'],
  Partner: ['Identifier'],
  History: [],
  MetadataField: [],
  PageContent: [],
};

export class AppSyncStack extends Stack {
  constructor(scope: Construct, id: string, props: AppSyncStackProps) {
    super(scope, id, props);

    const api = new appsync.GraphqlApi(this, 'VtdlpApi', {
      name: 'dlp-access-next-vtdlp',
      definition: appsync.Definition.fromFile(path.join(__dirname, '..', 'schema', 'schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.IAM,
        },
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ERROR,
      },
      xrayEnabled: true,
    });

    // Import the existing Amplify-provisioned DynamoDB tables rather than
    // creating new ones, so this API reads the same data as the vtdlp app.
    const tables: Record<ModelName, dynamodb.ITable> = MODELS.reduce(
      (acc, model) => {
        acc[model] = dynamodb.Table.fromTableAttributes(this, `${model}Table`, {
          tableName: `${model}-${props.tableSuffix}`,
          globalIndexes: GLOBAL_INDEXES[model],
        });
        return acc;
      },
      {} as Record<ModelName, dynamodb.ITable>,
    );

    const dataSources: Record<ModelName, appsync.DynamoDbDataSource> = MODELS.reduce(
      (acc, model) => {
        acc[model] = api.addDynamoDbDataSource(`${model}DataSource`, tables[model]);
        return acc;
      },
      {} as Record<ModelName, appsync.DynamoDbDataSource>,
    );

    const jsResolver = (
      typeName: string,
      fieldName: string,
      dataSource: appsync.BaseDataSource,
      code: string,
    ) =>
      new appsync.Resolver(this, `${typeName}${fieldName}Resolver`, {
        api,
        typeName,
        fieldName,
        dataSource,
        runtime: appsync.FunctionRuntime.JS_1_0_0,
        code: appsync.Code.fromInline(code),
      });

    // --- Query: getX / listX --------------------------------------------
    for (const model of MODELS) {
      jsResolver('Query', `get${model}`, dataSources[model], getByIdCode());
      jsResolver('Query', LIST_QUERY_FIELD[model], dataSources[model], listScanCode());
    }

    // --- Query: indexed lookups (xByY) ------------------------------------
    jsResolver(
      'Query',
      'archiveByIdentifier',
      dataSources.Archive,
      queryByIndexCode({ indexName: 'Identifier', keyField: 'identifier', argName: 'identifier' }),
    );
    jsResolver(
      'Query',
      'collectionByIdentifier',
      dataSources.Collection,
      queryByIndexCode({ indexName: 'Identifier', keyField: 'identifier', argName: 'identifier' }),
    );
    jsResolver(
      'Query',
      'siteBySiteId',
      dataSources.Site,
      queryByIndexCode({ indexName: 'SiteId', keyField: 'siteId', argName: 'siteId' }),
    );
    jsResolver(
      'Query',
      'partnerByIdentifier',
      dataSources.Partner,
      queryByIndexCode({ indexName: 'Identifier', keyField: 'identifier', argName: 'identifier' }),
    );

    // --- Relation fields ---------------------------------------------------
    jsResolver('Archive', 'collection', dataSources.Collection, hasOneCode('archiveCollectionId'));
    jsResolver('Archive', 'partner', dataSources.Partner, hasOneCode('archivePartnerId'));
    jsResolver(
      'Collection',
      'archives',
      dataSources.Archive,
      hasManyCode({ indexName: 'gsi-Collection.archives', foreignKeyField: 'collectionArchivesId' }),
    );
    jsResolver('Collection', 'partner', dataSources.Partner, hasOneCode('collectionPartnerId'));
    jsResolver(
      'PageContent',
      'pageContentSiteId',
      dataSources.Site,
      hasOneCode('pageContentPageContentSiteIdId'),
    );

    // --- Full-text search (existing OpenSearch domain) --------------------
    // The domain's own access policy (or fine-grained access control role
    // mapping) must also allow this data source's service role to call
    // es:ESHttpGet on the archive/collection indices.
    const searchDomain = opensearch.Domain.fromDomainEndpoint(
      this,
      'SearchDomain',
      props.openSearchDomainEndpoint.startsWith('https://')
        ? props.openSearchDomainEndpoint
        : `https://${props.openSearchDomainEndpoint}`,
    );
    const searchDataSource = api.addOpenSearchDataSource('OpenSearchDataSource', searchDomain);

    jsResolver(
      'Query',
      'fulltextArchives',
      searchDataSource,
      openSearchQueryCode({
        index: 'archive',
        searchFields: [
          'title', 'description', 'creator', 'medium', 'type', 'tags', 'identifier', 'is_part_of',
          'format', 'spatial', 'source', 'subject', 'bibliographic_citation', 'rights', 'rights_holder',
        ],
      }),
    );
    jsResolver(
      'Query',
      'fulltextCollections',
      searchDataSource,
      openSearchQueryCode({
        index: 'collection',
        searchFields: [
          'title', 'description', 'creator', 'identifier', 'spatial', 'subject', 'source', 'is_part_of',
          'bibliographic_citation', 'rights', 'rights_holder',
        ],
      }),
    );

    // Searches both indices at once; hits are tagged with __typename so they
    // resolve to Archive or Collection through the CatalogItem interface.
    jsResolver(
      'Query',
      'searchObjects',
      searchDataSource,
      openSearchQueryCode({
        index: 'archive,collection',
        resolveTypename: true,
        searchFields: [
          'title', 'description', 'creator', 'medium', 'type', 'tags', 'identifier', 'is_part_of',
          'format', 'spatial', 'subject', 'source', 'bibliographic_citation', 'rights', 'rights_holder',
        ],
      }),
    );

    // --- IAM auth for the Elastic Beanstalk app -----------------------------
    const ebRole = iam.Role.fromRoleName(this, 'EbInstanceRole', props.ebInstanceRoleName);
    api.grant(ebRole, appsync.IamResource.all(), 'appsync:GraphQL');

    new CfnOutput(this, 'GraphQLApiId', { value: api.apiId });
    new CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new CfnOutput(this, 'GraphQLApiArn', { value: api.arn });
  }
}
