import * as path from 'path';
import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './environments';
import { GLOBAL_INDEXES, MODELS, ModelName, SEARCHABLE_MODELS, tableName } from './models';

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * The stateful half of an environment: the DynamoDB tables and the
 * OpenSearch domain. Kept apart from the API so the API can be redeployed
 * or torn down without putting data at risk.
 */
export class DataStack extends Stack {
  readonly tables: Record<ModelName, dynamodb.ITable>;
  readonly searchDomain: opensearch.IDomain;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    const retain = config.removalPolicy === RemovalPolicy.RETAIN;

    // Same shape as the vtdlpdev Amplify tables: hash key `id`, GSIs
    // projecting ALL, NEW_AND_OLD_IMAGES streams, on-demand billing.
    this.tables = MODELS.reduce(
      (acc, model) => {
        const table = new dynamodb.Table(this, `${model}Table`, {
          tableName: tableName(model, config.name),
          partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
          encryption: dynamodb.TableEncryption.DEFAULT,
          deletionProtection: retain,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: retain },
          removalPolicy: config.removalPolicy,
        });
        for (const index of GLOBAL_INDEXES[model]) {
          table.addGlobalSecondaryIndex({
            indexName: index.indexName,
            partitionKey: { name: index.partitionKey, type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
          });
        }
        acc[model] = table;
        return acc;
      },
      {} as Record<ModelName, dynamodb.ITable>,
    );

    // No access policy: access is granted through IAM identity policies on
    // the roles that need it, as on the Amplify domains.
    const domain = new opensearch.Domain(this, 'SearchDomain', {
      domainName: `dlpnext-${config.name}`,
      version: opensearch.EngineVersion.OPENSEARCH_2_19,
      capacity: {
        dataNodes: config.search.dataNodes,
        dataNodeInstanceType: config.search.instanceType,
        multiAzWithStandbyEnabled: false,
      },
      zoneAwareness:
        config.search.availabilityZones > 1
          ? { enabled: true, availabilityZoneCount: config.search.availabilityZones }
          : { enabled: false },
      ebs: {
        volumeSize: config.search.volumeSizeGiB,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      encryptionAtRest: { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      tlsSecurityPolicy: opensearch.TLSSecurityPolicy.TLS_1_2,
      removalPolicy: config.removalPolicy,
    });
    this.searchDomain = domain;

    // Index template so the dynamically created indices get replicas that
    // fit the cluster (0 on one node, 1 on two or more).
    const indexTemplateFn = new lambda.Function(this, 'IndexTemplateFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.on_event',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'opensearch-index-template')),
      timeout: Duration.minutes(1),
      environment: {
        OPENSEARCH_ENDPOINT: domain.domainEndpoint,
        OPENSEARCH_REGION: this.region,
      },
    });
    domain.grantPathReadWrite('_index_template/*', indexTemplateFn);
    const indexTemplateProvider = new cr.Provider(this, 'IndexTemplateProvider', {
      onEventHandler: indexTemplateFn,
    });
    new CustomResource(this, 'IndexTemplate', {
      serviceToken: indexTemplateProvider.serviceToken,
      properties: {
        IndexPatterns: SEARCHABLE_MODELS.map((model) => model.toLowerCase()),
      },
    });

    for (const model of MODELS) {
      new CfnOutput(this, `${model}TableName`, { value: this.tables[model].tableName });
    }
    new CfnOutput(this, 'SearchDomainEndpoint', { value: domain.domainEndpoint });
  }
}
