import { awsJson, CommandRunner } from "../command-runner";
import { HOSTED_ZONE } from "../config/web";
import { FrontendPlan } from "./frontend";

/** The value of an SSM parameter, e.g. one the backend publishes. */
export function readParameter(run: CommandRunner, name: string): string {
  return awsJson(run, ["ssm", "get-parameter", "--name", name]).Parameter
    .Value as string;
}

/** The ID of the public hosted zone the branch's record goes in. */
export function findHostedZone(run: CommandRunner): string {
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

/** Where the plan's secret is: absent, live, or scheduled for deletion. */
export type SecretState = "absent" | "live" | "deleting";

/**
 * Finds the plan's secret, including one scheduled for deletion: it still
 * holds the name, so a new secret can't take it until it is gone.
 */
export function findSecret(
  plan: FrontendPlan,
  run: CommandRunner,
): SecretState {
  // The name filter matches prefixes, so the exact name is checked here.
  const secret = (
    awsJson(run, [
      "secretsmanager",
      "list-secrets",
      "--include-planned-deletion",
      "--filters",
      `Key=name,Values=${plan.secretName}`,
    ]).SecretList as { Name: string; DeletedDate?: string }[]
  ).find(({ Name }) => Name === plan.secretName);
  if (!secret) {
    return "absent";
  }
  return secret.DeletedDate === undefined ? "live" : "deleting";
}
