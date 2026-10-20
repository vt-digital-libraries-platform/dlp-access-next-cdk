#!/usr/bin/env node
// Deploys with `cdk deploy --all`, after showing the parsed options and
// asking for confirmation. Takes the same arguments as `cdk deploy`:
//   npm run deploy -- -c env=dev -c account=$ACCOUNT [-c branch=...] [other cdk flags]
// In CI (CI=true), --yes skips the confirmation; see deployArgs. Before
// confirming, it shows which stacks are created or updated and warns about
// changes such as a repointed user pool (checkDeploy); --no-check skips that.
// The check never blocks a deploy.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { optionsFromContext, planApp } from '../lib/app';
import { contextFromArgs, deployArgs, describePlan, isConfirmed, productionWarning } from '../lib/deploy';
import { AwsError, checkDeploy, lookupDeployedState } from '../lib/deploy-check';
import { sourceCommit, uncommittedChanges } from '../lib/web-stack';

const INFRA_DIR = path.join(__dirname, '..');

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    // Closed stdin (Ctrl-D, or no terminal) counts as no answer.
    rl.once('close', () => resolve(''));
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

async function main(): Promise<number> {
  const { yes, check, cdkArgs: args } = deployArgs(process.argv.slice(2), process.env.CI);
  // The app also sees cdk.json's context, with -c values taking precedence.
  const cdkJson = JSON.parse(fs.readFileSync(path.join(INFRA_DIR, 'cdk.json'), 'utf8'));
  const context: Record<string, unknown> = { ...cdkJson.context, ...contextFromArgs(args) };

  const plan = planApp(optionsFromContext((key) => context[key]));
  const warning = productionWarning(plan);
  // Bold red on a terminal.
  const alert = (text: string) => (process.stdout.isTTY ? `\x1b[1;31m${text}\x1b[0m` : text);
  if (warning) {
    console.log(`${alert(warning)}\n`);
  }
  console.log(`About to deploy to AWS:\n\n${describePlan(plan)}\n`);
  if (plan.webStackName) {
    // The Web stack deploys HEAD, so local edits are left out.
    console.log(`App source: commit ${sourceCommit()}\n`);
    const changes = uncommittedChanges();
    if (changes.length > 0) {
      console.log(`${alert('Uncommitted changes are not deployed:')}\n${changes.map((line) => `  ${line}`).join('\n')}\n`);
    }
  }

  let warned = false;
  if (check) {
    const region = plan.config.region;
    const aws = (awsArgs: string[]) => {
      const result = spawnSync('aws', [...awsArgs, '--region', region, '--output', 'json'], { encoding: 'utf8' });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new AwsError(result.stderr || `aws exited with ${result.status}`);
      }
      return JSON.parse(result.stdout);
    };
    const { stacks, warnings } = checkDeploy(plan, lookupDeployedState(plan, aws));
    if (stacks.length > 0) {
      console.log(`Stacks:\n${stacks.map((line) => `  ${line}`).join('\n')}\n`);
    }
    if (warnings.length > 0) {
      warned = true;
      console.log(`${alert('Check before deploying:')}\n${warnings.map((line) => `  - ${line}`).join('\n')}\n`);
    }
  }

  if (yes) {
    console.log('Confirmed by --yes (CI).');
  } else {
    const question = warning
      ? alert('Deploy to PRODUCTION? Type "yes" or "y" to continue: ')
      : warned
        ? alert('Deploy anyway? Type "yes" or "y" to continue: ')
        : 'Deploy? Type "yes" or "y" to continue: ';
    if (!isConfirmed(await ask(question))) {
      console.log('Not deployed.');
      return 1;
    }
  }
  const result = spawnSync('npx', ['cdk', 'deploy', '--all', ...args], { cwd: INFRA_DIR, stdio: 'inherit' });
  return result.status ?? 1;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
