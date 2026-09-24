import * as path from 'path';
import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './environments';
import { LIST_QUERY_FIELD, MODELS, ModelName, SEARCHABLE_MODELS } from './models';
import {
  getByIdCode,
  listScanCode,
  queryByIndexCode,
  hasOneCode,
  hasManyCode,
  openSearchQueryCode,
} from './resolvers';

export interface ApiStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** The environment's tables, from its Data stack. */
  readonly tables: Record<ModelName, dynamodb.ITable>;
  /** The environment's OpenSearch domain, from its Data stack. */
  readonly searchDomain: opensearch.IDomain;
}

/**
 * The stateless half of an environment: the AppSync API over the Data
 * stack's tables and domain, the Lambda that streams Archive and Collection
 * changes into OpenSearch, and the Elastic Beanstalk instance role that is
 * allowed to call the API.
 */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, tables, searchDomain } = props;

    const api = new appsync.GraphqlApi(this, 'VtdlpApi', {
      name: `dlp-access-next-${config.name}`,
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

    // --- Full-text search ------------------------------------------------
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

    // --- OpenSearch streaming ----------------------------------------------
    // Amplify's streaming function, moved to a supported runtime. It indexes
    // each Archive/Collection change into the index named after the table.
    const streamingFailures = new sqs.Queue(this, 'OpenSearchStreamingFailures', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const streamingFn = new lambda.Function(this, 'OpenSearchStreamingFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'python_streaming_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'opensearch-streaming'), {
        exclude: ['tests', '__pycache__', '.pytest_cache'],
      }),
      timeout: Duration.seconds(30),
      memorySize: 128,
      environment: {
        OPENSEARCH_ENDPOINT: `https://${searchDomain.domainEndpoint}`,
        OPENSEARCH_REGION: this.region,
        DEBUG: '0',
        OPENSEARCH_USE_EXTERNAL_VERSIONING: 'false',
      },
    });
    searchDomain.grantPathReadWrite('_bulk', streamingFn);
    for (const model of SEARCHABLE_MODELS) {
      searchDomain.grantIndexReadWrite(model.toLowerCase(), streamingFn);
      streamingFn.addEventSource(
        new DynamoEventSource(tables[model], {
          startingPosition: lambda.StartingPosition.LATEST,
          batchSize: 100,
          maxBatchingWindow: Duration.seconds(1),
          retryAttempts: 3,
          bisectBatchOnError: true,
          onFailure: new SqsDlq(streamingFailures),
        }),
      );
    }

    // --- IAM auth for the Elastic Beanstalk app -----------------------------
    // One instance role per environment, shared by every branch deployment
    // of the Next.js app in that environment. Carries the same managed
    // policies as the default aws-elasticbeanstalk-ec2-role, plus ECR read
    // for the Docker platform.
    const ebRoleName = `dlp-access-next-${config.name}-eb`;
    const ebRole = new iam.Role(this, 'EbInstanceRole', {
      roleName: ebRoleName,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        'AWSElasticBeanstalkWebTier',
        'AWSElasticBeanstalkMulticontainerDocker',
        'AWSElasticBeanstalkWorkerTier',
        'AmazonEC2ContainerRegistryReadOnly',
      ].map((name) => iam.ManagedPolicy.fromAwsManagedPolicyName(name)),
    });
    const ebInstanceProfile = new iam.InstanceProfile(this, 'EbInstanceProfile', {
      instanceProfileName: ebRoleName,
      role: ebRole,
    });
    api.grant(ebRole, appsync.IamResource.all(), 'appsync:GraphQL');

    new CfnOutput(this, 'GraphQLApiId', { value: api.apiId });
    new CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new CfnOutput(this, 'GraphQLApiArn', { value: api.arn });
    new CfnOutput(this, 'EbInstanceProfileName', { value: ebInstanceProfile.instanceProfileName });
    new CfnOutput(this, 'OpenSearchStreamingFailureQueueUrl', { value: streamingFailures.queueUrl });
  }
}
