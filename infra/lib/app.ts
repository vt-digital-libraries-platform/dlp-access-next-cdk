import { App } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { DataStack } from './data-stack';
import { EnvironmentConfig, resolveEnvironment } from './environments';
import { WebStack, branchSlug, webResourceName } from './web-stack';

/** CDK context, as passed with `-c env=... -c account=... -c production=... -c branch=... -c backend=...`. */
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
  readonly dataStackName?: string;
  readonly apiStackName?: string;
  readonly webStackName?: string;
}

export interface AppStacks {
  readonly data?: DataStack;
  readonly api?: ApiStack;
  readonly web?: WebStack;
}

const BACKENDS = ['attach', 'provision'];
const ACCOUNT_PATTERN = /^\d{12}$/;

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
  };
}

/**
 * Validates the options and works out which stacks they produce:
 * - no branch: the environment's Data and Api stacks
 * - branch, backend=attach: the branch's Web stack only
 * - branch, backend=provision: Data, Api and Web
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
  return {
    config,
    account: options.account,
    production,
    branch,
    backend: branch === undefined ? undefined : backend,
    dataStackName: provision ? `${prefix}-Data` : undefined,
    apiStackName: provision ? `${prefix}-Api` : undefined,
    webStackName: branch === undefined ? undefined : `DlpAccessNext-Web-${branch}`,
  };
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

  let web: WebStack | undefined;
  if (plan.webStackName && plan.branch) {
    web = new WebStack(app, plan.webStackName, { env, config, branch: plan.branch });
    // The Web stack reads the API URL from the SSM parameter the Api stack
    // writes, so it must deploy after it.
    if (api) {
      web.addStackDependency(api);
    }
  }

  return { data, api, web };
}
