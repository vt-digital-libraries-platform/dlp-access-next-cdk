import { awsJson, CommandRunner } from "../command-runner";
import {
  EnvironmentConfig,
  ebServiceRoleArnParameterName,
  ebServiceRoleEnv,
  resolveEnvironment,
} from "../config/environments";
import {
  checkCertificateArn,
  defaultCertificateArn,
  FRONTEND_APPLICATION,
  FRONTEND_REGION,
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

/** The names a branch's frontend has, whatever backend it attaches to. */
export interface FrontendNames {
  readonly branch: string;
  readonly slug: string;
  /** The Beanstalk environment, `dlpnext-<slug>`. */
  readonly environmentName: string;
  readonly domainName: string;
  readonly appUrl: string;
  readonly secretName: string;
}

/** The validated options, with defaults applied, and the names they produce. */
export interface FrontendPlan extends FrontendNames {
  readonly backendEnv: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly production: boolean;
  readonly instanceType: string;
  readonly certificate: string;
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

/** Validates the branch name and works out its frontend's names. */
export function planFrontendNames(branch: string): FrontendNames {
  const slug = validBranchSlug(branch, "branch", "--branch <name>");
  checkTagValue(branch);
  const domainName = webDomainName(slug);
  return {
    branch,
    slug,
    environmentName: webResourceName(slug),
    domainName,
    appUrl: `https://${domainName}`,
    secretName: frontendSecretName(slug),
  };
}

/**
 * Refuses a backend outside FRONTEND_REGION: the shared Beanstalk application
 * lives there, and `frontend:status`, which has no backend env, looks only
 * there.
 */
export function checkFrontendRegion(
  backend: Pick<EnvironmentConfig, "name" | "region">,
): void {
  if (backend.region !== FRONTEND_REGION) {
    throw new Error(
      `Backend env "${backend.name}" is in ${backend.region}, but frontends can only attach to a backend in ${FRONTEND_REGION}, ` +
        `where the shared ${FRONTEND_APPLICATION} Beanstalk application is (FRONTEND_REGION in infra/lib/config/web.ts)`,
    );
  }
}

/** Validates the options and works out the frontend's names. */
export function planFrontend(options: FrontendOptions): FrontendPlan {
  const production = options.production ?? false;
  const config = requireBackend(options.backendEnv, production);
  checkFrontendRegion(config);
  const names = planFrontendNames(options.branch);
  if (options.certificate !== undefined) {
    checkCertificateArn(
      options.certificate,
      config.region,
      options.awsAccountId,
    );
  }
  return {
    ...names,
    backendEnv: config.name,
    region: config.region,
    awsAccountId: options.awsAccountId,
    production,
    instanceType: config.web.instanceType,
    certificate:
      options.certificate ??
      defaultCertificateArn(config.region, options.awsAccountId),
  };
}

/**
 * Writes the local EB CLI project config, `.elasticbeanstalk/config.yml`
 * (gitignored), that `eb deploy` needs, creating the application if it is
 * missing.
 */
export function initEbProject(solutionStack: string, run: CommandRunner): void {
  run("eb", ["init", FRONTEND_APPLICATION, "--platform", solutionStack]);
}

/** Application versions kept before the oldest are deleted. */
const MAX_APPLICATION_VERSIONS = 200;

/**
 * Makes sure the shared Beanstalk application and the local EB CLI project
 * config (`.elasticbeanstalk/config.yml`, gitignored) exist. `eb init` creates
 * the application when it is missing. The version lifecycle policy runs as
 * one backend's service role, so it is set to `serviceRoleArn`, the plan's
 * backend's role, when it is missing (a new application, or one whose first
 * run failed after `eb init`) or when its role's backend is gone, e.g. a
 * destroyed feature backend. A role whose backend still exists is kept, so
 * frontends on different backends don't take the policy from each other.
 */
export function ensureApplication(
  serviceRoleArn: string,
  solutionStack: string,
  run: CommandRunner,
): void {
  const [application] = awsJson(run, [
    "elasticbeanstalk",
    "describe-applications",
    "--application-names",
    FRONTEND_APPLICATION,
  ]).Applications;
  const lifecycle = application?.ResourceLifecycleConfig;
  const current: string | undefined =
    lifecycle?.VersionLifecycleConfig?.MaxCountRule?.Enabled === true
      ? lifecycle.ServiceRole
      : undefined;
  // Read before anything is created.
  const setPolicy =
    current === undefined ||
    (current !== serviceRoleArn && !serviceRoleInUse(current, run));
  initEbProject(solutionStack, run);
  if (setPolicy) {
    run("aws", [
      "elasticbeanstalk",
      "update-application-resource-lifecycle",
      "--application-name",
      FRONTEND_APPLICATION,
      "--resource-lifecycle-config",
      JSON.stringify({
        ServiceRole: serviceRoleArn,
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

/**
 * Whether the service role still belongs to a deployed backend: its backend
 * publishes the role's ARN in SSM until the backend is destroyed. A role not
 * named for a backend, e.g. one set by hand, is left alone.
 */
function serviceRoleInUse(roleArn: string, run: CommandRunner): boolean {
  const env = ebServiceRoleEnv(roleArn);
  if (env === undefined) {
    return true;
  }
  // get-parameters lists a missing name instead of failing on it.
  const [parameter] = awsJson(run, [
    "ssm",
    "get-parameters",
    "--names",
    ebServiceRoleArnParameterName(env),
  ]).Parameters as { Value: string }[];
  return parameter?.Value === roleArn;
}
