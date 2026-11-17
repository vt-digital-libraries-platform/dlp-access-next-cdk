import * as path from "path";
import {
  ArnFormat,
  CfnOutput,
  Duration,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  DynamoEventSource,
  SqsDlq,
} from "aws-cdk-lib/aws-lambda-event-sources";
import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import {
  EnvironmentConfig,
  ebInstanceProfileName,
  ebServiceRoleArnParameterName,
  ebServiceRoleName,
  graphqlApiUrlParameterName,
  resyncFunctionName,
} from "../config/environments";
import {
  LIST_QUERY_FIELD,
  MODELS,
  ModelName,
  SEARCHABLE_MODELS,
  tableName,
} from "../config/models";
import { FRONTEND_SECRET_PREFIX } from "../config/web";
import {
  getByIdCode,
  listScanCode,
  queryByIndexCode,
  hasOneCode,
  hasManyCode,
  openSearchQueryCode,
} from "../appsync/resolvers";
import { numericSortFields } from "../appsync/search-mappings";
import { LAMBDA_DIR, SCHEMA_FILE } from "../paths";

/** The fields an `allFields` search matches, per index; searchObjects uses both. */
const ARCHIVE_SEARCH_FIELDS = [
  "title",
  "description",
  "creator",
  "medium",
  "type",
  "tags",
  "identifier",
  "is_part_of",
  "format",
  "spatial",
  "source",
  "subject",
  "bibliographic_citation",
  "rights",
  "rights_holder",
];
const COLLECTION_SEARCH_FIELDS = [
  "title",
  "description",
  "creator",
  "identifier",
  "spatial",
  "subject",
  "source",
  "is_part_of",
  "bibliographic_citation",
  "rights",
  "rights_holder",
];

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

    const api = new appsync.GraphqlApi(this, "VtdlpApi", {
      name: `dlp-access-next-${config.name}`,
      definition: appsync.Definition.fromFile(SCHEMA_FILE),
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

    const dataSources: Record<ModelName, appsync.DynamoDbDataSource> =
      MODELS.reduce(
        (acc, model) => {
          acc[model] = api.addDynamoDbDataSource(
            `${model}DataSource`,
            tables[model],
          );
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
      jsResolver("Query", `get${model}`, dataSources[model], getByIdCode());
      jsResolver(
        "Query",
        LIST_QUERY_FIELD[model],
        dataSources[model],
        listScanCode(),
      );
    }

    // --- Query: indexed lookups (xByY) ------------------------------------
    jsResolver(
      "Query",
      "archiveByIdentifier",
      dataSources.Archive,
      queryByIndexCode({
        indexName: "Identifier",
        keyField: "identifier",
        argName: "identifier",
      }),
    );
    jsResolver(
      "Query",
      "collectionByIdentifier",
      dataSources.Collection,
      queryByIndexCode({
        indexName: "Identifier",
        keyField: "identifier",
        argName: "identifier",
      }),
    );
    jsResolver(
      "Query",
      "siteBySiteId",
      dataSources.Site,
      queryByIndexCode({
        indexName: "SiteId",
        keyField: "siteId",
        argName: "siteId",
      }),
    );
    jsResolver(
      "Query",
      "partnerByIdentifier",
      dataSources.Partner,
      queryByIndexCode({
        indexName: "Identifier",
        keyField: "identifier",
        argName: "identifier",
      }),
    );

    // --- Relation fields ---------------------------------------------------
    jsResolver(
      "Archive",
      "collection",
      dataSources.Collection,
      hasOneCode("archiveCollectionId"),
    );
    jsResolver(
      "Archive",
      "partner",
      dataSources.Partner,
      hasOneCode("archivePartnerId"),
    );
    jsResolver(
      "Collection",
      "archives",
      dataSources.Archive,
      hasManyCode({
        indexName: "gsi-Collection.archives",
        foreignKeyField: "collectionArchivesId",
      }),
    );
    jsResolver(
      "Collection",
      "partner",
      dataSources.Partner,
      hasOneCode("collectionPartnerId"),
    );
    jsResolver(
      "PageContent",
      "pageContentSiteId",
      dataSources.Site,
      hasOneCode("pageContentPageContentSiteIdId"),
    );

    // --- Full-text search ------------------------------------------------
    const searchDataSource = api.addOpenSearchDataSource(
      "OpenSearchDataSource",
      searchDomain,
    );

    jsResolver(
      "Query",
      "fulltextArchives",
      searchDataSource,
      openSearchQueryCode({
        index: "archive",
        numericSortFields: numericSortFields(["archive"]),
        searchFields: ARCHIVE_SEARCH_FIELDS,
      }),
    );
    jsResolver(
      "Query",
      "fulltextCollections",
      searchDataSource,
      openSearchQueryCode({
        index: "collection",
        numericSortFields: numericSortFields(["collection"]),
        searchFields: COLLECTION_SEARCH_FIELDS,
      }),
    );

    // Searches both indices at once; hits are tagged with __typename so they
    // resolve to Archive or Collection through the CatalogItem interface.
    jsResolver(
      "Query",
      "searchObjects",
      searchDataSource,
      openSearchQueryCode({
        index: "archive,collection",
        numericSortFields: numericSortFields(["archive", "collection"]),
        resolveTypename: true,
        searchFields: [
          ...new Set([...ARCHIVE_SEARCH_FIELDS, ...COLLECTION_SEARCH_FIELDS]),
        ],
      }),
    );

    // --- OpenSearch streaming ----------------------------------------------
    // Amplify's streaming function, moved to a supported runtime. It indexes
    // each Archive/Collection change into the index named after the table.
    const streamingFailures = new sqs.Queue(
      this,
      "OpenSearchStreamingFailures",
      {
        retentionPeriod: Duration.days(14),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
      },
    );

    // A batch lands on the failure queue only after its retries and
    // bisection are exhausted, so any message there needs someone to act.
    // The alarm stays in ALARM until the queue is drained or purged.
    const alertTopic = new sns.Topic(this, "StreamingAlertTopic");
    for (const address of config.alertEmails) {
      alertTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(address),
      );
    }
    const failureAlarm = new cloudwatch.Alarm(
      this,
      "OpenSearchStreamingFailureAlarm",
      {
        alarmDescription:
          "OpenSearch streaming gave up on a batch; see docs/opensearch-streaming.md",
        metric: streamingFailures.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
          statistic: cloudwatch.Stats.MAXIMUM,
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    failureAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    failureAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));

    const streamingCode = lambda.Code.fromAsset(
      path.join(LAMBDA_DIR, "opensearch-streaming"),
      { exclude: ["tests", "__pycache__", ".pytest_cache"] },
    );
    const streamingEnvironment = {
      OPENSEARCH_ENDPOINT: `https://${searchDomain.domainEndpoint}`,
      OPENSEARCH_REGION: this.region,
      DEBUG: "0",
      OPENSEARCH_USE_EXTERNAL_VERSIONING: "false",
    };
    const streamingFn = new lambda.Function(
      this,
      "OpenSearchStreamingFunction",
      {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "python_streaming_function.lambda_handler",
        code: streamingCode,
        timeout: Duration.seconds(30),
        memorySize: 128,
        environment: streamingEnvironment,
      },
    );
    searchDomain.grantPathReadWrite("_bulk", streamingFn);
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

    // Recovery for batches the stream gave up on: re-reads items from the
    // tables and runs them through the streaming handler, so they are indexed
    // exactly as the stream indexes them. See docs/opensearch-streaming.md.
    const resyncFn = new lambda.Function(this, "OpenSearchResyncFunction", {
      functionName: resyncFunctionName(config.name),
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "resync.lambda_handler",
      code: streamingCode,
      timeout: Duration.minutes(15),
      memorySize: 256,
      environment: {
        ...streamingEnvironment,
        RESYNC_TABLES: JSON.stringify(
          Object.fromEntries(
            SEARCHABLE_MODELS.map((model) => [
              model,
              tableName(model, config.name),
            ]),
          ),
        ),
      },
    });
    searchDomain.grantPathReadWrite("_bulk", resyncFn);
    for (const model of SEARCHABLE_MODELS) {
      searchDomain.grantIndexReadWrite(model.toLowerCase(), resyncFn);
      tables[model].grant(resyncFn, "dynamodb:BatchGetItem", "dynamodb:Scan");
    }

    // --- IAM auth for the Elastic Beanstalk app -----------------------------
    // One instance role per environment, shared by every branch deployment
    // of the Next.js app in that environment. Carries the same managed
    // policies as the default aws-elasticbeanstalk-ec2-role, plus ECR read
    // for the Docker platform.
    const ebRoleName = ebInstanceProfileName(config.name);
    const ebRole = new iam.Role(this, "EbInstanceRole", {
      roleName: ebRoleName,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        "AWSElasticBeanstalkWebTier",
        "AWSElasticBeanstalkMulticontainerDocker",
        "AWSElasticBeanstalkWorkerTier",
        "AmazonEC2ContainerRegistryReadOnly",
      ].map((name) => iam.ManagedPolicy.fromAwsManagedPolicyName(name)),
    });
    const ebInstanceProfile = new iam.InstanceProfile(
      this,
      "EbInstanceProfile",
      {
        instanceProfileName: ebRoleName,
        role: ebRole,
      },
    );
    api.grant(ebRole, appsync.IamResource.all(), "appsync:GraphQL");

    // Frontends keep their Cognito client secret at dlpnext/<slug>/…, created
    // by the frontend tooling. Every frontend on this environment shares the
    // instance role, so any of them may read any other's secret; accepted.
    ebRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          this.formatArn({
            service: "secretsmanager",
            resource: "secret",
            resourceName: `${FRONTEND_SECRET_PREFIX}*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // One Beanstalk service role per environment, shared by every frontend
    // on it, so the frontend tooling never creates IAM. Same policies as the
    // default aws-elasticbeanstalk-service-role; the enhanced-health policy
    // lives under the service-role/ path.
    const ebServiceRole = new iam.Role(this, "EbServiceRole", {
      roleName: ebServiceRoleName(config.name),
      assumedBy: new iam.ServicePrincipal("elasticbeanstalk.amazonaws.com"),
      managedPolicies: [
        "service-role/AWSElasticBeanstalkEnhancedHealth",
        "AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy",
      ].map((name) => iam.ManagedPolicy.fromAwsManagedPolicyName(name)),
    });
    new ssm.StringParameter(this, "EbServiceRoleArnParameter", {
      parameterName: ebServiceRoleArnParameterName(config.name),
      stringValue: ebServiceRole.roleArn,
    });

    // Web stacks read the URL from here, so they can attach to an
    // environment without a cross-stack reference to this stack.
    new ssm.StringParameter(this, "GraphQLApiUrlParameter", {
      parameterName: graphqlApiUrlParameterName(config.name),
      stringValue: api.graphqlUrl,
    });

    new CfnOutput(this, "GraphQLApiId", { value: api.apiId });
    new CfnOutput(this, "GraphQLApiUrl", { value: api.graphqlUrl });
    new CfnOutput(this, "GraphQLApiArn", { value: api.arn });
    new CfnOutput(this, "EbInstanceProfileName", {
      value: ebInstanceProfile.instanceProfileName,
    });
    new CfnOutput(this, "EbServiceRoleArn", {
      value: ebServiceRole.roleArn,
    });
    new CfnOutput(this, "OpenSearchStreamingFailureQueueUrl", {
      value: streamingFailures.queueUrl,
    });
    new CfnOutput(this, "OpenSearchResyncFunctionName", {
      value: resyncFn.functionName,
    });
    new CfnOutput(this, "StreamingAlertTopicArn", {
      value: alertTopic.topicArn,
    });
  }
}
