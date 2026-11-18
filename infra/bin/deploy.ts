#!/usr/bin/env node
// Deploys with `cdk deploy --all`
// Takes the same arguments as `cdk deploy`:
//   npm run deploy -- -c backend-env=dev -c aws-account-id=$ACCOUNT -c user-pool-id=<pool> [other cdk flags]
// Frontends deploy separately, with `npm run frontend:deploy`.
// In CI (CI=true), --yes skips the confirmation;
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { optionsFromContext, planApp } from "../lib/app";
import { spawnRunner } from "../lib/command-runner";
import {
  contextFromArgs,
  deployArgs,
  describePlan,
  isConfirmed,
  productionWarning,
  profileFromArgs,
} from "../lib/deployment/deploy-cli";
import {
  checkDeploy,
  lookupDeployedState,
} from "../lib/deployment/deploy-check";
import { alert, ask } from "../lib/deployment/terminal";

const INFRA_DIR = path.join(__dirname, "..");

async function main(): Promise<number> {
  const {
    yes,
    check,
    cdkArgs: args,
  } = deployArgs(process.argv.slice(2), process.env.CI);
  // The app also sees cdk.json's context, with -c values taking precedence.
  const cdkJson = JSON.parse(
    fs.readFileSync(path.join(INFRA_DIR, "cdk.json"), "utf8"),
  );
  const context: Record<string, unknown> = {
    ...cdkJson.context,
    ...contextFromArgs(args),
  };

  // generate app plan. warn user if targeting production
  const plan = planApp(optionsFromContext((key) => context[key]));
  const warning = productionWarning(plan);
  if (warning) {
    console.log(`${alert(warning)}\n`);
  }
  console.log(`About to deploy to AWS:\n\n${describePlan(plan)}\n`);

  // inspect plan, raise warnings
  let warned = false;
  if (check) {
    // The same credentials as cdk deploy, which gets every argument.
    const run = spawnRunner({
      region: plan.config.region,
      profile: profileFromArgs(args),
    });
    const { stacks, warnings } = checkDeploy(
      plan,
      lookupDeployedState(plan, run),
    );
    if (stacks.length > 0) {
      console.log(`Stacks:\n${stacks.map((line) => `  ${line}`).join("\n")}\n`);
    }
    if (warnings.length > 0) {
      warned = true;
      console.log(
        `${alert("Check before deploying:")}\n${warnings.map((line) => `  - ${line}`).join("\n")}\n`,
      );
    }
  }

  // user prompt implementation
  if (yes) {
    console.log("Confirmed by --yes (CI).");
  } else {
    const question = warning
      ? alert('Deploy to PRODUCTION? Type "yes" or "y" to continue: ')
      : warned
        ? alert('Deploy anyway? Type "yes" or "y" to continue: ')
        : 'Deploy? Type "yes" or "y" to continue: ';
    if (!isConfirmed(await ask(question))) {
      console.log("Not deployed.");
      return 1;
    }
  }

  // do it
  const result = spawnSync("npx", ["cdk", "deploy", "--all", ...args], {
    cwd: INFRA_DIR,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
