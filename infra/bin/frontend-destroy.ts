#!/usr/bin/env node
// Destroys a branch's frontend: its Beanstalk environment, CNAME, Cognito
// client and client secret, skipping what is already gone:
//   npm run frontend:destroy -- --backend-env <env> [--branch <name>]
//     [--profile <profile>] [--yes]
// --branch defaults to the current git branch. In CI (CI=true), --yes skips
// the confirmation.
import { spawnRunner } from "../lib/command-runner";
import { alert, ask } from "../lib/deployment/terminal";
import { frontendDestroy } from "../lib/frontend/frontend-cli";

frontendDestroy(process.argv.slice(2), process.env.CI, {
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
