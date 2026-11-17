#!/usr/bin/env node
// Prints how to reach a branch's frontend and what a local run needs to sign
// in with its Cognito client (never the client secret's value):
//   npm run frontend:status -- [--branch <name>] [--profile <profile>]
// --branch defaults to the current git branch.
import { spawnRunner } from "../lib/command-runner";
import { alert, ask } from "../lib/deployment/terminal";
import { frontendStatus } from "../lib/frontend/frontend-cli";

frontendStatus(process.argv.slice(2), {
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
