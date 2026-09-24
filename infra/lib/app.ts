import { App } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { DataStack } from './data-stack';
import { resolveEnvironment } from './environments';
import { WebStack, branchSlug } from './web-stack';

/** CDK context, as passed with `-c env=... -c account=... -c branch=... -c backend=...`. */
export interface AppOptions {
  readonly env?: string;
  /** AWS account ID to deploy the environment's stacks to. */
  readonly account?: string;
  /** Git branch to deploy the Next.js app for. Omit to deploy only the environment. */
  readonly branch?: string;
  /**
   * With a branch: `attach` (the default) deploys only the Web stack, onto
   * the environment's already-deployed stacks. `provision` also deploys the
   * environment's Data and Api stacks, before the Web stack.
   */
  readonly backend?: string;
}

export interface AppStacks {
  readonly data?: DataStack;
  readonly api?: ApiStack;
  readonly web?: WebStack;
}

const BACKENDS = ['attach', 'provision'];
const ACCOUNT_PATTERN = /^\d{12}$/;

/**
 * Adds stacks to the app:
 * - no branch: the environment's Data and Api stacks
 * - branch, backend=attach: the branch's Web stack only
 * - branch, backend=provision: Data, Api and Web
 */
export function buildApp(app: App, options: AppOptions): AppStacks {
  const config = resolveEnvironment(options.env);
  if (options.account === undefined) {
    throw new Error('Missing CDK context: pass -c account=<AWS account ID>');
  }
  if (!ACCOUNT_PATTERN.test(options.account)) {
    throw new Error(`Invalid account "${options.account}": use a 12-digit AWS account ID`);
  }
  const env = { account: options.account, region: config.region };
  const prefix = `DlpAccessNext-${config.name}`;

  if (options.branch === undefined && options.backend !== undefined) {
    throw new Error('-c backend only applies with -c branch=<git branch>');
  }
  const backend = options.backend ?? 'attach';
  if (!BACKENDS.includes(backend)) {
    throw new Error(`Invalid backend "${backend}": use ${BACKENDS.join(' or ')}`);
  }

  const provision = options.branch === undefined || backend === 'provision';
  let data: DataStack | undefined;
  let api: ApiStack | undefined;
  if (provision) {
    data = new DataStack(app, `${prefix}-Data`, { env, config });
    api = new ApiStack(app, `${prefix}-Api`, {
      env,
      config,
      tables: data.tables,
      searchDomain: data.searchDomain,
    });
  }

  let web: WebStack | undefined;
  if (options.branch !== undefined) {
    const branch = branchSlug(options.branch);
    web = new WebStack(app, `DlpAccessNext-Web-${branch}`, { env, config, branch });
    // The Web stack reads the API URL from the SSM parameter the Api stack
    // writes, so it must deploy after it.
    if (api) {
      web.addStackDependency(api);
    }
  }

  return { data, api, web };
}
