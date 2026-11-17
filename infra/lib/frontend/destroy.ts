import { awsJson, CommandError, CommandRunner } from "../command-runner";
import { userPoolIdParameterName } from "../config/environments";
import { FRONTEND_APPLICATION } from "../config/web";
import {
  BACKEND_ENV_TAG,
  describeEnvironment,
  Environment,
  findHostedZone,
  parameter,
  readTags,
} from "./deploy";
import { FrontendPlan } from "./frontend";

/** Times `aws elasticbeanstalk wait environment-terminated` (about 7 minutes each) is tried. */
const MAX_WAITS = 4;

/**
 * Removes everything the plan's frontend owns, in order: the Beanstalk
 * environment, the CNAME, the Cognito client and the secret. Each step skips
 * what is already gone, so a re-run after a failure, or on a half-created
 * frontend, finishes the job. Application versions are left to the lifecycle
 * policy; the backend and its user pool are never touched.
 */
export function destroyFrontend(
  plan: FrontendPlan,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  const environment = describeEnvironment(plan, run);
  if (environment) {
    checkBackend(plan, environment, run);
  }
  const hostedZoneId = findHostedZone(run);
  const userPoolId = parameter(run, userPoolIdParameterName(plan.backendEnv));

  terminateEnvironment(plan, environment, run, log);
  deleteRecord(plan, hostedZoneId, run, log);
  deleteClients(plan, userPoolId, run, log);
  deleteSecret(plan, run, log);
}

/**
 * Refuses an environment tagged for another backend: its Cognito client is
 * on that backend's pool, and would be left behind. A different branch tag
 * is fine: it shares the slug, so this is the frontend that is in the way.
 */
function checkBackend(
  plan: FrontendPlan,
  environment: Environment,
  run: CommandRunner,
): void {
  const backendEnv = readTags(environment, run).get(BACKEND_ENV_TAG);
  if (backendEnv !== undefined && backendEnv !== plan.backendEnv) {
    throw new Error(
      `${plan.environmentName} uses backend env ${JSON.stringify(backendEnv)}, not ${JSON.stringify(plan.backendEnv)}, ` +
        `and its Cognito client is on that backend's user pool.\nDestroy it with --backend-env ${backendEnv}.`,
    );
  }
}

function terminateEnvironment(
  plan: FrontendPlan,
  environment: Environment | undefined,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  if (!environment) {
    log(`${plan.environmentName} is already gone.`);
    return;
  }
  // A re-run while it is still terminating only waits.
  if (environment.Status !== "Terminating") {
    log(`Terminating ${plan.environmentName}...`);
    run("aws", [
      "elasticbeanstalk",
      "terminate-environment",
      "--environment-name",
      plan.environmentName,
    ]);
  }
  waitForTermination(plan, run);
  log(`Terminated ${plan.environmentName}.`);
}

function waitForTermination(plan: FrontendPlan, run: CommandRunner): void {
  for (let attempt = 1; ; attempt++) {
    try {
      run("aws", [
        "elasticbeanstalk",
        "wait",
        "environment-terminated",
        "--application-name",
        FRONTEND_APPLICATION,
        "--environment-names",
        plan.environmentName,
        // Deleted environments stay in: the waiter needs to see this one as
        // Terminated, and never succeeds on an empty list.
      ]);
      return;
    } catch (error) {
      if (!(error instanceof CommandError)) {
        throw error;
      }
      // The waiter gives up while the environment is still terminating.
      const status = describeEnvironment(plan, run)?.Status;
      if (status === undefined) {
        return;
      }
      if (status !== "Terminating" || attempt === MAX_WAITS) {
        throw new Error(
          `${plan.environmentName} did not terminate (status ${status}): ${error.message}` +
            `\nCheck its events with: eb events ${plan.environmentName}`,
        );
      }
    }
  }
}

interface ResourceRecordSet {
  readonly Name: string;
  readonly Type: string;
}

function deleteRecord(
  plan: FrontendPlan,
  hostedZoneId: string,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  // Records are listed in order from the start name on, so the first one is
  // the branch's CNAME only if it exists.
  const [first] = awsJson(run, [
    "route53",
    "list-resource-record-sets",
    "--hosted-zone-id",
    hostedZoneId,
    "--start-record-name",
    plan.domainName,
    "--start-record-type",
    "CNAME",
    "--max-items",
    "1",
  ]).ResourceRecordSets as ResourceRecordSet[];
  if (first?.Name !== `${plan.domainName}.` || first.Type !== "CNAME") {
    log(`The CNAME for ${plan.domainName} is already gone.`);
    return;
  }
  // A DELETE has to match the record exactly, so it is passed as read.
  run("aws", [
    "route53",
    "change-resource-record-sets",
    "--hosted-zone-id",
    hostedZoneId,
    "--change-batch",
    JSON.stringify({
      Changes: [{ Action: "DELETE", ResourceRecordSet: first }],
    }),
  ]);
  log(`Deleted the CNAME for ${plan.domainName}.`);
}

/**
 * Deletes every client named after the environment on the backend's pool:
 * Cognito allows duplicate names, and they are all this frontend's.
 */
function deleteClients(
  plan: FrontendPlan,
  userPoolId: string,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  const clients = (
    awsJson(run, [
      "cognito-idp",
      "list-user-pool-clients",
      "--user-pool-id",
      // No --max-results: passing it turns off the CLI's pagination.
      userPoolId,
    ]).UserPoolClients as { ClientId: string; ClientName: string }[]
  ).filter(({ ClientName }) => ClientName === plan.environmentName);
  if (clients.length === 0) {
    log(`The Cognito client ${plan.environmentName} is already gone.`);
    return;
  }
  for (const { ClientId } of clients) {
    run("aws", [
      "cognito-idp",
      "delete-user-pool-client",
      "--user-pool-id",
      userPoolId,
      "--client-id",
      ClientId,
    ]);
    log(`Deleted Cognito client ${ClientId}.`);
  }
}

/**
 * Deletes the secret without a recovery window, so its name is free for the
 * next deploy straight away. A secret already scheduled for deletion holds
 * the name too, so it is found and deleted the same way.
 */
function deleteSecret(
  plan: FrontendPlan,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  // The name filter matches prefixes, so the exact name is checked here.
  const exists = (
    awsJson(run, [
      "secretsmanager",
      "list-secrets",
      "--include-planned-deletion",
      "--filters",
      `Key=name,Values=${plan.secretName}`,
    ]).SecretList as { Name: string }[]
  ).some(({ Name }) => Name === plan.secretName);
  if (!exists) {
    log(`The secret ${plan.secretName} is already gone.`);
    return;
  }
  run("aws", [
    "secretsmanager",
    "delete-secret",
    "--secret-id",
    plan.secretName,
    "--force-delete-without-recovery",
  ]);
  log(`Deleted the secret ${plan.secretName}.`);
}
