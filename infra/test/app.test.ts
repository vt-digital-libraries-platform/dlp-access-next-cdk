import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/app';

function synth(envName: string) {
  const { data, api } = buildApp(new App(), envName);
  return { data: Template.fromStack(data), api: Template.fromStack(api) };
}

const dev = synth('dev');
const preProduction = synth('pre-production');
const feature = synth('f-search');

describe('environment selection', () => {
  test('stacks are named after the environment', () => {
    const { data, api } = buildApp(new App(), 'f-search');
    expect(data.stackName).toBe('DlpAccessNext-f-search-Data');
    expect(api.stackName).toBe('DlpAccessNext-f-search-Api');
  });

  test.each([
    [undefined, /Missing CDK context/],
    ['staging', /Unknown environment "staging"/],
    ['f-this-name-is-far-too-long', /Invalid environment name/],
    ['Dev', /Invalid environment name/],
    ['production', /no AWS account configured/],
  ])('rejects env %p', (envName, message) => {
    expect(() => buildApp(new App(), envName)).toThrow(message);
  });
});

describe('tables', () => {
  test('seven tables named <Model>-dlpnext-<env> with Amplify key and stream shape', () => {
    dev.data.resourceCountIs('AWS::DynamoDB::Table', 7);
    for (const model of ['Archive', 'Collection', 'Site', 'Partner', 'History', 'MetadataField', 'PageContent']) {
      dev.data.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `${model}-dlpnext-dev`,
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      });
    }
  });

  test('GSIs match the Amplify tables', () => {
    const gsi = (IndexName: string, attribute: string) => ({
      IndexName,
      KeySchema: [{ AttributeName: attribute, KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    });
    const expected: Record<string, object[]> = {
      Archive: [gsi('Identifier', 'identifier'), gsi('gsi-Collection.archives', 'collectionArchivesId')],
      Collection: [gsi('Identifier', 'identifier')],
      Site: [gsi('SiteId', 'siteId')],
      Partner: [gsi('Identifier', 'identifier')],
    };
    for (const [model, indexes] of Object.entries(expected)) {
      dev.data.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `${model}-dlpnext-dev`,
        GlobalSecondaryIndexes: Match.arrayWith(indexes.map((i) => Match.objectLike(i))),
      });
    }
    for (const model of ['History', 'MetadataField', 'PageContent']) {
      dev.data.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `${model}-dlpnext-dev`,
        GlobalSecondaryIndexes: Match.absent(),
      });
    }
  });

  test('feature tables are destroyed with the stack and unprotected', () => {
    const tables = Object.values(feature.data.findResources('AWS::DynamoDB::Table'));
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      expect(table.DeletionPolicy).toBe('Delete');
      expect(table.Properties.DeletionProtectionEnabled).toBe(false);
      expect(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(false);
    }
  });

  test('dev and pre-production tables are retained, deletion-protected and have PITR', () => {
    for (const { data } of [dev, preProduction]) {
      const tables = Object.values(data.findResources('AWS::DynamoDB::Table'));
      expect(tables).toHaveLength(7);
      for (const table of tables) {
        expect(table.DeletionPolicy).toBe('Retain');
        expect(table.Properties.DeletionProtectionEnabled).toBe(true);
        expect(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
      }
    }
  });
});

describe('search domain', () => {
  test('OpenSearch 2.19, encrypted, HTTPS with TLS 1.2, no access policy', () => {
    dev.data.hasResourceProperties('AWS::OpenSearchService::Domain', {
      DomainName: 'dlpnext-dev',
      EngineVersion: 'OpenSearch_2.19',
      EncryptionAtRestOptions: { Enabled: true },
      NodeToNodeEncryptionOptions: { Enabled: true },
      DomainEndpointOptions: { EnforceHTTPS: true, TLSSecurityPolicy: 'Policy-Min-TLS-1-2-2019-07' },
      AccessPolicies: Match.absent(),
    });
  });

  test('non-production domains are one small node', () => {
    for (const { data } of [dev, preProduction, feature]) {
      data.hasResourceProperties('AWS::OpenSearchService::Domain', {
        ClusterConfig: Match.objectLike({
          InstanceType: 't3.small.search',
          InstanceCount: 1,
          ZoneAwarenessEnabled: false,
        }),
        EBSOptions: Match.objectLike({ VolumeSize: 10, VolumeType: 'gp3' }),
      });
    }
  });

  test('removal policy follows the environment', () => {
    const policy = (t: Template) =>
      Object.values(t.findResources('AWS::OpenSearchService::Domain'))[0].DeletionPolicy;
    expect(policy(feature.data)).toBe('Delete');
    expect(policy(dev.data)).toBe('Retain');
    expect(policy(preProduction.data)).toBe('Retain');
  });

  test('index template targets the archive and collection indices', () => {
    dev.data.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      IndexPatterns: ['archive', 'collection'],
    });
  });
});

describe('streaming Lambda', () => {
  test('runs the vendored Amplify handler on python3.12 with a 30s timeout', () => {
    dev.api.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'python_streaming_function.lambda_handler',
      Runtime: 'python3.12',
      Timeout: 30,
      MemorySize: 128,
      Environment: {
        Variables: Match.objectLike({ DEBUG: '0', OPENSEARCH_USE_EXTERNAL_VERSIONING: 'false' }),
      },
    });
  });

  test('streams only Archive and Collection, with bounded retries, bisect and a failure queue', () => {
    const mappings = Object.values(dev.api.findResources('AWS::Lambda::EventSourceMapping'));
    expect(mappings).toHaveLength(2);
    const sources = JSON.stringify(mappings.map((m) => m.Properties.EventSourceArn));
    expect(sources).toMatch(/ArchiveTable/);
    expect(sources).toMatch(/CollectionTable/);
    expect(sources).not.toMatch(/PartnerTable/);
    for (const mapping of mappings) {
      expect(mapping.Properties).toMatchObject({
        StartingPosition: 'LATEST',
        BatchSize: 100,
        MaximumBatchingWindowInSeconds: 1,
        MaximumRetryAttempts: 3,
        BisectBatchOnFunctionError: true,
      });
      expect(mapping.Properties.DestinationConfig.OnFailure.Destination).toBeDefined();
    }
  });
});

describe('API and Elastic Beanstalk access', () => {
  test('API is named after the environment and uses IAM auth', () => {
    dev.api.hasResourceProperties('AWS::AppSync::GraphQLApi', {
      Name: 'dlp-access-next-dev',
      AuthenticationType: 'AWS_IAM',
    });
  });

  test('per-environment EB instance role and profile may call the API', () => {
    dev.api.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'dlp-access-next-dev-eb',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: 'ec2.amazonaws.com' } })],
      }),
    });
    dev.api.hasResourceProperties('AWS::IAM::InstanceProfile', {
      InstanceProfileName: 'dlp-access-next-dev-eb',
    });
    const ebRoleId = Object.entries(dev.api.findResources('AWS::IAM::Role')).find(
      ([, r]) => r.Properties.RoleName === 'dlp-access-next-dev-eb',
    )![0];
    dev.api.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: ebRoleId }],
      PolicyDocument: {
        Statement: [Match.objectLike({ Action: 'appsync:GraphQL' })],
      },
    });
  });

  test('stack outputs what the Beanstalk config needs', () => {
    dev.api.hasOutput('GraphQLApiUrl', {});
    dev.api.hasOutput('EbInstanceProfileName', {});
  });
});
