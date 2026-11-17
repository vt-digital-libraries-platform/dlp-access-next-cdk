import { awsJson, CommandRunner } from "../command-runner";
import {
  EnvironmentConfig,
  ebServiceRoleArnParameterName,
  resolveEnvironment,
} from "../config/environments";
import {
  checkCertificateArn,
  defaultCertificateArn,
  FRONTEND_APPLICATION,
  SOLUTION_STACK,
  frontendSecretName,
  validBranchSlug,
  webDomainName,
  webResourceName,
} from "../config/web";

export interface FrontendOptions {
  /** The backend environment the frontend attaches to. */
  readonly backendEnv?: string;
  /** The git branch the frontend is for. */
  readonly branch: string;
  /** The larger instance type. Defaults to false. */
  readonly production?: boolean;
  /** Overrides the default certificate's ARN. */
  readonly certificate?: string;
  /** The account the credentials belong to. */
  readonly awsAccountId: string;
}

/** The validated options, with defaults applied, and the names they produce. */
export interface FrontendPlan {
  readonly backendEnv: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly production: boolean;
  readonly instanceType: string;
  readonly branch: string;
  readonly slug: string;
  /** The Beanstalk environment, `dlpnext-<slug>`. */
  readonly environmentName: string;
  readonly domainName: string;
  readonly appUrl: string;
  readonly certificate: string;
  readonly secretName: string;
}

/** The backend environment `--backend-env` names; throws when it is missing or unknown. */
export function requireBackend(
  backendEnv: string | undefined,
  production = false,
): EnvironmentConfig {
  if (!backendEnv) {
    throw new Error(
      "Missing backend env: pass --backend-env <env>, the backend environment the frontend attaches to",
    );
  }
  return resolveEnvironment(backendEnv, production);
}

// The full branch name is the value of the environment's branch tag.
const TAG_VALUE = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]{0,256}$/u;

function checkTagValue(branch: string): void {
  if (!TAG_VALUE.test(branch)) {
    throw new Error(
      `Invalid branch ${JSON.stringify(branch)}: the environment is tagged with the branch name, which may only have letters, digits, spaces and _ . : / = + - @, at most 256 characters`,
    );
  }
}

/** Validates the options and works out the frontend's names. */
export function planFrontend(options: FrontendOptions): FrontendPlan {
  const production = options.production ?? false;
  const config = requireBackend(options.backendEnv, production);
  const slug = validBranchSlug(options.branch, "branch", "--branch <name>");
  checkTagValue(options.branch);
  if (options.certificate !== undefined) {
    checkCertificateArn(
      options.certificate,
      config.region,
      options.awsAccountId,
    );
  }
  const domainName = webDomainName(slug);
  return {
    backendEnv: config.name,
    region: config.region,
    awsAccountId: options.awsAccountId,
    production,
    instanceType: config.web.instanceType,
    branch: options.branch,
    slug,
    environmentName: webResourceName(slug),
    domainName,
    appUrl: `https://${domainName}`,
    certificate:
      options.certificate ??
      defaultCertificateArn(config.region, options.awsAccountId),
    secretName: frontendSecretName(slug),
  };
}

/** Application versions kept before the oldest are deleted. */
const MAX_APPLICATION_VERSIONS = 200;

/**
 * Makes sure the shared Beanstalk application and the local EB CLI project
 * config (`.elasticbeanstalk/config.yml`, gitignored) exist. `eb init` creates
 * the application when it is missing. An application without the version
 * lifecycle policy gets it: a new one, or one whose first run failed after
 * `eb init`. Setting the policy needs a service role: the backend's.
 */
export function ensureApplication(
  plan: FrontendPlan,
  run: CommandRunner,
): void {
  const [application] = awsJson(run, [
    "elasticbeanstalk",
    "describe-applications",
    "--application-names",
    FRONTEND_APPLICATION,
  ]).Applications;
  const hasPolicy =
    application?.ResourceLifecycleConfig?.VersionLifecycleConfig?.MaxCountRule
      ?.Enabled === true;
  // Read before anything is created, so a backend without a service role
  // fails cleanly.
  const serviceRole = hasPolicy
    ? undefined
    : (awsJson(run, [
        "ssm",
        "get-parameter",
        "--name",
        ebServiceRoleArnParameterName(plan.backendEnv),
      ]).Parameter.Value as string);
  run("eb", ["init", FRONTEND_APPLICATION, "--platform", SOLUTION_STACK]);
  if (serviceRole !== undefined) {
    run("aws", [
      "elasticbeanstalk",
      "update-application-resource-lifecycle",
      "--application-name",
      FRONTEND_APPLICATION,
      "--resource-lifecycle-config",
      JSON.stringify({
        ServiceRole: serviceRole,
        VersionLifecycleConfig: {
          MaxCountRule: {
            Enabled: true,
            MaxCount: MAX_APPLICATION_VERSIONS,
            DeleteSourceFromS3: true,
          },
        },
      }),
    ]);
  }
}
