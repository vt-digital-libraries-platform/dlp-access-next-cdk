import * as fs from 'fs';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { booleanContext, buildApp } from '../lib/app';
import { buildSearchMappings, numericSortFields, searchMappings } from '../lib/search-mappings';
import { CALLBACK_PATH } from '../lib/web-stack';

const account = '123456789012';
const userPool = 'us-east-1_AbCd12345';
const certificate = `arn:aws:acm:us-east-1:${account}:certificate/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7`;

function synth(envName: string) {
  const { data, api } = buildApp(new App(), { env: envName, account, userPool });
  return { data: Template.fromStack(data!), api: Template.fromStack(api!) };
}

const stackNames = (app: App) =>
  app.node.children.filter((c): c is Stack => c instanceof Stack).map((s) => s.stackName);

const dev = synth('dev');
const preProduction = synth('pre-production');
const feature = synth('f-search');

describe('environment selection', () => {
  test('stacks are named after the environment', () => {
    const { data, api, auth, web } = buildApp(new App(), { env: 'f-search', account, userPool });
    expect(web).toBeUndefined();
    expect(data!.stackName).toBe('DlpAccessNext-f-search-Data');
    expect(api!.stackName).toBe('DlpAccessNext-f-search-Api');
    expect(auth!.stackName).toBe('DlpAccessNext-f-search-Auth');
  });

  test.each([
    [undefined, /Missing CDK context/],
    ['staging', /Unknown environment "staging"/],
    ['f-this-name-is-far-too-long', /Invalid environment name/],
    ['Dev', /Invalid environment name/],
  ])('rejects env %p', (envName, message) => {
    expect(() => buildApp(new App(), { env: envName, account })).toThrow(message);
  });

  test.each([
    [undefined, undefined],
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
  ])('reads boolean context %p as %p', (value, expected) => {
    expect(booleanContext('production', value)).toBe(expected);
  });

  test.each(['yes', '1', 1])('rejects boolean context %p', (value) => {
    expect(() => booleanContext('production', value)).toThrow(/Invalid production/);
  });

  test('production uses the account passed in', () => {
    const { data } = buildApp(new App(), { env: 'production', account, userPool });
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

  test('without the production flag, domains are one small node', () => {
    const production = synth('production');
    for (const { data } of [dev, preProduction, feature, production]) {
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

  test('the production flag makes the domain three nodes across three AZs', () => {
    const { data } = buildApp(new App(), { env: 'production', account, userPool, production: true });
    Template.fromStack(data!).hasResourceProperties('AWS::OpenSearchService::Domain', {
      ClusterConfig: Match.objectLike({
        InstanceType: 'm7g.medium.search',
        InstanceCount: 3,
        ZoneAwarenessEnabled: true,
        ZoneAwarenessConfig: { AvailabilityZoneCount: 3 },
      }),
    });
  });

  test('the domain is destroyed with the stack in every environment', () => {
    const policy = (t: Template) =>
      Object.values(t.findResources('AWS::OpenSearchService::Domain'))[0].DeletionPolicy;
    expect(policy(feature.data)).toBe('Delete');
    expect(policy(dev.data)).toBe('Delete');
    expect(policy(preProduction.data)).toBe('Delete');
  });

  test.each(['archive', 'collection'])('the %s index template sets the generated mappings', (index) => {
    dev.data.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      TemplateName: `dlpnext-${index}`,
      IndexPatterns: [index],
      Mappings: JSON.stringify(searchMappings(index)),
    });
  });
});

describe('search mappings', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema', 'schema.graphql'), 'utf8');
  const stored = (type: string) => {
    const body = schema.match(new RegExp(`^type ${type} [^{]*\\{([^}]*)\\}`, 'm'))![1];
    return [...body.matchAll(/^\s+(\w+): /gm)].map((m) => m[1]);
  };
  const date = {
    type: 'date',
    format:
      'yyyy/MM/dd HH:mm:ss||yyyy/MM/dd||yyyy/MM||yyyy-MM-dd HH:mm:ss||yyyy-MM-dd||yyyy-MM||yyyy||M/d/yyyy||' +
      'strict_date_optional_time',
    ignore_malformed: true,
  };

  test.each([
    ['archive', 'Archive', ['collection', 'partner']],
    ['collection', 'Collection', ['partner']],
  ])('the %s mappings cover every stored field of %s', (index, type, relationships) => {
    const mapping = searchMappings(index);
    expect(mapping.dynamic).toBe(false);
    expect(Object.keys(mapping.properties)).toEqual([
      ...stored(type).filter((f) => !relationships.includes(f)),
      'date_range',
    ]);
  });

  test('field types follow the schema types', () => {
    const { properties } = searchMappings('archive');
    expect(properties.title).toEqual({
      type: 'text',
      fields: { keyword: { type: 'keyword', ignore_above: 256 } },
    });
    expect(properties.display_date).toEqual(properties.title);
    expect(properties.visibility).toEqual({ type: 'boolean' });
    expect(properties.subject).toEqual(properties.title);
  });

  test.each([
    ['archive', ['archived', 'explicit', 'visibility']],
    ['collection', ['archived', 'explicit_content', 'visibility']],
  ])('the Boolean fields of %s are booleans', (index, fields) => {
    const booleans = Object.entries(searchMappings(index).properties)
      .filter(([, mapping]) => mapping.type === 'boolean')
      .map(([field]) => field);
    expect(booleans).toEqual(fields);
    for (const field of fields) expect(searchMappings(index).properties[field]).toEqual({ type: 'boolean' });
  });

  test('AWSJSON fields are objects with dynamically mapped subfields', () => {
    const dynamicObject = { type: 'object', dynamic: true };
    const archive = searchMappings('archive');
    const collection = searchMappings('collection');
    for (const field of ['alt_text', 'extracted_text', 'manifest_file_characterization', 'visual_description']) {
      expect(archive.properties[field]).toEqual(dynamicObject);
    }
    for (const field of ['alt_text', 'collectionOptions', 'ownerinfo']) {
      expect(collection.properties[field]).toEqual(dynamicObject);
    }
    // Dynamic subfields must not be guessed to be dates
    expect(archive.date_detection).toBe(false);
    expect(collection.date_detection).toBe(false);
  });

  test('archiveOptions maps the keys the records use', () => {
    const text = searchMappings('archive').properties.title;
    expect(searchMappings('archive').properties.archiveOptions).toEqual({
      type: 'object',
      properties: {
        assets: {
          type: 'object',
          properties: {
            media_type: text,
            iiif_manifest: text,
            env_config: text,
            gltf_config: text,
            thumbnail: text,
            morpho_thumb: text,
            x3d_config: text,
            x3d_src_img: text,
          },
        },
        config: {
          type: 'object',
          properties: {
            _3d: {
              type: 'object',
              properties: {
                rotation: { type: 'object', properties: { horizontal: text, vertical: text } },
                scale_factor: text,
              },
            },
          },
        },
        derivatives: {
          type: 'object',
          properties: {
            downloads: { type: 'object', properties: { lg: text, md: text, sm: text } },
          },
        },
        page_count: { type: 'long' },
        audioTranscript: text,
        episodeNumber: text,
        seasonNumber: text,
        sourceLink: text,
        sourceText: text,
      },
    });
    // The legacy assets.scale_factor is not indexed; config._3d.scale_factor is
    const { assets } = searchMappings('archive').properties.archiveOptions.properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    expect(assets.properties).not.toHaveProperty('scale_factor');
  });

  test('every date field accepts ISO 8601 and ignores malformed values', () => {
    expect(searchMappings('archive').properties).toMatchObject({
      date, start_date: date, end_date: date, embargo_start_date: date, embargo_end_date: date,
    });
    for (const index of ['archive', 'collection']) {
      const dates = Object.values(searchMappings(index).properties).filter((m) => m.type === 'date');
      expect(dates.length).toBeGreaterThanOrEqual(4);
      for (const mapping of dates) expect(mapping).toEqual(date);
    }
  });

  test('each index has the derived date_range field, which is not a sort field', () => {
    for (const index of ['archive', 'collection']) {
      expect(searchMappings(index).properties.date_range).toEqual({
        type: 'date_range',
        format: 'strict_date_optional_time',
      });
      expect(numericSortFields([index])).not.toContain('date_range');
    }
  });

  test('a schema type with no mapping is an error', () => {
    expect(() => buildSearchMappings('type Archive { id: ID! size: Size }\nenum Size { S }')).toThrow(
      'No mapping for Archive.size: Size',
    );
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

describe('Auth stack', () => {
  const authTemplate = (identityProvider?: string) =>
    Template.fromStack(buildApp(new App(), { env: 'dev', account, userPool, identityProvider }).auth!);

  test('the user pool is only recorded in SSM, not created or changed', () => {
    const auth = authTemplate();
    auth.resourceCountIs('AWS::Cognito::UserPool', 0);
    auth.resourceCountIs('AWS::Cognito::UserPoolGroup', 0);
    auth.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
    auth.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/dlp-access-next/dev/user-pool-id',
      Value: userPool,
    });
  });

  test('records the federated identity provider, defaulting to the pool\'s own users', () => {
    const parameter = (value: string) => ({ Name: '/dlp-access-next/dev/identity-provider', Value: value });
    authTemplate().hasResourceProperties('AWS::SSM::Parameter', parameter('COGNITO'));
    const federated = authTemplate('VT-SSO-OIDC');
    federated.hasResourceProperties('AWS::SSM::Parameter', parameter('VT-SSO-OIDC'));
    // The provider is only named: it is created outside CDK.
    federated.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });

  test.each(['VT SSO', 'VT_SSO', '', 'a'.repeat(33)])('rejects identity provider %p', (identityProvider) => {
    expect(() => buildApp(new App(), { env: 'dev', account, userPool, identityProvider })).toThrow(
      /Invalid identityProvider/,
    );
  });

  test.each([
    ['AbCd12345', /Invalid userPool "AbCd12345": use a Cognito user pool ID/],
    ['us-west-2_AbCd12345', /the pool must be in us-east-1/],
  ])('rejects user pool %p', (badUserPool, message) => {
    expect(() => buildApp(new App(), { env: 'dev', account, userPool: badUserPool })).toThrow(message);
  });

  test.each([{}, { branch: 'x', backend: 'provision' }])('requires a user pool with %p', (options) => {
    expect(() => buildApp(new App(), { env: 'dev', account, ...options })).toThrow(/pass -c userPool=<user pool ID>/);
  });
});

describe('Web stack', () => {
  // The root app is a separate npm project, so its auth module is read as text.
  test("registers the app's sign-in callback route", () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const auth = fs.readFileSync(path.join(repoRoot, 'src', 'lib', 'auth.ts'), 'utf8');
    expect(auth.match(/export const CALLBACK_PATH = ["'](.*?)["']/)?.[1]).toBe(CALLBACK_PATH);
    expect(fs.existsSync(path.join(repoRoot, 'src', 'app', ...CALLBACK_PATH.split('/'), 'route.ts'))).toBe(true);
  });

  test('attach deploys only the Web stack, named after the slugified branch', () => {
    const app = new App();
    const { data, api, auth, web } = buildApp(app, { env: 'dev', account, branch: 'whunter/Multi_Env', certificate });
    expect(data).toBeUndefined();
    expect(api).toBeUndefined();
    expect(auth).toBeUndefined();
    expect(stackNames(app)).toEqual(['DlpAccessNext-Web-whunter-multi-env']);
    expect(web!.dependencies).toHaveLength(0);
  });

  test('provision deploys Data, Api and Auth first', () => {
    const app = new App();
    const { api, auth, web } = buildApp(app, {
      env: 'f-search',
      account,
      userPool,
      branch: 'search',
      backend: 'provision',
      certificate,
    });
    expect(stackNames(app).sort()).toEqual([
      'DlpAccessNext-Web-search',
      'DlpAccessNext-f-search-Api',
      'DlpAccessNext-f-search-Auth',
      'DlpAccessNext-f-search-Data',
    ]);
    expect(web!.dependencies).toContain(api);
    expect(web!.dependencies).toContain(auth);
  });

  test.each([
    [{ env: 'dev', backend: 'attach' }, /only applies with -c branch/],
    [{ env: 'dev', branch: 'x', backend: 'create' }, /Invalid backend "create"/],
    [{ env: 'dev', branch: '///' }, /Invalid branch/],
    [{ env: 'dev', branch: 'a'.repeat(33) }, /Invalid branch/],
    [{ env: 'dev', branch: 'x', userPool }, /-c userPool only applies/],
    [{ env: 'dev', branch: 'x', identityProvider: 'VT-SSO-OIDC' }, /-c identityProvider only applies/],
    [{ env: 'dev', userPool, certificate }, /-c certificate only applies with -c branch/],
    [{ env: 'dev', branch: 'x', certificate: undefined }, /pass -c certificate=<ACM certificate ARN>, the certificate covering x\.next\.dlp\.cloud\.lib\.vt\.edu/],
    [{ env: 'dev', branch: 'x', certificate: 'not-an-arn' }, /Invalid certificate/],
    [{ env: 'dev', branch: 'x', certificate: certificate.replace('us-east-1', 'us-west-2') }, /must be in account .* and us-east-1/],
    [{ env: 'dev', branch: 'x', certificate: certificate.replace(account, '210987654321') }, /must be in account 123456789012/],
  ])('rejects %p', (options, message) => {
    expect(() => buildApp(new App(), { account, certificate, ...options })).toThrow(message);
  });

  const attached = buildApp(new App(), { env: 'pre-production', account, branch: 'feature/search', certificate }).web!;
  const web = Template.fromStack(attached);
  const option = (namespace: string, optionName: string, value: unknown) =>
    Match.objectLike({ Namespace: namespace, OptionName: optionName, Value: value });

  test('Node.js environment named after the branch, with one instance behind a load balancer', () => {
    web.hasResourceProperties('AWS::ElasticBeanstalk::Application', { ApplicationName: 'dlpnext-feature-search' });
    web.hasResourceProperties('AWS::ElasticBeanstalk::Environment', {
      ApplicationName: 'dlpnext-feature-search',
      EnvironmentName: 'dlpnext-feature-search',
      SolutionStackName: Match.stringLikeRegexp('Amazon Linux 2023 .* running Node.js 24'),
      OptionSettings: Match.arrayWith([
        option('aws:elasticbeanstalk:environment', 'EnvironmentType', 'LoadBalanced'),
        option('aws:elasticbeanstalk:environment', 'LoadBalancerType', 'application'),
        option('aws:autoscaling:asg', 'MinSize', '1'),
        option('aws:autoscaling:asg', 'MaxSize', '1'),
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

  test('has its own confidential app client on the environment user pool from SSM', () => {
    web.hasParameter('*', {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/dlp-access-next/pre-production/user-pool-id',
    });
    web.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'dlpnext-feature-search',
      UserPoolId: { Ref: Match.anyValue() },
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email'],
      CallbackURLs: ['https://feature-search.next.dlp.cloud.lib.vt.edu/authorize', 'http://localhost:3000/authorize'],
      LogoutURLs: ['https://feature-search.next.dlp.cloud.lib.vt.edu/', 'http://localhost:3000/'],
      SupportedIdentityProviders: [{ Ref: Match.anyValue() }],
    });
    web.hasParameter('*', {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/dlp-access-next/pre-production/identity-provider',
    });
    // No custom resource (and so no Lambda) to read the client secret.
    web.resourceCountIs('AWS::Lambda::Function', 0);
    const setting = (name: string, value: unknown) => option('aws:elasticbeanstalk:application:environment', name, value);
    web.hasResourceProperties('AWS::ElasticBeanstalk::Environment', {
      OptionSettings: Match.arrayWith([
        setting('COGNITO_ISSUER', {
          'Fn::Join': ['', ['https://cognito-idp.us-east-1.amazonaws.com/', { Ref: Match.anyValue() }]],
        }),
        setting('COGNITO_CLIENT_ID', { Ref: Match.stringLikeRegexp('^AppClient') }),
        setting('COGNITO_IDENTITY_PROVIDER', { Ref: Match.anyValue() }),
      ]),
    });
  });

  const secretId = Object.keys(web.findResources('AWS::SecretsManager::Secret'))[0];
  const environment = Object.values(web.findResources('AWS::ElasticBeanstalk::Environment'))[0];

  test('keeps the client secret in Secrets Manager, not in plain-text environment properties', () => {
    web.hasResourceProperties('AWS::SecretsManager::Secret', {
      SecretString: { 'Fn::GetAtt': [Match.stringLikeRegexp('^AppClient'), 'ClientSecret'] },
    });
    web.hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Delete' });
    web.hasResourceProperties('AWS::ElasticBeanstalk::Environment', {
      OptionSettings: Match.arrayWith([
        option('aws:elasticbeanstalk:application:environmentsecrets', 'COGNITO_CLIENT_SECRET', { Ref: secretId }),
      ]),
    });
    const settings: { Namespace: string; OptionName: string }[] = environment.Properties.OptionSettings;
    expect(settings).not.toContainEqual(
      expect.objectContaining({ Namespace: 'aws:elasticbeanstalk:application:environment', OptionName: 'COGNITO_CLIENT_SECRET' }),
    );
    // The secret value only reaches the template as the secret's own property.
    const secretValueRefs = JSON.stringify(web.toJSON()).match(/"Fn::GetAtt":\["AppClient[^"]*","ClientSecret"\]/g) ?? [];
    expect(secretValueRefs).toHaveLength(1);
    web.hasOutput('CognitoClientSecretArn', { Value: { Ref: secretId } });
  });

  test('only the environment instance role can read the client secret, before the environment starts', () => {
    const readers = Object.entries(web.findResources('AWS::IAM::Policy')).filter(([, p]) =>
      JSON.stringify(p.Properties.PolicyDocument).includes(secretId),
    );
    expect(readers).toHaveLength(1);
    const [[policyId, policy]] = readers;
    expect(policy.Properties.Roles).toEqual(['dlp-access-next-pre-production-eb']);
    expect(policy.Properties.PolicyDocument.Statement).toEqual([
      expect.objectContaining({
        Effect: 'Allow',
        Action: expect.arrayContaining(['secretsmanager:GetSecretValue']),
        Resource: { Ref: secretId },
      }),
    ]);
    expect(environment.DependsOn).toContain(policyId);
  });

  test('serves the branch over HTTPS at its own domain name', () => {
    web.hasResourceProperties('AWS::ElasticBeanstalk::Environment', {
      OptionSettings: Match.arrayWith([
        option('aws:elbv2:listener:443', 'Protocol', 'HTTPS'),
        option('aws:elbv2:listener:443', 'SSLCertificateArns', certificate),
        option('aws:elbv2:listener:443', 'SSLPolicy', Match.stringLikeRegexp('^ELBSecurityPolicy-TLS13')),
        option(
          'aws:elasticbeanstalk:application:environment',
          'APP_BASE_URL',
          'https://feature-search.next.dlp.cloud.lib.vt.edu',
        ),
      ]),
    });
    const environmentId = Object.keys(web.findResources('AWS::ElasticBeanstalk::Environment'))[0];
    web.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'feature-search.next.dlp.cloud.lib.vt.edu.',
      Type: 'CNAME',
      ResourceRecords: [{ 'Fn::GetAtt': [environmentId, 'EndpointURL'] }],
    });
    web.hasOutput('AppUrl', { Value: 'https://feature-search.next.dlp.cloud.lib.vt.edu' });
  });

  test('nginx redirects HTTP to HTTPS behind the load balancer', () => {
    const conf = fs.readFileSync(
      path.join(__dirname, '..', '..', '.platform', 'nginx', 'conf.d', 'elasticbeanstalk', 'https-redirect.conf'),
      'utf8',
    );
    expect(conf).toMatch(/if \(\$http_x_forwarded_proto = "http"\)\s*{\s*return 301 https:\/\/\$host\$request_uri;/);
  });

  test('the production flag uses a larger instance', () => {
    const { web: prod } = buildApp(new App(), { env: 'production', account, production: true, branch: 'main', certificate });
    Template.fromStack(prod!).hasResourceProperties('AWS::ElasticBeanstalk::Environment', {
      OptionSettings: Match.arrayWith([option('aws:ec2:instances', 'InstanceTypes', 't3.medium')]),
    });
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
