#!/usr/bin/env node
// Deploys a branch's frontend to the shared dlpnext Beanstalk application:
//   npm run frontend:deploy -- --backend-env <env> [--branch <name>]
//     [--production] [--certificate <arn>] [--profile <profile>] [--yes]
// --branch defaults to the current git branch. In CI (CI=true), --yes skips
// the confirmation.
import { spawnRunner } from "../lib/command-runner";
import { alert, ask } from "../lib/deployment/terminal";
import { frontendDeploy } from "../lib/frontend/frontend-cli";

frontendDeploy(process.argv.slice(2), process.env.CI, {
  runner: spawnRunner,
  ask,
  log: (text) => console.log(text),
  alert,
}).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
