import { awsJson, CommandError, CommandRunner } from "../command-runner";
import { FRONTEND_APPLICATION } from "../config/web";
import { FrontendNames, FrontendPlan } from "./frontend";

/** The environment tag recording the full branch name the frontend is for. */
export const BRANCH_TAG = "dlpnext:branch";
/** The environment tag recording the backend environment the frontend uses. */
export const BACKEND_ENV_TAG = "dlpnext:backend-env";

/** Times an `aws elasticbeanstalk wait` (about 7 minutes each) is tried. */
const MAX_WAITS = 4;

/** The fields of a Beanstalk environment the tooling reads. */
export interface Environment {
  readonly EnvironmentArn: string;
  readonly Status: string;
  readonly Health: string;
  /** The Beanstalk endpoint, `<CNAME prefix>.<region>.elasticbeanstalk.com`. */
  readonly CNAME: string;
  /** The application version running, absent while none is. */
  readonly VersionLabel?: string;
}

/** The plan's environment, leaving out terminated ones with its name. */
export function describeEnvironment(
  plan: Pick<FrontendNames, "environmentName">,
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

/** The environment's tags, by key. */
export function readTags(
  environment: Environment,
  run: CommandRunner,
): Map<string, string> {
  return new Map(
    (
      awsJson(run, [
        "elasticbeanstalk",
        "list-tags-for-resource",
        "--resource-arn",
        environment.EnvironmentArn,
      ]).ResourceTags as { Key: string; Value: string }[]
    ).map(({ Key, Value }) => [Key, Value]),
  );
}

/** An `aws elasticbeanstalk wait` waiter, and what it waits through. */
export interface Waiter {
  /** The waiter's name, then any arguments after the environment's. */
  readonly command: readonly string[];
  /** The status the environment stays in while there is more to wait for. */
  readonly pendingStatus: string;
  /** What the environment fails to do when the wait gives up, for the error. */
  readonly goal: string;
}

export const LAUNCHED: Waiter = {
  // A terminated environment with the same name never becomes Ready.
  command: ["environment-exists", "--no-include-deleted"],
  pendingStatus: "Launching",
  goal: "become ready",
};

export const UPDATED: Waiter = {
  command: ["environment-updated", "--no-include-deleted"],
  pendingStatus: "Updating",
  goal: "finish updating",
};

export const TERMINATED: Waiter = {
  // Deleted environments stay in: the waiter needs to see this one as
  // Terminated, and never succeeds on an empty list.
  command: ["environment-terminated"],
  pendingStatus: "Terminating",
  goal: "terminate",
};

/**
 * Runs the waiter until it succeeds, again while the environment is still in
 * the waiter's pending status, up to `MAX_WAITS` times. An environment gone
 * from the list ends the wait: there is nothing left to wait for, and the
 * caller reads what it needs next.
 */
export function waitForEnvironment(
  plan: FrontendPlan,
  waiter: Waiter,
  run: CommandRunner,
): void {
  const [name, ...rest] = waiter.command;
  for (let attempt = 1; ; attempt++) {
    try {
      run("aws", [
        "elasticbeanstalk",
        "wait",
        name,
        "--application-name",
        FRONTEND_APPLICATION,
        "--environment-names",
        plan.environmentName,
        ...rest,
      ]);
      return;
    } catch (error) {
      if (!(error instanceof CommandError)) {
        throw error;
      }
      // The waiter gives up while the environment is still pending.
      const status = describeEnvironment(plan, run)?.Status;
      if (status === undefined) {
        return;
      }
      if (status !== waiter.pendingStatus || attempt === MAX_WAITS) {
        throw new Error(
          `${plan.environmentName} did not ${waiter.goal} (status ${status}): ${error.message}` +
            `\nCheck its events with: eb events ${plan.environmentName}`,
        );
      }
    }
  }
}
