import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, IgnoreMode, Stack, StackProps } from 'aws-cdk-lib';
import * as elasticbeanstalk from 'aws-cdk-lib/aws-elasticbeanstalk';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentConfig, ebInstanceProfileName, graphqlApiUrlParameterName } from './environments';

/**
 * The Node.js platform the app runs on, matching the hand-made
 * `appsync-stack` environment. Managed updates apply minor platform
 * versions in place, so this only needs bumping for a major change.
 */
export const SOLUTION_STACK = '64bit Amazon Linux 2023 v6.11.8 running Node.js 24';

const REPO_ROOT = path.join(__dirname, '..', '..');

// Beyond .gitignore: files in the repo that the Next.js server doesn't need.
// `.env*` is repeated here so local secrets stay out even if .gitignore changes.
const BUNDLE_EXCLUDES = ['.git', '.github', '.claude', '.elasticbeanstalk', 'infra', 'docs', '*.md', '.env*'];

export interface WebStackProps extends StackProps {
  /** The environment whose API the app calls. */
  readonly config: EnvironmentConfig;
  /** Branch slug; names the Beanstalk application and environment. */
  readonly branch: string;
}

/**
 * One branch deployment of the Next.js app on Elastic Beanstalk. It finds
 * its environment's API by fixed names (the instance profile and an SSM
 * parameter), so it deploys the same way whether the environment's stacks
 * are in this CDK app or were deployed earlier.
 */
export class WebStack extends Stack {
  /** The repo source uploaded as the Beanstalk application version. */
  public readonly sourceBundle: s3assets.Asset;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config, branch } = props;
    const name = webResourceName(branch);

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

    const settings: Record<string, Record<string, string>> = {
      'aws:elasticbeanstalk:environment': {
        EnvironmentType: 'SingleInstance',
        ServiceRole: serviceRole.roleArn,
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

    new CfnOutput(this, 'EnvironmentName', { value: name });
    new CfnOutput(this, 'EndpointUrl', { value: environment.attrEndpointUrl });
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
