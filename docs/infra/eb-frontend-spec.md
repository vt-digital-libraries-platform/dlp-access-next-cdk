# Deploy frontends with the EB CLI instead of the CDK Web stack

## Problem Statement

Every change to a frontend goes through CDK. A deploy archives HEAD, stages it as a CDK asset, and has CloudFormation update the Beanstalk application version and environment. For a code-only change that is slow, and when it fails the developer waits on CloudFormation rollbacks of resources that had nothing to do with the change. The frontend's Beanstalk resources, Cognito app client, client secret, IAM and DNS are all bundled in one stack per branch, so a quick push of new app code costs as much as provisioning the whole frontend.

## Solution

Frontends leave CDK entirely. The CDK app deploys only backends (Data, Api and Auth stacks). Frontends are created, updated, inspected and destroyed with three commands in the infra tooling, which drive the EB CLI and the AWS CLI:

- `frontend:deploy` creates a frontend the first time it runs for a branch, and after that just pushes the committed HEAD with `eb deploy`.
- `frontend:destroy` removes everything the frontend owns.
- `frontend:status` prints what a developer needs to reach the frontend or run the branch locally against the same Cognito client.

All branches' environments live in one shared Beanstalk application. Settings that are the same for every frontend live in committed `.ebextensions` config that ships with the app code. Settings that vary by branch or backend are set once, when the environment is created.

## User Stories

1. As a developer, I want to push my branch's latest commit to its frontend with one command, so that I can see my change running without waiting on CloudFormation.
2. As a developer, I want a code-only deploy to touch only the Beanstalk application version, so that it is as fast as Beanstalk allows.
3. As a developer, I want the first deploy of a branch to create its frontend end to end (Cognito client, secret, Beanstalk environment, DNS record), so that I don't have to run separate setup steps.
4. As a developer, I want the deploy command to default to my current git branch, so that I don't have to type the branch name.
5. As a developer, I want to deploy a branch other than the one checked out with a flag, so that I can redeploy or rebuild someone else's frontend.
6. As a developer, I want to choose which backend environment (`dev`, `pre-production`, `production`, or a feature environment) the frontend attaches to, so that I can test against the data I need.
7. As a developer, I want only committed files deployed, so that a deploy always corresponds to a commit and stray local edits never reach AWS.
8. As a developer, I want to be warned when I have uncommitted changes, so that I know they won't be in the deploy.
9. As a developer, I want each deployed version labelled with the branch slug and short commit SHA, so that I can tell from the Beanstalk console which commit is running.
10. As a developer, I want redeploying a commit that was already deployed to reuse its existing version, so that the deploy doesn't fail on a duplicate label.
11. As a developer, I want the frontend served at `https://<slug>.dlp-access-dev.dlp.cloud.lib.vt.edu`, the same address as today, so that bookmarks and Cognito callback URLs keep working after the migration.
12. As a developer, I want my frontend to get its own Cognito app client on the backend's user pool, so that sign-in works for my branch without affecting other branches.
13. As a developer, I want the app client to allow `localhost:3000` callbacks as well as the branch URL, so that I can run the branch locally against the same client.
14. As a developer, I want a status command that prints the app URL, the Beanstalk endpoint, the Cognito issuer, client ID, identity provider and the client secret's name, so that I can configure a local run or debug sign-in.
15. As a developer, I want the client secret kept in Secrets Manager and handed to the app as an environment secret, so that it never appears in plain text in the Beanstalk console or configuration API.
16. As a developer, I want to be asked to confirm before anything is created or changed, as `npm run deploy` does today, so that a typo doesn't deploy to the wrong place.
17. As a developer deploying to the `production` backend, I want a prominent warning before confirming, so that I don't attach a test frontend to production by accident.
18. As a developer, I want `--production` to give the frontend the larger instance type, so that sizing matches the existing `-c production=true` behaviour.
19. As a developer, I want to override the certificate ARN with a flag, so that I can use a different certificate when the default doesn't cover my domain.
20. As a developer, I want to pass an AWS profile, so that the commands use the same credentials I use for `cdk deploy`.
21. As a developer, I want deploy to refuse when the existing environment was created for a different full branch name that shares my slug, so that I never overwrite someone else's frontend.
22. As a developer, I want deploy to refuse when the existing environment is attached to a different backend than the one I asked for, so that I don't silently get a frontend pointed at the wrong data.
23. As a developer, I want the refusal to tell me to destroy and recreate the frontend to repoint it, so that I know what to do next.
24. As a developer, I want deploy to refuse when more than one Cognito client on the pool has my frontend's name, so that I don't end up using the wrong client and secret.
25. As a developer, I want to destroy my frontend with one command, so that I don't leave a running instance and load balancer behind.
26. As a developer, I want destroy to remove the Beanstalk environment, the DNS record, the Cognito client and the client secret, so that nothing of the frontend is left over.
27. As a developer, I want destroy to free the secret's name immediately, so that I can recreate the frontend straight away without a name collision.
28. As a developer, I want to be able to re-run destroy after it fails partway, so that I can finish a teardown without cleaning up by hand.
29. As a developer, I want destroy to succeed when some of the frontend's pieces are already gone, so that cleaning up a half-created frontend is the same command.
30. As a developer, I want destroy to leave the backend and the user pool untouched, so that removing a frontend never affects other frontends or data.
31. As a developer, I want the shared Beanstalk application created automatically the first time anyone deploys a frontend in an account, so that there is no one-time manual setup.
32. As a developer, I want the EB CLI's local project config set up for me, so that I can also use `eb` commands directly (logs, ssh, health) on my frontend.
33. As a developer, I want my local EB CLI config kept out of git, so that branch-specific settings don't churn in commits.
34. As a developer, I want to change a frontend's dynamic settings with `eb setenv` or `eb config` when I need to, so that I'm not forced to destroy and recreate for a small change.
35. As a maintainer, I want settings shared by every frontend (load balancer type, single instance, IMDSv1 off, enhanced health, managed platform updates, log streaming, TLS policy, HTTP-to-HTTPS listener) in committed `.ebextensions` config, so that changing them is a reviewed code change that applies on the next deploy.
36. As a maintainer, I want the tooling never to set those shared settings through the API, so that the committed config is never silently overridden.
37. As a maintainer, I want old application versions cleaned up automatically, with their source bundles deleted, so that the shared application never hits the account's version limit.
38. As a maintainer, I want each backend to own its Beanstalk service role, so that frontends need no IAM of their own.
39. As a maintainer, I want each backend's instance role to be able to read the frontend client secrets, so that a new frontend's instance can read its secret without a per-branch IAM change.
40. As a maintainer, I want the backend to publish its service role through SSM like its instance profile, so that the frontend tooling finds it by environment name.
41. As a maintainer, I want the CDK app to deploy only backends, so that the CDK options, deploy check and docs no longer describe frontends.
42. As a maintainer, I want CDK to reject the old `frontend-branch`, `backend` and `certificate` options with a message pointing at `frontend:deploy`, so that someone following old instructions learns the new way.
43. As a maintainer, I want provisioning a new backend and a frontend to be two commands, `npm run deploy` then `frontend:deploy`, so that each command does one thing.
44. As a maintainer, I want the existing `DlpAccessNext-Web-<slug>` stacks destroyed and their frontends recreated with the new commands, so that every frontend is managed the same way.
45. As a maintainer, I want the slug, naming and validation rules shared between the backend and frontend tooling, so that the rules live in one place.
46. As a maintainer, I want the frontend tooling's behaviour covered by unit tests against a fake AWS/EB CLI, so that I can change it without deploying to find out what broke.
47. As a CI job, I want `CI=true` or `--yes` to skip the confirmation prompt, so that frontend deploys can be automated later.
48. As a teammate reviewing a PR, I want to know which commit a frontend is running from its version label, so that I know whether I'm looking at the latest change.

## Implementation Decisions

### Ownership

- The CDK app becomes backend-only. The Web stack, its wiring into the app, and the combined backend-plus-frontend provisioning mode are removed. `planApp` no longer accepts `frontend-branch`, `backend` or `certificate`, and rejects them with an error that names `frontend:deploy`. The deploy check drops its frontend checks.
- The Api stack gains, per backend environment:
  - a Beanstalk service role with the same managed policies the Web stack's role has today (enhanced health, managed updates), published as an SSM parameter named after the environment, alongside the instance profile.
  - a policy on the existing instance role allowing `secretsmanager:GetSecretValue` and `secretsmanager:DescribeSecret` on secrets named `dlpnext/*`. Any frontend in the account can read any other frontend's client secret. That is accepted, since frontends on a backend already share one instance role.
- Everything else that belongs to a frontend is created and removed by the new frontend tooling: the Cognito app client, the Secrets Manager secret, the Beanstalk environment, and the Route53 record.

### Beanstalk layout

- One shared Beanstalk application, `dlpnext`, per account. Each frontend is an environment in it named `dlpnext-<slug>`, using the existing slug and length rules.
- The tooling makes sure the application and the local EB CLI project config exist by running `eb init` non-interactively with the application name, platform (the existing solution stack constant) and region. The local config stays gitignored.
- When it creates the application, the tooling sets an application version lifecycle policy: at most 200 versions, with source bundles deleted from S3.

### Source bundle

- Deploys ship the committed HEAD only. `.ebignore` is removed so that the EB CLI uses `git archive`. The current bundle excludes (`.github`, `.claude`, `.scratch`, `.elasticbeanstalk`, `infra`, `docs`, Markdown files, `.env*`) move to `.gitattributes` as `export-ignore` entries, which `git archive` honours. `.ebextensions` and `.platform` stay in the bundle.
- Version labels are `<slug>-<short SHA>`. If that label already exists in the application, the tooling deploys the existing version instead of creating a new one.
- The existing prebuild hook that installs dependencies and runs `next build` on the instance is unchanged.

### Option settings

- **Static settings** go in committed `.ebextensions` config: load-balanced environment with an application load balancer, ASG min and max of 1, IMDSv1 disabled, enhanced health reporting, managed actions on Sunday 09:00 with minor platform updates, CloudWatch log streaming with 7-day retention, and the HTTPS listener's TLS policy. The tooling must never set any of these through the API or EB CLI flags, because directly applied settings take precedence over `.ebextensions` and would freeze them.
- **Dynamic settings** are set by the tooling only when the environment is created:
  - the HTTPS listener's certificate ARN (built from the deploying account, the region and the certificate ID constant, or overridden by a flag)
  - the instance profile and service role for the backend
  - the instance type (small, or the production size with `--production`)
  - the app's environment variables: `APPSYNC_API_URL`, `AWS_REGION`, `COGNITO_ISSUER`, `COGNITO_CLIENT_ID`, `COGNITO_IDENTITY_PROVIDER`, `APP_BASE_URL`
  - `COGNITO_CLIENT_SECRET` through the `environmentsecrets` namespace, pointing at the frontend's secret
  - a CNAME prefix of `dlpnext-<slug>`, so the Beanstalk endpoint is predictable
- The backend's API URL, user pool ID and identity provider are read from the backend's existing SSM parameters, as the Web stack does today.
- Later deploys do not reconcile dynamic settings. A developer changes them with `eb setenv` / `eb config`, or destroys and recreates the frontend.

### Environment tags

- At creation the environment is tagged `dlpnext:branch=<full branch name>` and `dlpnext:backend-env=<backend env>`.
- On every later deploy the tooling reads the tags and refuses to continue if either one doesn't match the request. There is no override flag. Repointing a frontend to another backend means destroy and recreate, because its Cognito client lives on the old backend's user pool.

### Cognito client and secret

- The client is created with the AWS CLI, with the same configuration as today: named `dlpnext-<slug>`, generated secret, no explicit auth flows, authorization code grant only, `openid` and `email` scopes, the backend's single identity provider as the only supported provider, callback URLs `<origin>/authorize` and logout URLs `<origin>/` for both the branch URL and `http://localhost:3000`.
- Cognito allows duplicate client names, so the tooling looks the client up by name on the backend's pool before creating one. It reuses a single match and refuses on more than one.
- The client secret is stored in Secrets Manager under the fixed name `dlpnext/<slug>/cognito-client-secret`. Destroy deletes it without a recovery window so the name is free immediately.
- Defining the client and secret as CloudFormation resources in `.ebextensions` was considered and rejected. A secret deleted by CloudFormation keeps its name through a recovery window, so the name would have to be generated, which breaks the `dlpnext/*` grant. Tying the client definition to each code version also means a rollback could replace the client and change its ID and secret.

### Commands

The tooling is TypeScript in the infra package, beside the existing deploy tooling, and reuses its slug, naming and environment-resolution helpers and its confirmation behaviour (prompt, red production warning, `CI=true` / `--yes` skips the prompt).

- **`frontend:deploy`**: `--backend-env <env>` (required), `--branch <name>` (defaults to the current git branch), `--production`, `--certificate <arn>`, `--profile <profile>`, `--yes`.
  - Before confirming, it prints what it is about to do, the commit being deployed, and any uncommitted changes that will be left out.
  - **When the environment doesn't exist:**
    1. Make sure the application and EB CLI config exist.
    2. Find or create the Cognito client.
    3. Create or update the secret.
    4. Create the environment with the dynamic settings and tags.
    5. Wait for it.
    6. UPSERT a CNAME from the branch's domain name to the environment's endpoint in the hosted zone.
  - **When the environment exists:** check the tags, then run `eb deploy` of HEAD with the version label, or of the existing version if the label exists.
- **`frontend:destroy`**: `--backend-env <env>`, `--branch <name>`, `--profile`, `--yes`. Steps run in this order, and each one skips what is already gone, so the command can be re-run:
  1. Terminate the environment and wait.
  2. Delete the CNAME if present.
  3. Delete the Cognito client found by name.
  4. Force-delete the secret.

  Application versions are left to the lifecycle policy.
- **`frontend:status`**: `--branch <name>`, `--profile`. Prints app URL, endpoint, backend env, Cognito issuer, client ID, identity provider and the secret's name (never its value).

### Module shape

- A frontend module with a pure planning function, plus deploy, destroy and status operations. Planning covers validation, slug, environment name, domain name, app URL, certificate ARN and secret name. The operations take an injected command runner.
- The existing `AwsCli` injection used by the deploy check is widened into one runner that covers the `aws`, `eb` and `git` executables. The frontend module touches the outside world only through it. The command-line entry points stay thin wrappers, as the deploy entry point is today.

### Migration

- Existing `DlpAccessNext-Web-<slug>` stacks are destroyed with `cdk destroy` and recreated with `frontend:deploy`. Nothing is adopted in place. Domain names don't change. Destroy them with the current code, before the Web stack is removed: once the app can no longer synthesize a Web stack, `cdk destroy -c frontend-branch=…` can't find them, and the only way left is deleting them through CloudFormation directly.
- The deployment docs and README are rewritten: backends with `npm run deploy`, frontends with the three new commands, with the frontend section of the destroy instructions replaced.

## Testing Decisions

- Tests check external behaviour: the CloudFormation template a backend produces, the errors planning returns, and the sequence of commands the frontend operations issue given some starting AWS state. They don't check helper internals or the exact formatting of output.
- **CDK template assertions** (prior art: the existing app tests, including the "API and Elastic Beanstalk access" group):
  - the Api stack has a service role with the expected managed policies and an SSM parameter publishing it
  - the instance role is granted read on `dlpnext/*` secrets and nothing broader
  - no Beanstalk, Cognito client or Route53 resources remain in any stack the app produces
- **Planning tests** (prior art: the existing `planApp` tests and the deploy CLI tests):
  - `planApp` rejects the removed options with a message naming `frontend:deploy`
  - `planFrontend` derives slug, names, URL, certificate ARN and secret name
  - `planFrontend` rejects bad branch names, over-long slugs, control characters, bad certificate ARNs and unknown backend envs
- **Frontend operation tests** use a fake command runner (prior art: `fakeAws` in the deploy check tests) that returns canned state and records every command. They cover:
  - first deploy: application and config ensured; client created with the expected settings; secret written; environment created with only dynamic settings, the CNAME prefix and both tags; DNS record upserted
  - first deploy when a client with the name already exists: reused, not duplicated
  - more than one client with the name: refused before anything is created
  - later deploy: only `eb deploy` with the `<slug>-<sha>` label; no settings changed
  - later deploy of an already-deployed commit: deploys the existing version
  - branch tag mismatch (slug collision) and backend tag mismatch: refused, nothing changed
  - no command ever sets a static `.ebextensions` setting
  - destroy runs its steps in order, skips missing pieces, and finishes when re-run after a failure at each step
  - status reads the environment and prints the secret's name, never its value
- No test runs the real `eb` or `aws` CLIs, and the command-line entry points aren't tested beyond the shared argument and confirmation helpers.

## Out of Scope

- The PR-preview GitHub workflows, their Docker/ECR image flow, and the hand-made `dlp-access-next` application and `dev-env-sc` saved template. Whether CI adopts the new commands is a separate decision.
- A real production frontend (production domain and certificate, more than one instance, production account specifics). `--production` keeps today's behaviour of only changing the instance type.
- Repointing a frontend to a different backend in place.
- Reconciling dynamic settings on every deploy.
- Building the app off-instance (in CI or locally) instead of in the prebuild hook.
- Any change to the backend's Data or Auth stacks, the user pool, or the identity provider.

## Further Notes

- Directly applied option settings override `.ebextensions`. If someone runs `eb setenv` or `eb config` on a static setting by hand, that environment stops following the committed config for that option until the override is removed. The status command could flag this later. It isn't part of this spec.
- Removing `.ebignore` matters: while it exists, the EB CLI zips the working directory, uncommitted changes included, instead of using `git archive`.
- `export-ignore` in `.gitattributes` uses gitattributes patterns, not git pathspecs. The current `*.md` exclude has to become a pattern that matches Markdown files in every directory.
