import { parseArgs } from "util";
import { awsJson, CommandRunner, RunnerOptions } from "../command-runner";
import {
  checkYesInCi,
  isConfirmed,
  productionWarningFor,
} from "../deployment/deploy-cli";
import { deployFrontend } from "./deploy";
import { requireBackend, FrontendPlan, planFrontend } from "./frontend";

/** Everything `frontend:deploy` does outside the process. Tests replace it. */
export interface FrontendIO {
  /** Makes the runner for the backend's region and the chosen profile. */
  readonly runner: (options: RunnerOptions) => CommandRunner;
  /** Asks a question and returns the answer; an empty answer when there is none. */
  readonly ask: (question: string) => Promise<string>;
  readonly log: (text: string) => void;
  /** Highlights a warning, e.g. bold red on a terminal. */
  readonly alert: (text: string) => string;
}

/**
 * `frontend:deploy`: plans the frontend, confirms, and deploys the commit at
 * HEAD, creating the frontend if the branch has none. Returns the exit code.
 */
export async function frontendDeploy(
  argv: readonly string[],
  ci: string | undefined,
  io: FrontendIO,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "backend-env": { type: "string" },
      branch: { type: "string" },
      production: { type: "boolean" },
      certificate: { type: "string" },
      profile: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
    strict: true,
    allowPositionals: false,
  });
  const yes = values.yes ?? false;
  if (yes) {
    checkYesInCi(ci);
  }
  const backend = requireBackend(values["backend-env"]);
  const run = io.runner({ region: backend.region, profile: values.profile });

  const branch = values.branch ?? currentBranch(run);
  const plan = planFrontend({
    backendEnv: backend.name,
    branch,
    production: values.production,
    certificate: values.certificate,
    awsAccountId: awsJson(run, ["sts", "get-caller-identity"])
      .Account as string,
  });

  const { alert } = io;
  const warning = productionWarningFor(
    plan.backendEnv,
    plan.awsAccountId,
    plan.production,
    "--production",
  );
  if (warning) {
    io.log(`${alert(warning)}\n`);
  }
  io.log(`About to deploy a frontend:\n\n${describeFrontendPlan(plan)}\n`);
  // Only the commit is deployed, so local edits are left out.
  const commit = run("git", ["rev-parse", "--verify", "HEAD"]).trim();
  io.log(`App source: commit ${commit}\n`);
  const changes = run("git", ["status", "--porcelain"])
    .split("\n")
    .filter(Boolean);
  if (changes.length > 0) {
    io.log(
      `${alert("Uncommitted changes are not deployed:")}\n${changes.map((line) => `  ${line}`).join("\n")}\n`,
    );
  }

  if (yes) {
    io.log("Confirmed by --yes (CI).");
  } else {
    const question = warning
      ? alert('Deploy to PRODUCTION? Type "yes" or "y" to continue: ')
      : 'Deploy? Type "yes" or "y" to continue: ';
    if (!isConfirmed(await io.ask(question))) {
      io.log("Not deployed.");
      return 1;
    }
  }

  deployFrontend(plan, commit, run, io.log);
  return 0;
}

function currentBranch(run: CommandRunner): string {
  const branch = run("git", ["branch", "--show-current"]).trim();
  if (!branch) {
    throw new Error(
      "HEAD is not on a branch: pass --branch <name> for the frontend",
    );
  }
  return branch;
}

/** The confirmation text shown before deploying a frontend. */
export function describeFrontendPlan(plan: FrontendPlan): string {
  const rows: [string, string][] = [
    ["Branch", plan.branch],
    ["Backend env", plan.backendEnv],
    ["Account", plan.awsAccountId],
    ["Region", plan.region],
    ["Environment", plan.environmentName],
    ["Instance type", `${plan.instanceType} (production: ${plan.production})`],
    ["App URL", plan.appUrl],
    ["Certificate", plan.certificate],
    ["Client secret", plan.secretName],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)
    .join("\n");
}
