import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { awsJson, CommandRunner } from "../command-runner";
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
  LOCAL_ORIGIN,
  SOLUTION_STACK,
} from "../config/web";
import {
  BACKEND_ENV_TAG,
  BRANCH_TAG,
  describeEnvironment,
  Environment,
  LAUNCHED,
  readTags,
  waitForEnvironment,
} from "./environment";
import { ensureApplication, FrontendPlan, initEbProject } from "./frontend";
import { findHostedZone, findSecret, readParameter } from "./lookups";

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
    redeploy(plan, existing, commit, run, log);
    return;
  }

  const backend = readBackend(plan, run);
  const clientId = findClient(plan, backend, run);
  const hostedZoneId = findHostedZone(run);
  const secretExists = checkSecret(plan, run);

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
    const secretArn = writeSecret(plan, client, secretExists, workDir, run);
    const label = ensureVersion(plan, commit, workDir, run);
    log(`Creating ${plan.environmentName} from ${label}...`);
    createEnvironment(plan, backend, client, secretArn, label, run);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  waitForEnvironment(plan, LAUNCHED, run);
  const environment = describeEnvironment(plan, run);
  if (!environment) {
    throw new Error(`${plan.environmentName} disappeared while launching`);
  }
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

/**
 * Pushes the commit to the branch's existing frontend with `eb deploy`, which
 * ships the committed HEAD. Nothing else changes: not the settings, the
 * Cognito client, the secret or DNS.
 */
function redeploy(
  plan: FrontendPlan,
  environment: Environment,
  commit: string,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  checkTags(plan, environment, run);
  // The application exists with its lifecycle policy, made by the first
  // deploy, so only the local EB CLI config may be missing, e.g. in a clone.
  initEbProject(run);
  const label = versionLabel(plan, commit);
  // A new label makes eb deploy create the version from HEAD; an existing
  // one, e.g. a commit deployed before, would fail as a duplicate.
  const reuseVersion = versionExists(label, run);
  log(
    `Deploying ${reuseVersion ? "the existing version " : ""}${label} to ${plan.environmentName}...`,
  );
  run("eb", [
    "deploy",
    plan.environmentName,
    reuseVersion ? "--version" : "--label",
    label,
  ]);
  const deployed = describeEnvironment(plan, run);
  if (!deployed) {
    throw new Error(`${plan.environmentName} disappeared while deploying`);
  }
  log(
    `${plan.environmentName} is running ${deployed.VersionLabel ?? "no version"} (${deployed.Status}, health ${deployed.Health}) at ${plan.appUrl}.`,
  );
}

/**
 * Refuses an environment whose tags don't match the request. A different
 * branch means two branch names share the slug; a different backend means
 * the frontend's Cognito client is on another backend's pool. There is no
 * override: the frontend has to be destroyed and recreated.
 */
function checkTags(
  plan: FrontendPlan,
  environment: Environment,
  run: CommandRunner,
): void {
  const tags = readTags(environment, run);
  const recreate = `Destroy the frontend and deploy again to recreate it for branch ${JSON.stringify(plan.branch)} on backend env ${JSON.stringify(plan.backendEnv)}.`;
  const missing = [BRANCH_TAG, BACKEND_ENV_TAG].filter((key) => !tags.has(key));
  if (missing.length > 0) {
    throw new Error(
      `${plan.environmentName} has no ${missing.join(" or ")} tag, so it can't be checked as the frontend for this branch and backend: ` +
        `it wasn't created by frontend:deploy.\n${recreate}`,
    );
  }
  const shown = (key: string) => JSON.stringify(tags.get(key));
  if (tags.get(BRANCH_TAG) !== plan.branch) {
    throw new Error(
      `${plan.environmentName} is the frontend for branch ${shown(BRANCH_TAG)}, not ${JSON.stringify(plan.branch)}: ` +
        `the two branch names share the slug ${plan.slug}.\n${recreate}`,
    );
  }
  if (tags.get(BACKEND_ENV_TAG) !== plan.backendEnv) {
    throw new Error(
      `${plan.environmentName} uses backend env ${shown(BACKEND_ENV_TAG)}, not ${JSON.stringify(plan.backendEnv)}, ` +
        `and its Cognito client is on that backend's user pool.\n${recreate}`,
    );
  }
}

function readBackend(plan: FrontendPlan, run: CommandRunner): Backend {
  const env = plan.backendEnv;
  return {
    apiUrl: readParameter(run, graphqlApiUrlParameterName(env)),
    userPoolId: readParameter(run, userPoolIdParameterName(env)),
    identityProvider: readParameter(run, identityProviderParameterName(env)),
    serviceRoleArn: readParameter(run, ebServiceRoleArnParameterName(env)),
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
  // No --max-results: passing it turns off the CLI's pagination, and every
  // page is needed to spot a duplicate.
  const matches = (
    awsJson(run, [
      "cognito-idp",
      "list-user-pool-clients",
      "--user-pool-id",
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

/**
 * A confidential client for the authorization code flow, as src/lib/auth.ts
 * expects, signing in only through the backend's identity provider. No
 * explicit auth flows are passed, so Cognito applies its defaults.
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

/** The existing client, with its secret. */
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
 * Whether the secret exists. One scheduled for deletion is refused, since it
 * holds the name: a destroy's force-delete finishes within seconds, and
 * anything else has to be restored or deleted by hand.
 */
function checkSecret(plan: FrontendPlan, run: CommandRunner): boolean {
  const state = findSecret(plan, run);
  if (state === "deleting") {
    throw new Error(
      `The secret ${plan.secretName} is scheduled for deletion, so a new one can't take its name.\n` +
        `If frontend:destroy just deleted it, deploy again in a minute. Otherwise restore it with: ` +
        `aws secretsmanager restore-secret --secret-id ${plan.secretName}`,
    );
  }
  return state === "live";
}

/**
 * Creates or updates the secret holding the client secret, and returns its
 * ARN. The value goes through a file readable only by the user, never on a
 * command line.
 */
function writeSecret(
  plan: FrontendPlan,
  client: Client,
  exists: boolean,
  workDir: string,
  run: CommandRunner,
): string {
  const valueFile = path.join(workDir, "client-secret");
  fs.writeFileSync(valueFile, client.clientSecret, { mode: 0o600 });
  const secretString = `file://${valueFile}`;
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

/** Whether the application already has the version. */
function versionExists(label: string, run: CommandRunner): boolean {
  return (
    awsJson(run, [
      "elasticbeanstalk",
      "describe-application-versions",
      "--application-name",
      FRONTEND_APPLICATION,
      "--version-labels",
      label,
    ]).ApplicationVersions.length > 0
  );
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
  if (versionExists(label, run)) {
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
