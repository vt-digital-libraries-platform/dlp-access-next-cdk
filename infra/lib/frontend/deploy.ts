import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { awsJson, CommandError, CommandRunner } from "../command-runner";
import {
  ebInstanceProfileName,
  ebServiceRoleArnParameterName,
  graphqlApiUrlParameterName,
  identityProviderParameterName,
  userPoolIdParameterName,
} from "../config/environments";
import {
  CALLBACK_PATH,
  FRONTEND_APPLICATION,
  HOSTED_ZONE,
  LOCAL_ORIGIN,
  SOLUTION_STACK,
} from "../config/web";
import { ensureApplication, FrontendPlan } from "./frontend";

/** The environment tag recording the full branch name the frontend is for. */
export const BRANCH_TAG = "dlpnext:branch";
/** The environment tag recording the backend environment the frontend uses. */
export const BACKEND_ENV_TAG = "dlpnext:backend-env";

/** Times `aws elasticbeanstalk wait environment-exists` (about 7 minutes each) is tried. */
const MAX_WAITS = 4;

/** What the frontend needs from its backend, read from the backend's SSM parameters. */
interface Backend {
  readonly apiUrl: string;
  readonly userPoolId: string;
  readonly identityProvider: string;
  readonly serviceRoleArn: string;
  readonly instanceProfile: string;
}

interface Client {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Deploys the commit to the plan's frontend. A branch without a frontend gets
 * one end to end: Cognito client, secret, Beanstalk environment and DNS
 * record. Everything is read, and every refusal made, before anything changes.
 */
export function deployFrontend(
  plan: FrontendPlan,
  commit: string,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  const existing = describeEnvironment(plan, run);
  if (existing) {
    ensureApplication(plan, run);
    log(
      `The ${plan.environmentName} environment exists; deploying to it isn't implemented yet.`,
    );
    return;
  }

  const backend = readBackend(plan, run);
  const clientId = findClient(plan, backend, run);
  const hostedZoneId = findHostedZone(run);

  ensureApplication(plan, run);
  let client: Client;
  if (clientId === undefined) {
    client = createClient(plan, backend, run);
    log(`Created Cognito client ${client.clientId}.`);
  } else {
    client = readClient(backend, clientId, run);
    log(`Reusing Cognito client ${client.clientId}.`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlpnext-deploy-"));
  try {
    const secretArn = writeSecret(plan, client, workDir, run);
    const label = ensureVersion(plan, commit, workDir, run);
    log(`Creating ${plan.environmentName} from ${label}...`);
    createEnvironment(plan, backend, client, secretArn, label, run);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const environment = waitForEnvironment(plan, run);
  upsertRecord(plan, hostedZoneId, environment.CNAME, run);
  log(
    `${plan.environmentName} is ${environment.Status} (health ${environment.Health}) at ${environment.CNAME}.\n` +
      `${plan.appUrl} points at it.`,
  );
}

/** The version label for a commit, `<slug>-<short SHA>`. */
export function versionLabel(plan: FrontendPlan, commit: string): string {
  return `${plan.slug}-${commit.slice(0, 7)}`;
}

/** The fields of a Beanstalk environment the tooling reads. */
interface Environment {
  readonly Status: string;
  readonly Health: string;
  /** The Beanstalk endpoint, `<CNAME prefix>.<region>.elasticbeanstalk.com`. */
  readonly CNAME: string;
}

function describeEnvironment(
  plan: FrontendPlan,
  run: CommandRunner,
): Environment | undefined {
  const [environment] = awsJson(run, [
    "elasticbeanstalk",
    "describe-environments",
    "--application-name",
    FRONTEND_APPLICATION,
    "--environment-names",
    plan.environmentName,
    "--no-include-deleted",
  ]).Environments;
  return environment;
}

function parameter(run: CommandRunner, name: string): string {
  return awsJson(run, ["ssm", "get-parameter", "--name", name]).Parameter
    .Value as string;
}

function readBackend(plan: FrontendPlan, run: CommandRunner): Backend {
  const env = plan.backendEnv;
  return {
    apiUrl: parameter(run, graphqlApiUrlParameterName(env)),
    userPoolId: parameter(run, userPoolIdParameterName(env)),
    identityProvider: parameter(run, identityProviderParameterName(env)),
    serviceRoleArn: parameter(run, ebServiceRoleArnParameterName(env)),
    // A fixed name, owned by the backend's Api stack.
    instanceProfile: ebInstanceProfileName(env),
  };
}

/**
 * The ID of the client named after the environment on the backend's pool, if
 * there is one. Cognito allows duplicate names, so more than one is refused.
 */
function findClient(
  plan: FrontendPlan,
  backend: Backend,
  run: CommandRunner,
): string | undefined {
  const matches = (
    awsJson(run, [
      "cognito-idp",
      "list-user-pool-clients",
      "--user-pool-id",
      // No --max-results: passing it turns off the CLI's pagination, and
      // every page is needed to spot a duplicate.
      backend.userPoolId,
    ]).UserPoolClients as { ClientId: string; ClientName: string }[]
  ).filter(({ ClientName }) => ClientName === plan.environmentName);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} Cognito clients on user pool ${backend.userPoolId} are named ${plan.environmentName} ` +
        `(${matches.map(({ ClientId }) => ClientId).join(", ")}): delete all but one, then deploy again`,
    );
  }
  return matches[0]?.ClientId;
}

/** The ID of the public hosted zone the branch's record goes in. */
function findHostedZone(run: CommandRunner): string {
  const zones = (
    awsJson(run, [
      "route53",
      "list-hosted-zones-by-name",
      "--dns-name",
      HOSTED_ZONE,
    ]).HostedZones as {
      Id: string;
      Name: string;
      Config?: { PrivateZone?: boolean };
    }[]
  ).filter(
    ({ Name, Config }) => Name === `${HOSTED_ZONE}.` && !Config?.PrivateZone,
  );
  if (zones.length !== 1) {
    throw new Error(
      `Expected one public hosted zone named ${HOSTED_ZONE}, found ${zones.length}`,
    );
  }
  return zones[0].Id.replace(/^\/hostedzone\//, "");
}

/**
 * A confidential client for the authorization code flow, as src/lib/auth.ts
 * expects, signing in only through the backend's identity provider. No
 * explicit auth flows are passed, as the CDK Web stack did, so Cognito
 * applies its defaults.
 */
function createClient(
  plan: FrontendPlan,
  backend: Backend,
  run: CommandRunner,
): Client {
  const origins = [plan.appUrl, LOCAL_ORIGIN];
  const { ClientId, ClientSecret } = awsJson(run, [
    "cognito-idp",
    "create-user-pool-client",
    "--user-pool-id",
    backend.userPoolId,
    "--client-name",
    plan.environmentName,
    "--generate-secret",
    "--allowed-o-auth-flows-user-pool-client",
    "--allowed-o-auth-flows",
    "code",
    "--allowed-o-auth-scopes",
    "openid",
    "email",
    "--supported-identity-providers",
    backend.identityProvider,
    "--callback-urls",
    ...origins.map((origin) => `${origin}${CALLBACK_PATH}`),
    "--logout-urls",
    ...origins.map((origin) => `${origin}/`),
  ]).UserPoolClient;
  return { clientId: ClientId, clientSecret: ClientSecret };
}

function readClient(
  backend: Backend,
  clientId: string,
  run: CommandRunner,
): Client {
  const { ClientSecret } = awsJson(run, [
    "cognito-idp",
    "describe-user-pool-client",
    "--user-pool-id",
    backend.userPoolId,
    "--client-id",
    clientId,
  ]).UserPoolClient;
  return { clientId, clientSecret: ClientSecret };
}

/**
 * Creates or updates the secret holding the client secret, and returns its
 * ARN. The value goes through a file readable only by the user, never on a
 * command line.
 */
function writeSecret(
  plan: FrontendPlan,
  client: Client,
  workDir: string,
  run: CommandRunner,
): string {
  const valueFile = path.join(workDir, "client-secret");
  fs.writeFileSync(valueFile, client.clientSecret, { mode: 0o600 });
  const secretString = `file://${valueFile}`;
  // The name filter matches prefixes, so the exact name is checked here.
  const exists = (
    awsJson(run, [
      "secretsmanager",
      "list-secrets",
      "--filters",
      `Key=name,Values=${plan.secretName}`,
    ]).SecretList as { Name: string }[]
  ).some(({ Name }) => Name === plan.secretName);
  try {
    return awsJson(
      run,
      exists
        ? [
            "secretsmanager",
            "put-secret-value",
            "--secret-id",
            plan.secretName,
            "--secret-string",
            secretString,
          ]
        : [
            "secretsmanager",
            "create-secret",
            "--name",
            plan.secretName,
            "--description",
            `Cognito app client secret for ${plan.environmentName}`,
            "--secret-string",
            secretString,
          ],
    ).ARN as string;
  } finally {
    fs.rmSync(valueFile, { force: true });
  }
}

/**
 * Makes sure the application has the commit's version and returns its label.
 * The bundle is `git archive` of the commit, which leaves out the paths
 * marked export-ignore, as `eb deploy` ships it.
 */
function ensureVersion(
  plan: FrontendPlan,
  commit: string,
  workDir: string,
  run: CommandRunner,
): string {
  const label = versionLabel(plan, commit);
  const [existing] = awsJson(run, [
    "elasticbeanstalk",
    "describe-application-versions",
    "--application-name",
    FRONTEND_APPLICATION,
    "--version-labels",
    label,
  ]).ApplicationVersions;
  if (existing) {
    return label;
  }
  const bundle = path.join(workDir, `${label}.zip`);
  run("git", ["archive", "--format=zip", `--output=${bundle}`, commit]);
  const bucket = awsJson(run, ["elasticbeanstalk", "create-storage-location"])
    .S3Bucket as string;
  const key = `${FRONTEND_APPLICATION}/${label}.zip`;
  run("aws", ["s3", "cp", bundle, `s3://${bucket}/${key}`]);
  run("aws", [
    "elasticbeanstalk",
    "create-application-version",
    "--application-name",
    FRONTEND_APPLICATION,
    "--version-label",
    label,
    "--description",
    `commit ${commit} of ${plan.branch}`,
    "--source-bundle",
    `S3Bucket=${bucket},S3Key=${key}`,
  ]);
  return label;
}

/**
 * The option settings set when an environment is created: only the ones that
 * vary by branch or backend. Settings every frontend shares live in
 * `.ebextensions`, and must never be set here: a directly applied setting
 * takes precedence over `.ebextensions` and would freeze that option.
 */
function dynamicSettings(
  plan: FrontendPlan,
  backend: Backend,
  client: Client,
  secretArn: string,
): { Namespace: string; OptionName: string; Value: string }[] {
  const settings: [string, string, string][] = [
    // Beanstalk picks the load balancer only from settings passed when the
    // environment is created and ignores these in .ebextensions, defaulting
    // to a classic load balancer. They can't change afterwards anyway.
    ["aws:elasticbeanstalk:environment", "EnvironmentType", "LoadBalanced"],
    ["aws:elasticbeanstalk:environment", "LoadBalancerType", "application"],
    ["aws:elbv2:listener:443", "SSLCertificateArns", plan.certificate],
    [
      "aws:autoscaling:launchconfiguration",
      "IamInstanceProfile",
      backend.instanceProfile,
    ],
    ["aws:elasticbeanstalk:environment", "ServiceRole", backend.serviceRoleArn],
    ["aws:ec2:instances", "InstanceTypes", plan.instanceType],
    ...Object.entries({
      APPSYNC_API_URL: backend.apiUrl,
      AWS_REGION: plan.region,
      COGNITO_ISSUER: `https://cognito-idp.${plan.region}.amazonaws.com/${backend.userPoolId}`,
      COGNITO_CLIENT_ID: client.clientId,
      COGNITO_IDENTITY_PROVIDER: backend.identityProvider,
      // The origin the browser uses; the server only sees the proxy's.
      APP_BASE_URL: plan.appUrl,
    }).map(([name, value]): [string, string, string] => [
      "aws:elasticbeanstalk:application:environment",
      name,
      value,
    ]),
    // Beanstalk reads the secret with the instance role and hands it to the
    // app as an environment variable, so it never appears in plain text.
    [
      "aws:elasticbeanstalk:application:environmentsecrets",
      "COGNITO_CLIENT_SECRET",
      secretArn,
    ],
  ];
  return settings.map(([Namespace, OptionName, Value]) => ({
    Namespace,
    OptionName,
    Value,
  }));
}

function createEnvironment(
  plan: FrontendPlan,
  backend: Backend,
  client: Client,
  secretArn: string,
  label: string,
  run: CommandRunner,
): void {
  run("aws", [
    "elasticbeanstalk",
    "create-environment",
    "--application-name",
    FRONTEND_APPLICATION,
    "--environment-name",
    plan.environmentName,
    // Makes the Beanstalk endpoint predictable.
    "--cname-prefix",
    plan.environmentName,
    "--version-label",
    label,
    "--solution-stack-name",
    SOLUTION_STACK,
    "--tags",
    JSON.stringify([
      { Key: BRANCH_TAG, Value: plan.branch },
      { Key: BACKEND_ENV_TAG, Value: plan.backendEnv },
    ]),
    "--option-settings",
    JSON.stringify(dynamicSettings(plan, backend, client, secretArn)),
  ]);
}

/** Waits until the new environment is Ready and returns it. */
function waitForEnvironment(
  plan: FrontendPlan,
  run: CommandRunner,
): Environment {
  for (let attempt = 1; ; attempt++) {
    try {
      run("aws", [
        "elasticbeanstalk",
        "wait",
        "environment-exists",
        "--application-name",
        FRONTEND_APPLICATION,
        "--environment-names",
        plan.environmentName,
        // A terminated environment with the same name never becomes Ready.
        "--no-include-deleted",
      ]);
      const environment = describeEnvironment(plan, run);
      if (environment) {
        return environment;
      }
      throw new Error(`${plan.environmentName} disappeared while launching`);
    } catch (error) {
      if (!(error instanceof CommandError)) {
        throw error;
      }
      // The waiter gives up while the environment is still launching.
      const status = describeEnvironment(plan, run)?.Status;
      if (status !== "Launching" || attempt === MAX_WAITS) {
        throw new Error(
          `${plan.environmentName} did not become ready (status ${status ?? "gone"}): ${error.message}` +
            `\nCheck its events with: eb events ${plan.environmentName}`,
        );
      }
    }
  }
}

/** Points the branch's domain name at the environment's Beanstalk endpoint. */
function upsertRecord(
  plan: FrontendPlan,
  hostedZoneId: string,
  endpoint: string,
  run: CommandRunner,
): void {
  run("aws", [
    "route53",
    "change-resource-record-sets",
    "--hosted-zone-id",
    hostedZoneId,
    "--change-batch",
    JSON.stringify({
      Changes: [
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: plan.domainName,
            Type: "CNAME",
            TTL: 300,
            ResourceRecords: [{ Value: endpoint }],
          },
        },
      ],
    }),
  ]);
}
