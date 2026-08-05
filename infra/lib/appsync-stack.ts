import * as path from 'path';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  getByIdCode,
  listScanCode,
  queryByIndexCode,
  hasOneCode,
  hasManyCode,
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
}

const MODELS = ['Archive', 'Collection', 'Site'] as const;
type ModelName = (typeof MODELS)[number];

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
        acc[model] = dynamodb.Table.fromTableName(this, `${model}Table`, `${model}-${props.tableSuffix}`);
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
      dataSource: appsync.DynamoDbDataSource,
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
      jsResolver('Query', `list${model}s`, dataSources[model], listScanCode());
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

    // --- Relation fields ---------------------------------------------------
    jsResolver('Archive', 'collection', dataSources.Collection, hasOneCode('archiveCollectionId'));
    jsResolver(
      'Collection',
      'archives',
      dataSources.Archive,
      hasManyCode({ indexName: 'gsi-Collection.archives', foreignKeyField: 'collectionArchivesId' }),
    );

    // --- IAM auth for the Elastic Beanstalk app -----------------------------
    const ebRole = iam.Role.fromRoleName(this, 'EbInstanceRole', props.ebInstanceRoleName);
    api.grant(ebRole, appsync.IamResource.all(), 'appsync:GraphQL');

    new CfnOutput(this, 'GraphQLApiId', { value: api.apiId });
    new CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new CfnOutput(this, 'GraphQLApiArn', { value: api.arn });
  }
}
