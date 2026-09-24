import * as fs from 'fs';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/app';

const account = '123456789012';

function synth(envName: string) {
  const { data, api } = buildApp(new App(), { env: envName, account });
  return { data: Template.fromStack(data!), api: Template.fromStack(api!) };
}

const stackNames = (app: App) =>
  app.node.children.filter((c): c is Stack => c instanceof Stack).map((s) => s.stackName);

const dev = synth('dev');
const preProduction = synth('pre-production');
const feature = synth('f-search');

describe('environment selection', () => {
  test('stacks are named after the environment', () => {
    const { data, api, web } = buildApp(new App(), { env: 'f-search', account });
    expect(web).toBeUndefined();
    expect(data!.stackName).toBe('DlpAccessNext-f-search-Data');
    expect(api!.stackName).toBe('DlpAccessNext-f-search-Api');
  });

  test.each([
    [undefined, /Missing CDK context/],
    ['staging', /Unknown environment "staging"/],
    ['f-this-name-is-far-too-long', /Invalid environment name/],
    ['Dev', /Invalid environment name/],
  ])('rejects env %p', (envName, message) => {
    expect(() => buildApp(new App(), { env: envName, account })).toThrow(message);
  });

  test('production uses the account passed in', () => {
    const { data } = buildApp(new App(), { env: 'production', account });
    expect(data!.account).toBe(account);
  });

  test.each([
    [undefined, /Missing CDK context: pass -c account/],
    ['12345', /Invalid account "12345"/],
    ['12345678901x', /Invalid account/],
  ])('rejects account %p', (badAccount, message) => {
    expect(() => buildApp(new App(), { env: 'dev', account: badAccount })).toThrow(message);
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

  test('publishes the API URL to SSM for Web stacks', () => {
    const apiId = Object.keys(dev.api.findResources('AWS::AppSync::GraphQLApi'))[0];
    dev.api.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/dlp-access-next/dev/graphql-api-url',
      Value: { 'Fn::GetAtt': [apiId, 'GraphQLUrl'] },
    });
  });

  test('stack outputs what the Beanstalk config needs', () => {
    dev.api.hasOutput('GraphQLApiUrl', {});
    dev.api.hasOutput('EbInstanceProfileName', {});
  });
});

describe('Web stack', () => {
  test('attach deploys only the Web stack, named after the slugified branch', () => {
    const app = new App();
    const { data, api, web } = buildApp(app, { env: 'dev', account, branch: 'whunter/Multi_Env' });
    expect(data).toBeUndefined();
    expect(api).toBeUndefined();
    expect(stackNames(app)).toEqual(['DlpAccessNext-Web-whunter-multi-env']);
    expect(web!.dependencies).toHaveLength(0);
  });

  test('provision deploys Data and Api first', () => {
    const app = new App();
    const { api, web } = buildApp(app, { env: 'f-search', account, branch: 'search', backend: 'provision' });
    expect(stackNames(app).sort()).toEqual([
      'DlpAccessNext-Web-search',
      'DlpAccessNext-f-search-Api',
      'DlpAccessNext-f-search-Data',
    ]);
    expect(web!.dependencies).toContain(api);
  });

  test.each([
    [{ env: 'dev', backend: 'attach' }, /only applies with -c branch/],
    [{ env: 'dev', branch: 'x', backend: 'create' }, /Invalid backend "create"/],
    [{ env: 'dev', branch: '///' }, /Invalid branch/],
    [{ env: 'dev', branch: 'a'.repeat(33) }, /Invalid branch/],
  ])('rejects %p', (options, message) => {
    expect(() => buildApp(new App(), { account, ...options })).toThrow(message);
  });

  const attached = buildApp(new App(), { env: 'pre-production', account, branch: 'feature/search' }).web!;
  const web = Template.fromStack(attached);
  const option = (namespace: string, optionName: string, value: unknown) =>
    Match.objectLike({ Namespace: namespace, OptionName: optionName, Value: value });

  test('Node.js single-instance environment named after the branch', () => {
    web.hasResourceProperties('AWS::ElasticBeanstalk::Application', { ApplicationName: 'dlpnext-feature-search' });
    web.hasResourceProperties('AWS::ElasticBeanstalk::Environment', {
      ApplicationName: 'dlpnext-feature-search',
      EnvironmentName: 'dlpnext-feature-search',
      SolutionStackName: Match.stringLikeRegexp('Amazon Linux 2023 .* running Node.js 24'),
      OptionSettings: Match.arrayWith([
        option('aws:elasticbeanstalk:environment', 'EnvironmentType', 'SingleInstance'),
        option('aws:autoscaling:launchconfiguration', 'DisableIMDSv1', 'true'),
        option('aws:ec2:instances', 'InstanceTypes', 't3.small'),
      ]),
    });
  });

  test('uses the environment instance profile and the API URL from SSM, not cross-stack exports', () => {
    web.hasResourceProperties('AWS::ElasticBeanstalk::Environment', {
      OptionSettings: Match.arrayWith([
        option('aws:autoscaling:launchconfiguration', 'IamInstanceProfile', 'dlp-access-next-pre-production-eb'),
        option('aws:elasticbeanstalk:application:environment', 'APPSYNC_API_URL', { Ref: Match.anyValue() }),
      ]),
    });
    web.hasParameter('*', {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/dlp-access-next/pre-production/graphql-api-url',
    });
    expect(JSON.stringify(web.toJSON())).not.toMatch(/Fn::ImportValue/);
  });

  test('service role carries the default Beanstalk service role policies, at their real ARNs', () => {
    const arns = JSON.stringify(Object.values(web.findResources('AWS::IAM::Role')).map((r) => r.Properties.ManagedPolicyArns));
    expect(arns).toContain(':iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth');
    expect(arns).toContain(':iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy');
  });

  test('source bundle is the app source without dependencies, infra or build output', () => {
    const staged = path.join((attached.node.root as App).outdir, attached.sourceBundle.assetPath);
    const entries = fs.readdirSync(staged);
    expect(entries).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'src', '.platform']));
    for (const excluded of ['node_modules', '.next', '.git', 'infra', '.elasticbeanstalk', 'CLAUDE.md']) {
      expect(entries).not.toContain(excluded);
    }
    expect(entries.filter((e) => e.startsWith('.env'))).toEqual([]);
    const hook = fs.statSync(path.join(staged, '.platform', 'hooks', 'prebuild', '01_build.sh'));
    expect(hook.mode & 0o111).not.toBe(0);
  });
});
