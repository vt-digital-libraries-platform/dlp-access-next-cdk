import { parseArgs } from "util";
import { awsJson, CommandRunner, RunnerOptions } from "../command-runner";
import {
  checkYesInCi,
  isConfirmed,
  isProductionEnv,
  productionWarningFor,
} from "../deployment/deploy-cli";
import { deployFrontend } from "./deploy";
import { destroyFrontend } from "./destroy";
import { requireBackend, FrontendPlan, planFrontend } from "./frontend";

/** Everything the frontend commands do outside the process. Tests replace it. */
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
  const yes = checkYes(values.yes, ci);
  const { plan, run } = planWithRunner(values, io);

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

  const question = warning
    ? alert('Deploy to PRODUCTION? Type "yes" or "y" to continue: ')
    : 'Deploy? Type "yes" or "y" to continue: ';
  if (!(await confirm(io, yes, question))) {
    io.log("Not deployed.");
    return 1;
  }

  deployFrontend(plan, commit, run, io.log);
  return 0;
}

/**
 * `frontend:destroy`: confirms, then removes everything the branch's frontend
 * owns, skipping what is already gone. Returns the exit code.
 */
export async function frontendDestroy(
  argv: readonly string[],
  ci: string | undefined,
  io: FrontendIO,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "backend-env": { type: "string" },
      branch: { type: "string" },
      profile: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
    strict: true,
    allowPositionals: false,
  });
  const yes = checkYes(values.yes, ci);
  const { plan, run } = planWithRunner(values, io);

  io.log(
    `About to destroy a frontend, and everything it owns that is left:\n\n${describeFrontendDestroy(plan)}\n`,
  );
  const question = isProductionEnv(plan.backendEnv)
    ? io.alert(
        'Destroy this frontend of the PRODUCTION backend? Type "yes" or "y" to continue: ',
      )
    : 'Destroy? Type "yes" or "y" to continue: ';
  if (!(await confirm(io, yes, question))) {
    io.log("Not destroyed.");
    return 1;
  }

  destroyFrontend(plan, run, io.log);
  return 0;
}

/** Whether `--yes` was passed, refusing it outside CI. */
function checkYes(yes: boolean | undefined, ci: string | undefined): boolean {
  if (yes) {
    checkYesInCi(ci);
  }
  return yes ?? false;
}

/**
 * The frontend plan for the parsed arguments, and the runner for its
 * backend's region and the chosen profile.
 */
function planWithRunner(
  values: {
    readonly "backend-env"?: string;
    readonly branch?: string;
    readonly production?: boolean;
    readonly certificate?: string;
    readonly profile?: string;
  },
  io: FrontendIO,
): { plan: FrontendPlan; run: CommandRunner } {
  const backend = requireBackend(values["backend-env"]);
  const run = io.runner({ region: backend.region, profile: values.profile });
  const plan = planFrontend({
    backendEnv: backend.name,
    branch: values.branch ?? currentBranch(run),
    production: values.production,
    certificate: values.certificate,
    awsAccountId: awsJson(run, ["sts", "get-caller-identity"])
      .Account as string,
  });
  return { plan, run };
}

/** True when `--yes` (already checked to be in CI) or the answer confirms. */
async function confirm(
  io: FrontendIO,
  yes: boolean,
  question: string,
): Promise<boolean> {
  if (yes) {
    io.log("Confirmed by --yes (CI).");
    return true;
  }
  return isConfirmed(await io.ask(question));
}

/** The git branch checked out, refusing a detached HEAD. */
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
  return formatRows([
    ["Branch", plan.branch],
    ["Backend env", plan.backendEnv],
    ["Account", plan.awsAccountId],
    ["Region", plan.region],
    ["Environment", plan.environmentName],
    ["Instance type", `${plan.instanceType} (production: ${plan.production})`],
    ["App URL", plan.appUrl],
    ["Certificate", plan.certificate],
    ["Client secret", plan.secretName],
  ]);
}

/** The confirmation text shown before destroying a frontend. */
export function describeFrontendDestroy(plan: FrontendPlan): string {
  return formatRows([
    ["Branch", plan.branch],
    ["Backend env", plan.backendEnv],
    ["Account", plan.awsAccountId],
    ["Region", plan.region],
    ["Environment", plan.environmentName],
    ["CNAME", plan.domainName],
    ["Cognito client", plan.environmentName],
    ["Client secret", plan.secretName],
  ]);
}

/** Label-value rows, with the values lined up. */
function formatRows(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)
    .join("\n");
}
