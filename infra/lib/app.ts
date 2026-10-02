import { App } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { AuthStack } from './auth-stack';
import { DataStack } from './data-stack';
import { EnvironmentConfig, resolveEnvironment } from './environments';
import { WebStack, branchSlug, webResourceName } from './web-stack';

/**
 * CDK context, as passed with `-c env=... -c account=... -c production=... -c branch=... -c backend=...
 * -c userPool=... -c appUrl=...`.
 */
export interface AppOptions {
  readonly env?: string;
  /** AWS account ID to deploy the environment's stacks to. */
  readonly account?: string;
  /**
   * Production sizing: three OpenSearch nodes instead of one, and a larger
   * Beanstalk instance. Defaults to false.
   */
  readonly production?: boolean;
  /** Git branch to deploy the Next.js app for. Omit to deploy only the environment. */
  readonly branch?: string;
  /**
   * With a branch: `attach` (the default) deploys only the Web stack, onto
   * the environment's already-deployed stacks. `provision` also deploys the
   * environment's Data and Api stacks, before the Web stack.
   */
  readonly backend?: string;
  /**
   * ID of an existing Cognito user pool for the environment to use. Omit to
   * provision a new pool. Applies only when the environment's stacks are
   * being deployed.
   */
  readonly userPool?: string;
  /**
   * With a branch: the public HTTPS origin of the app, such as
   * `https://next.example.edu`. It is registered as a sign-in callback on
   * the branch's Cognito app client. Without it, sign-in only works for the
   * app running on localhost.
   */
  readonly appUrl?: string;
}

/** The validated options, with defaults applied, and the stacks they produce. */
export interface AppPlan {
  readonly config: EnvironmentConfig;
  readonly account: string;
  readonly production: boolean;
  /** The branch's slug; undefined without `-c branch`. */
  readonly branch?: string;
  /** undefined without `-c branch`. */
  readonly backend?: string;
  /** undefined when the Auth stack isn't deployed, or provisions its own pool. */
  readonly userPool?: string;
  /** undefined without `-c appUrl`. */
  readonly appUrl?: string;
  readonly dataStackName?: string;
  readonly apiStackName?: string;
  readonly authStackName?: string;
  readonly webStackName?: string;
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
    env: str('env'),
    account: str('account'),
    production: booleanContext('production', context('production')),
    branch: str('branch'),
    backend: str('backend'),
    userPool: str('userPool'),
    appUrl: str('appUrl'),
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
  const config = resolveEnvironment(options.env, production);
  if (options.account === undefined) {
    throw new Error('Missing CDK context: pass -c account=<AWS account ID>');
  }
  if (!ACCOUNT_PATTERN.test(options.account)) {
    throw new Error(`Invalid account "${options.account}": use a 12-digit AWS account ID`);
  }

  if (options.branch === undefined && options.backend !== undefined) {
    throw new Error('-c backend only applies with -c branch=<git branch>');
  }
  const backend = options.backend ?? 'attach';
  if (!BACKENDS.includes(backend)) {
    throw new Error(`Invalid backend "${backend}": use ${BACKENDS.join(' or ')}`);
  }

  const prefix = `DlpAccessNext-${config.name}`;
  const provision = options.branch === undefined || backend === 'provision';
  const branch = options.branch === undefined ? undefined : branchSlug(options.branch);
  if (branch !== undefined) {
    webResourceName(branch);
  }

  if (options.userPool !== undefined) {
    if (!provision) {
      throw new Error(
        '-c userPool only applies when the environment\'s stacks are deployed: drop -c branch, or add -c backend=provision',
      );
    }
    const region = USER_POOL_ID_PATTERN.exec(options.userPool)?.[1];
    if (region === undefined) {
      throw new Error(`Invalid userPool "${options.userPool}": use a Cognito user pool ID, such as us-east-1_AbCd12345`);
    }
    if (region !== config.region) {
      throw new Error(`Invalid userPool "${options.userPool}": the pool must be in ${config.region}, the environment's region`);
    }
  }
  if (options.appUrl !== undefined && branch === undefined) {
    throw new Error('-c appUrl only applies with -c branch=<git branch>');
  }
  const appUrl = options.appUrl === undefined ? undefined : appOrigin(options.appUrl);
  return {
    config,
    account: options.account,
    production,
    branch,
    backend: branch === undefined ? undefined : backend,
    userPool: options.userPool,
    appUrl,
    dataStackName: provision ? `${prefix}-Data` : undefined,
    apiStackName: provision ? `${prefix}-Api` : undefined,
    authStackName: provision ? `${prefix}-Auth` : undefined,
    webStackName: branch === undefined ? undefined : `DlpAccessNext-Web-${branch}`,
  };
}

/** Checks `-c appUrl` and returns its origin. Cognito only accepts HTTPS callbacks, except for localhost. */
function appOrigin(appUrl: string): string {
  let url: URL | undefined;
  try {
    url = new URL(appUrl);
  } catch {
    // Reported below.
  }
  if (url?.protocol !== 'https:' || url.origin !== appUrl.replace(/\/$/, '')) {
    throw new Error(`Invalid appUrl "${appUrl}": use the app's HTTPS origin, such as https://next.example.edu`);
  }
  return url.origin;
}

/** Adds the stacks that `planApp` works out to the app. */
export function buildApp(app: App, options: AppOptions): AppStacks {
  const plan = planApp(options);
  const { config } = plan;
  const env = { account: plan.account, region: config.region };

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
  if (plan.authStackName) {
    auth = new AuthStack(app, plan.authStackName, { env, config, existingUserPoolId: plan.userPool });
  }

  let web: WebStack | undefined;
  if (plan.webStackName && plan.branch) {
    web = new WebStack(app, plan.webStackName, { env, config, branch: plan.branch, appUrl: plan.appUrl });
    // The Web stack reads the API URL and the user pool ID from the SSM
    // parameters the Api and Auth stacks write, so it must deploy after them.
    for (const stack of [api, auth]) {
      if (stack) {
        web.addStackDependency(stack);
      }
    }
  }

  return { data, api, auth, web };
}
