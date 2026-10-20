#!/usr/bin/env node
// Deploys with `cdk deploy --all`, after showing the parsed options and
// asking for confirmation. Takes the same arguments as `cdk deploy`:
//   npm run deploy -- -c env=dev -c account=$ACCOUNT [-c branch=...] [other cdk flags]
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { optionsFromContext, planApp } from '../lib/app';
import { contextFromArgs, describePlan, isConfirmed, productionWarning } from '../lib/deploy';

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
  const args = process.argv.slice(2);
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

  const question = warning
    ? alert('Deploy to PRODUCTION? Type "yes" or "y" to continue: ')
    : 'Deploy? Type "yes" or "y" to continue: ';
  if (!isConfirmed(await ask(question))) {
    console.log('Not deployed.');
    return 1;
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
