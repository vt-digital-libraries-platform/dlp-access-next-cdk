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

/** The backend environment `--backend-env` names. */
export function frontendBackend(
  backendEnv: string | undefined,
  production = false,
): EnvironmentConfig {
  if (backendEnv === undefined) {
    throw new Error(
      "Missing --backend-env <env>: the backend environment the frontend attaches to",
    );
  }
  return resolveEnvironment(backendEnv, production);
}

/** Validates the options and works out the frontend's names. */
export function planFrontend(options: FrontendOptions): FrontendPlan {
  const production = options.production ?? false;
  const config = frontendBackend(options.backendEnv, production);
  const slug = validBranchSlug(options.branch, "branch", "--branch <name>");
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
 * the application when it is missing; a new application also gets a version
 * lifecycle policy, which needs a service role: the backend's.
 */
export function ensureApplication(
  plan: FrontendPlan,
  run: CommandRunner,
): void {
  const { Applications: applications } = awsJson(run, [
    "elasticbeanstalk",
    "describe-applications",
    "--application-names",
    FRONTEND_APPLICATION,
  ]);
  const isNew = applications.length === 0;
  // Read before anything is created, so a backend without a service role
  // fails cleanly.
  const serviceRole = isNew
    ? (awsJson(run, [
        "ssm",
        "get-parameter",
        "--name",
        ebServiceRoleArnParameterName(plan.backendEnv),
      ]).Parameter.Value as string)
    : undefined;
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
