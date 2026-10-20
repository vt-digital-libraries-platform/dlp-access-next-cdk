import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, IgnoreMode, RemovalPolicy, SecretValue, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elasticbeanstalk from 'aws-cdk-lib/aws-elasticbeanstalk';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  EnvironmentConfig,
  ebInstanceProfileName,
  graphqlApiUrlParameterName,
  identityProviderParameterName,
  userPoolIdParameterName,
} from './environments';

/**
 * The Node.js platform the app runs on, matching the hand-made
 * `appsync-stack` environment. Managed updates apply minor platform
 * versions in place, so this only needs bumping for a major change.
 */
export const SOLUTION_STACK = '64bit Amazon Linux 2023 v6.11.8 running Node.js 24';

const REPO_ROOT = path.join(__dirname, '..', '..');

// Where `npm run dev` serves the app. Always registered on the app client,
// so the branch can be run locally against its environment's user pool.
const LOCAL_ORIGIN = 'http://localhost:3000';
// The app's sign-in callback route (src/app/authorize). It must match
// CALLBACK_PATH in src/lib/auth.ts, which a test checks.
export const CALLBACK_PATH = '/authorize';

// Each branch is served at <slug>.<APP_DOMAIN>, by a record in the hosted
// zone HOSTED_ZONE, over HTTPS with an existing certificate covering
// *.<APP_DOMAIN>.
export const APP_DOMAIN = 'dlp-access-dev.dlp.cloud.lib.vt.edu';
// The ACM certificate covering *.<APP_DOMAIN>, by ID only: the ARN is built
// from the deploy's account and the environment's region, so no account ID
// is stored here. `-c certificate=<ARN>` overrides it.
export const CERTIFICATE_ID = '3163b25c-b6f5-4b23-8569-514064db7767';
export const HOSTED_ZONE = 'dlp.cloud.lib.vt.edu';
const TLS_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06';

// Beyond .gitignore: files in the repo that the Next.js server doesn't need.
// `.env*` is repeated here so local secrets stay out even if .gitignore changes.
const BUNDLE_EXCLUDES = ['.git', '.github', '.claude', '.elasticbeanstalk', 'infra', 'docs', '*.md', '.env*'];

export interface WebStackProps extends StackProps {
  /** The environment whose API the app calls. */
  readonly config: EnvironmentConfig;
  /** Branch slug; names the Beanstalk application and environment. */
  readonly branch: string;
  /** ARN of the ACM certificate covering the branch's domain name. */
  readonly certificateArn: string;
}

/**
 * One branch deployment of the Next.js app on Elastic Beanstalk. It finds
 * its environment's API and user pool by fixed names (the instance profile
 * and SSM parameters), so it deploys the same way whether the environment's
 * stacks are in this CDK app or were deployed earlier. The Cognito app
 * client the app signs users in with is the branch's own, and so is its
 * domain name, served over HTTPS by the environment's load balancer.
 */
export class WebStack extends Stack {
  /** The repo source uploaded as the Beanstalk application version. */
  public readonly sourceBundle: s3assets.Asset;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config, branch, certificateArn } = props;
    const name = webResourceName(branch);
    const domainName = webDomainName(branch);
    const appUrl = `https://${domainName}`;

    // The same files `eb deploy` ships from git; the platform's prebuild
    // hook (.platform/hooks) installs dependencies and runs `next build`.
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split('\n');
    this.sourceBundle = new s3assets.Asset(this, 'SourceBundle', {
      path: REPO_ROOT,
      ignoreMode: IgnoreMode.GIT,
      exclude: [...gitignore, ...BUNDLE_EXCLUDES],
    });

    const application = new elasticbeanstalk.CfnApplication(this, 'Application', {
      applicationName: name,
      description: `dlp-access-next branch ${branch}, using the ${config.name} environment`,
    });
    const version = new elasticbeanstalk.CfnApplicationVersion(this, 'Version', {
      applicationName: name,
      sourceBundle: {
        s3Bucket: this.sourceBundle.s3BucketName,
        s3Key: this.sourceBundle.s3ObjectKey,
      },
    });
    version.addResourceDependency(application);

    // Same policies as the default aws-elasticbeanstalk-service-role. The
    // enhanced-health policy lives under the service-role/ path.
    const serviceRole = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('elasticbeanstalk.amazonaws.com'),
      managedPolicies: [
        'service-role/AWSElasticBeanstalkEnhancedHealth',
        'AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy',
      ].map((policy) => iam.ManagedPolicy.fromAwsManagedPolicyName(policy)),
    });

    // Resolved by CloudFormation at deploy time; the deploy fails with
    // "Unable to fetch parameters" if the environment's Api stack is missing.
    const apiUrl = ssm.StringParameter.valueForStringParameter(this, graphqlApiUrlParameterName(config.name));

    // The environment's user pool, likewise found through
    // SSM. The app client is a confidential one for the authorization code
    // flow, as src/lib/auth.ts expects.
    const userPoolId = ssm.StringParameter.valueForStringParameter(this, userPoolIdParameterName(config.name));
    // The one provider users sign in through: a federated provider on the
    // pool, or COGNITO for the pool's own users. The app sends users straight
    // to it, so the client allows no other.
    const identityProvider = ssm.StringParameter.valueForStringParameter(
      this,
      identityProviderParameterName(config.name),
    );
    const origins = [appUrl, LOCAL_ORIGIN];
    const appClient = new cognito.UserPoolClient(this, 'AppClient', {
      userPool: cognito.UserPool.fromUserPoolId(this, 'UserPool', userPoolId),
      userPoolClientName: name,
      generateSecret: true,
      authFlows: {},
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.custom(identityProvider)],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: origins.map((origin) => `${origin}${CALLBACK_PATH}`),
        logoutUrls: origins.map((origin) => `${origin}/`),
      },
    });
    const cognitoIssuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}`;
    // Kept out of the plain-text environment properties. Beanstalk reads it
    // with the instance role and hands it to the app as an environment
    // variable. The name is generated: a deleted secret keeps its name during
    // its recovery window, so a fixed one would collide on redeploy.
    const clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      description: `Cognito app client secret for ${name}`,
      // Read from the resource attribute: the construct's own accessor makes
      // a custom resource to fetch the same value.
      secretStringValue: SecretValue.resourceAttribute(
        (appClient.node.defaultChild as cognito.CfnUserPoolClient).attrClientSecret,
      ),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // The environment's instance role is shared by its branches and owned by
    // its Api stack; this grant is the branch's own and is in place before
    // the environment's first instance starts. Named after the branch: an
    // inline policy name must be unique on the role, and `grantRead` would
    // name it after its construct path, the same in every Web stack.
    const instanceRole = iam.Role.fromRoleName(this, 'InstanceRole', ebInstanceProfileName(config.name));
    const secretRead = new iam.Policy(this, 'ClientSecretRead', {
      policyName: `${name}-client-secret`,
      roles: [instanceRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: [clientSecret.secretArn],
        }),
      ],
    });

    const settings: Record<string, Record<string, string>> = {
      'aws:elasticbeanstalk:environment': {
        // One instance behind an ALB, which terminates HTTPS. Port 80 stays
        // open; nginx redirects it to HTTPS (.platform/nginx).
        EnvironmentType: 'LoadBalanced',
        LoadBalancerType: 'application',
        ServiceRole: serviceRole.roleArn,
      },
      'aws:autoscaling:asg': {
        MinSize: '1',
        MaxSize: '1',
      },
      'aws:elbv2:listener:443': {
        Protocol: 'HTTPS',
        SSLCertificateArns: certificateArn,
        SSLPolicy: TLS_POLICY,
      },
      'aws:autoscaling:launchconfiguration': {
        IamInstanceProfile: ebInstanceProfileName(config.name),
        DisableIMDSv1: 'true',
      },
      'aws:ec2:instances': {
        InstanceTypes: config.web.instanceType,
      },
      'aws:elasticbeanstalk:application:environment': {
        APPSYNC_API_URL: apiUrl,
        AWS_REGION: this.region,
        COGNITO_ISSUER: cognitoIssuer,
        COGNITO_CLIENT_ID: appClient.userPoolClientId,
        COGNITO_IDENTITY_PROVIDER: identityProvider,
        // The origin the browser uses; the server only sees the proxy's.
        APP_BASE_URL: appUrl,
      },
      'aws:elasticbeanstalk:application:environmentsecrets': {
        COGNITO_CLIENT_SECRET: clientSecret.secretArn,
      },
      'aws:elasticbeanstalk:healthreporting:system': {
        SystemType: 'enhanced',
      },
      'aws:elasticbeanstalk:managedactions': {
        ManagedActionsEnabled: 'true',
        PreferredStartTime: 'Sun:09:00',
        ServiceRoleForManagedUpdates: serviceRole.roleArn,
      },
      'aws:elasticbeanstalk:managedactions:platformupdate': {
        UpdateLevel: 'minor',
      },
      'aws:elasticbeanstalk:cloudwatch:logs': {
        StreamLogs: 'true',
        RetentionInDays: '7',
      },
    };

    const environment = new elasticbeanstalk.CfnEnvironment(this, 'Environment', {
      applicationName: name,
      environmentName: name,
      solutionStackName: SOLUTION_STACK,
      versionLabel: version.ref,
      optionSettings: Object.entries(settings).flatMap(([namespace, options]) =>
        Object.entries(options).map(([optionName, value]) => ({ namespace, optionName, value })),
      ),
    });
    environment.addResourceDependency(application);
    environment.node.addDependency(secretRead);

    // The endpoint is the load balancer's DNS name. Looked up at synth time
    // and cached in cdk.context.json.
    new route53.CnameRecord(this, 'DomainRecord', {
      zone: route53.HostedZone.fromLookup(this, 'HostedZone', { domainName: HOSTED_ZONE }),
      recordName: domainName,
      domainName: environment.attrEndpointUrl,
    });

    new CfnOutput(this, 'EnvironmentName', { value: name });
    new CfnOutput(this, 'AppUrl', { value: appUrl });
    new CfnOutput(this, 'EndpointUrl', { value: environment.attrEndpointUrl });
    // For running the branch locally. The client secret itself is not an
    // output; read it with `aws secretsmanager get-secret-value`.
    new CfnOutput(this, 'CognitoIssuer', { value: cognitoIssuer });
    new CfnOutput(this, 'CognitoClientId', { value: appClient.userPoolClientId });
    new CfnOutput(this, 'CognitoIdentityProvider', { value: identityProvider });
    new CfnOutput(this, 'CognitoClientSecretArn', { value: clientSecret.secretArn });
  }
}

/**
 * Turns a git branch name into the slug that names a Web stack, e.g.
 * `whunter/Multi_Env` becomes `whunter-multi-env`.
 */
export function branchSlug(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Beanstalk environment names are 4 to 40 characters.
const WEB_PREFIX = 'dlpnext-';
const MAX_SLUG_LENGTH = 40 - WEB_PREFIX.length;

/** Name of the branch's Beanstalk application and environment. */
export function webResourceName(slug: string): string {
  if (!slug || slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Invalid branch "${slug}": after slugifying it must be 1 to ${MAX_SLUG_LENGTH} characters; pass a shorter -c branch=<name>`,
    );
  }
  return `${WEB_PREFIX}${slug}`;
}

/** The branch's public domain name, e.g. `whunter-multi-env.dlp-access-dev.dlp.cloud.lib.vt.edu`. */
export function webDomainName(slug: string): string {
  return `${slug}.${APP_DOMAIN}`;
}
