import { App } from "aws-cdk-lib";
import { ApiStack } from "./stacks/api-stack";
import { AuthStack } from "./stacks/auth-stack";
import { DataStack } from "./stacks/data-stack";
import { EnvironmentConfig, resolveEnvironment } from "./config/environments";

export interface AppOptions {
  readonly backendEnv?: string;
  readonly awsAccountId?: string;
  /** Production sizing: three OpenSearch nodes instead of one. Defaults to false. */
  readonly production?: boolean;
  readonly userPoolId?: string;
  /**
   * Name of the federated identity provider in the Cognito user pool that users sign
   * in through, eg: `VT-SSO-OIDC`.
   */
  readonly identityProvider?: string;
  /**
   * Options that once deployed a frontend from the CDK app. Read only so
   * `planApp` can point anyone passing them at `frontend:deploy`.
   */
  readonly frontendBranch?: string;
  readonly backend?: string;
  readonly certificate?: string;
}

/** The validated options, with defaults applied, and the stacks they produce. */
export interface AppPlan {
  readonly config: EnvironmentConfig;
  readonly awsAccountId: string;
  readonly production: boolean;
  readonly userPoolId: string;
  readonly identityProvider?: string;
  readonly dataStackName: string;
  readonly apiStackName: string;
  readonly authStackName: string;
}

export interface AppStacks {
  readonly data: DataStack;
  readonly api: ApiStack;
  readonly auth: AuthStack;
}

// Frontends deploy with `npm run frontend:deploy`, not the CDK app.
const FRONTEND_OPTIONS = [
  ["frontendBranch", "frontend-branch"],
  ["backend", "backend"],
  ["certificate", "certificate"],
] as const;
const ACCOUNT_PATTERN = /^\d{12}$/;
// <region>_<id>, e.g. us-east-1_AbCd12345
const USER_POOL_ID_PATTERN = /^([a-z0-9-]+)_[0-9a-zA-Z]+$/;
// Cognito provider names are at most 32 characters, without spaces or underscores.
const IDENTITY_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/;

/**
 * Reads a boolean context value. `-c name=true` arrives as the string
 * "true", while cdk.json can hold a real boolean, so both are accepted.
 */
export function booleanContext(
  name: string,
  value: unknown,
): boolean | undefined {
  if (value === undefined || value === true || value === false) {
    return value;
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new Error(`Invalid ${name} "${value}": use true or false`);
}

/** Reads the options from CDK context, given a lookup such as `tryGetContext`. */
export function optionsFromContext(
  context: (key: string) => unknown,
): AppOptions {
  const str = (key: string) => {
    const value = context(key);
    return value === undefined ? undefined : String(value);
  };
  return {
    backendEnv: str("backend-env"),
    awsAccountId: str("aws-account-id"),
    production: booleanContext("production", context("production")),
    frontendBranch: str("frontend-branch"),
    backend: str("backend"),
    userPoolId: str("user-pool-id"),
    identityProvider: str("identity-provider"),
    certificate: str("certificate"),
  };
}

/** Validates the options and names the environment's Data, Api and Auth stacks. */
export function planApp(options: AppOptions): AppPlan {
  for (const [field, option] of FRONTEND_OPTIONS) {
    if (options[field] !== undefined) {
      throw new Error(
        `-c ${option} is no longer supported: the CDK app deploys only backends. ` +
          "Deploy a frontend with npm run frontend:deploy -- --backend-env <env> --branch <branch>",
      );
    }
  }
  const production = options.production ?? false;
  const config = resolveEnvironment(options.backendEnv, production);
  if (options.awsAccountId === undefined) {
    throw new Error(
      "Missing CDK context: pass -c aws-account-id=<AWS account ID>",
    );
  }
  if (!ACCOUNT_PATTERN.test(options.awsAccountId)) {
    throw new Error(
      `Invalid aws-account-id "${options.awsAccountId}": use a 12-digit AWS account ID`,
    );
  }
  if (
    options.identityProvider !== undefined &&
    !IDENTITY_PROVIDER_PATTERN.test(options.identityProvider)
  ) {
    throw new Error(
      `Invalid identity-provider "${options.identityProvider}": use the name of an identity provider on the user pool, such as VT-SSO-OIDC`,
    );
  }
  if (options.userPoolId === undefined) {
    throw new Error(
      "Missing CDK context: pass -c user-pool-id=<user pool ID>, the existing Cognito user pool for the environment's users",
    );
  }
  const region = USER_POOL_ID_PATTERN.exec(options.userPoolId)?.[1];
  if (region === undefined) {
    throw new Error(
      `Invalid user-pool-id "${options.userPoolId}": use a Cognito user pool ID, such as us-east-1_AbCd12345`,
    );
  }
  if (region !== config.region) {
    throw new Error(
      `Invalid user-pool-id "${options.userPoolId}": the pool must be in ${config.region}, the environment's region`,
    );
  }
  const prefix = `DlpAccessNext-${config.name}`;
  return {
    config,
    awsAccountId: options.awsAccountId,
    production,
    userPoolId: options.userPoolId,
    identityProvider: options.identityProvider,
    dataStackName: `${prefix}-Data`,
    apiStackName: `${prefix}-Api`,
    authStackName: `${prefix}-Auth`,
  };
}

/** Adds the stacks that `planApp` works out to the app. */
export function buildApp(app: App, options: AppOptions): AppStacks {
  const plan = planApp(options);
  const { config } = plan;
  const env = { account: plan.awsAccountId, region: config.region };
  const data = new DataStack(app, plan.dataStackName, { env, config });
  const api = new ApiStack(app, plan.apiStackName, {
    env,
    config,
    tables: data.tables,
    searchDomain: data.searchDomain,
  });
  const auth = new AuthStack(app, plan.authStackName, {
    env,
    config,
    userPoolId: plan.userPoolId,
    identityProvider: plan.identityProvider,
  });
  return { data, api, auth };
}
