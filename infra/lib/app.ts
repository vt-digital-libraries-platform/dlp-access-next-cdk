import { App } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { AuthStack } from './auth-stack';
import { DataStack } from './data-stack';
import { EnvironmentConfig, resolveEnvironment } from './environments';
import { CERTIFICATE_ID, WebStack, branchSlug, webDomainName, webResourceName } from './web-stack';


export interface AppOptions {
  readonly backendEnv?: string;
  readonly awsAccountId?: string;
  /**
   * Production sizing: three OpenSearch nodes instead of one, and a larger
   * Beanstalk instance. Defaults to false.
   */
  readonly production?: boolean;
  /** dlp-access-next Git branch to deploy. Omit to deploy only the environment. */
  readonly frontendBranch?: string;
  /**
   * `attach` | `provision`
   * Specifies whether a new backend should be created OR frontend should be attached to existing backend 
   */
  readonly backend?: string;
  readonly userPoolId?: string;
  /**
   * Name of the federated identity provider in the Cognito user pool that users sign
   * in through, eg: `VT-SSO-OIDC`.
   */
  readonly identityProvider?: string;
  /**
   * ARN of the existing ACM certificate
   */
  readonly certificate?: string;
}

/** The validated options, with defaults applied, and the stacks they produce. */
export interface AppPlan {
  readonly config: EnvironmentConfig;
  readonly awsAccountId: string;
  readonly production: boolean;
  readonly frontend?: FrontendPlan;
  readonly userPoolId?: string;
  readonly identityProvider?: string;
  readonly dataStackName?: string;
  readonly apiStackName?: string;
  readonly authStackName?: string;
}

export interface FrontendPlan {
  readonly branch: string;
  readonly slug: string;
  readonly backend: string;
  readonly appUrl: string;
  readonly certificate: string;
  readonly stackName: string;
}

export interface AppStacks {
  readonly data?: DataStack;
  readonly api?: ApiStack;
  readonly auth?: AuthStack;
  readonly web?: WebStack;
}

const BACKENDS = ['attach', 'provision'];
const ACCOUNT_PATTERN = /^\d{12}$/;
// <region>_<id>, e.g. us-east-1_AbCd12345
const USER_POOL_ID_PATTERN = /^([a-z0-9-]+)_[0-9a-zA-Z]+$/;
const CERTIFICATE_ARN_PATTERN = /^arn:aws:acm:([a-z0-9-]+):(\d{12}):certificate\/[0-9a-f-]+$/;
// Cognito provider names are at most 32 characters, without spaces or underscores.
const IDENTITY_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/;
// Git never allows these in a branch name, and the deploy script prints the
// name before asking to confirm, where escape sequences could rewrite the screen.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/**
 * Reads a boolean context value. `-c name=true` arrives as the string
 * "true", while cdk.json can hold a real boolean, so both are accepted.
 */
export function booleanContext(name: string, value: unknown): boolean | undefined {
  if (value === undefined || value === true || value === false) {
    return value;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  throw new Error(`Invalid ${name} "${value}": use true or false`);
}

/** Reads the options from CDK context, given a lookup such as `tryGetContext`. */
export function optionsFromContext(context: (key: string) => unknown): AppOptions {
  const str = (key: string) => {
    const value = context(key);
    return value === undefined ? undefined : String(value);
  };
  return {
    backendEnv: str('backend-env'),
    awsAccountId: str('aws-account-id'),
    production: booleanContext('production', context('production')),
    frontendBranch: str('frontend-branch'),
    backend: str('backend'),
    userPoolId: str('user-pool-id'),
    identityProvider: str('identity-provider'),
    certificate: str('certificate'),
  };
}

/**
 * Validates the options and works out which stacks they produce:
 * - no branch: the environment's Data, Api and Auth stacks
 * - branch, backend=attach: the branch's Web stack only
 * - branch, backend=provision: Data, Api, Auth and Web
 */
export function planApp(options: AppOptions): AppPlan {
  const production = options.production ?? false;
  const config = resolveEnvironment(options.backendEnv, production);
  if (options.awsAccountId === undefined) {
    throw new Error('Missing CDK context: pass -c aws-account-id=<AWS account ID>');
  }
  if (!ACCOUNT_PATTERN.test(options.awsAccountId)) {
    throw new Error(`Invalid aws-account-id "${options.awsAccountId}": use a 12-digit AWS account ID`);
  }

  if (options.frontendBranch === undefined && options.backend !== undefined) {
    throw new Error('-c backend only applies with -c frontend-branch=<git branch>');
  }
  const backend = options.backend ?? 'attach';
  if (!BACKENDS.includes(backend)) {
    throw new Error(`Invalid backend "${backend}": use ${BACKENDS.join(' or ')}`);
  }

  const prefix = `DlpAccessNext-${config.name}`;
  const provision = options.frontendBranch === undefined || backend === 'provision';
  if (options.frontendBranch !== undefined && CONTROL_CHARACTERS.test(options.frontendBranch)) {
    throw new Error(`Invalid frontend-branch ${JSON.stringify(options.frontendBranch)}: a git branch name has no control characters`);
  }
  const branch =
    options.frontendBranch === undefined
      ? undefined
      : { branch: options.frontendBranch, slug: branchSlug(options.frontendBranch) };
  if (branch) {
    webResourceName(branch.slug);
  }

  for (const [field, option] of [['userPoolId', 'user-pool-id'], ['identityProvider', 'identity-provider']] as const) {
    if (options[field] !== undefined && !provision) {
      throw new Error(
        `-c ${option} only applies when the environment's stacks are deployed: drop -c frontend-branch, or add -c backend=provision`,
      );
    }
  }
  if (options.identityProvider !== undefined && !IDENTITY_PROVIDER_PATTERN.test(options.identityProvider)) {
    throw new Error(
      `Invalid identity-provider "${options.identityProvider}": use the name of an identity provider on the user pool, such as VT-SSO-OIDC`,
    );
  }
  if (provision && options.userPoolId === undefined) {
    throw new Error(
      "Missing CDK context: pass -c user-pool-id=<user pool ID>, the existing Cognito user pool for the environment's users",
    );
  }
  if (options.userPoolId !== undefined) {
    const region = USER_POOL_ID_PATTERN.exec(options.userPoolId)?.[1];
    if (region === undefined) {
      throw new Error(`Invalid user-pool-id "${options.userPoolId}": use a Cognito user pool ID, such as us-east-1_AbCd12345`);
    }
    if (region !== config.region) {
      throw new Error(`Invalid user-pool-id "${options.userPoolId}": the pool must be in ${config.region}, the environment's region`);
    }
  }
  if (options.certificate !== undefined && !branch) {
    throw new Error('-c certificate only applies with -c frontend-branch=<git branch>');
  }
  if (options.certificate !== undefined) {
    const [, region, certificateAccount] = CERTIFICATE_ARN_PATTERN.exec(options.certificate) ?? [];
    if (region === undefined) {
      throw new Error(`Invalid certificate "${options.certificate}": use an ACM certificate ARN`);
    }
    if (region !== config.region || certificateAccount !== options.awsAccountId) {
      throw new Error(
        `Invalid certificate "${options.certificate}": the certificate must be in account ${options.awsAccountId} and ${config.region}, the environment's region`,
      );
    }
  }
  return {
    config,
    awsAccountId: options.awsAccountId,
    production,
    frontend: branch && {
      ...branch,
      backend,
      appUrl: `https://${webDomainName(branch.slug)}`,
      certificate: options.certificate ?? `arn:aws:acm:${config.region}:${options.awsAccountId}:certificate/${CERTIFICATE_ID}`,
      stackName: `DlpAccessNext-Web-${branch.slug}`,
    },
    userPoolId: options.userPoolId,
    identityProvider: options.identityProvider,
    dataStackName: provision ? `${prefix}-Data` : undefined,
    apiStackName: provision ? `${prefix}-Api` : undefined,
    authStackName: provision ? `${prefix}-Auth` : undefined,
  };
}

/** Adds the stacks that `planApp` works out to the app. */
export function buildApp(app: App, options: AppOptions): AppStacks {
  const plan = planApp(options);
  const { config } = plan;
  const env = { account: plan.awsAccountId, region: config.region };

  let data: DataStack | undefined;
  let api: ApiStack | undefined;
  if (plan.dataStackName && plan.apiStackName) {
    data = new DataStack(app, plan.dataStackName, { env, config });
    api = new ApiStack(app, plan.apiStackName, {
      env,
      config,
      tables: data.tables,
      searchDomain: data.searchDomain,
    });
  }

  let auth: AuthStack | undefined;
  if (plan.authStackName && plan.userPoolId) {
    auth = new AuthStack(app, plan.authStackName, {
      env,
      config,
      userPoolId: plan.userPoolId,
      identityProvider: plan.identityProvider,
    });
  }

  let web: WebStack | undefined;
  if (plan.frontend) {
    web = new WebStack(app, plan.frontend.stackName, {
      env,
      config,
      frontendBranch: plan.frontend.branch,
      frontendBranchSlug: plan.frontend.slug,
      certificateArn: plan.frontend.certificate,
    });
    // The Web stack reads the API URL and the sign-in settings from the SSM
    // parameters the Api and Auth stacks write, so it must deploy after them.
    for (const stack of [api, auth]) {
      if (stack) {
        web.addStackDependency(stack);
      }
    }
  }

  return { data, api, auth, web };
}
