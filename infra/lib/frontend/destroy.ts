import { awsJson, CommandRunner } from "../command-runner";
import { userPoolIdParameterName } from "../config/environments";
import {
  BACKEND_ENV_TAG,
  describeEnvironment,
  Environment,
  LAUNCHED,
  readTags,
  TERMINATED,
  UPDATED,
  waitForEnvironment,
  Waiter,
} from "./environment";
import { FrontendPlan } from "./frontend";
import { findHostedZone, findSecret, readParameter } from "./lookups";

/** The waiters for an environment busy with something terminating has to wait for. */
const SETTLING: Readonly<Record<string, Waiter>> = {
  Launching: LAUNCHED,
  Updating: UPDATED,
};

/**
 * Removes everything the plan's frontend owns, in order: the Beanstalk
 * environment, the CNAME, the Cognito client and the secret. Each step skips
 * what is already gone, so a re-run after a failure, or on a half-created
 * frontend, finishes the job. Application versions are left to the lifecycle
 * policy; the backend and its user pool are never touched. Each step looks up
 * what it needs only when it runs, so a step that can't, e.g. with the
 * backend gone, leaves the steps before it done.
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

  terminateEnvironment(plan, environment, run, log);
  deleteRecord(plan, findHostedZone(run), run, log);
  deleteClients(
    plan,
    readParameter(run, userPoolIdParameterName(plan.backendEnv)),
    run,
    log,
  );
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

/**
 * Terminates the environment and waits until it is gone. One still launching
 * or updating is waited for first, since Beanstalk rejects a terminate while
 * another operation runs; a re-run while it is terminating only waits.
 */
function terminateEnvironment(
  plan: FrontendPlan,
  found: Environment | undefined,
  run: CommandRunner,
  log: (text: string) => void,
): void {
  let environment = found;
  const settling = environment && SETTLING[environment.Status];
  if (settling) {
    log(`Waiting for ${plan.environmentName} to ${settling.goal}...`);
    waitForEnvironment(plan, settling, run);
    environment = describeEnvironment(plan, run);
  }
  if (!environment) {
    log(`${plan.environmentName} is already gone.`);
    return;
  }
  if (environment.Status !== TERMINATED.pendingStatus) {
    log(`Terminating ${plan.environmentName}...`);
    run("aws", [
      "elasticbeanstalk",
      "terminate-environment",
      "--environment-name",
      plan.environmentName,
    ]);
  }
  waitForEnvironment(plan, TERMINATED, run);
  log(`Terminated ${plan.environmentName}.`);
}

interface ResourceRecordSet {
  readonly Name: string;
  readonly Type: string;
}

/** Deletes the CNAME pointing the branch's domain name at the environment. */
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
  // No --max-results: passing it turns off the CLI's pagination.
  const clients = (
    awsJson(run, [
      "cognito-idp",
      "list-user-pool-clients",
      "--user-pool-id",
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
  if (findSecret(plan, run) === "absent") {
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
