# Deploying and destroying environments

How to create, update and destroy backends and frontends with the CDK app in `infra/`. The settings themselves are described in `CLAUDE.md`; this page is the set of commands.

## Terms

- **Backend**: one environment's three stacks. `DlpAccessNext-<env>-Data` holds the DynamoDB tables and the OpenSearch domain. `DlpAccessNext-<env>-Api` holds the AppSync API, the streaming Lambda and the environment's Beanstalk instance role. `DlpAccessNext-<env>-Auth` records which existing Cognito user pool and identity provider the environment uses.
- **Frontend**: one git branch's `DlpAccessNext-Web-<slug>` stack, an Elastic Beanstalk application and environment running the Next.js app against one backend. The slug is the branch name in lowercase, with every run of other characters replaced by `-` (`whunter/Multi_Env` becomes `whunter-multi-env`). The branch is served at `https://<slug>.dlp-access-dev.dlp.cloud.lib.vt.edu`.
- **Tier**: `dev`, `pre-production` or `production`. These keep their tables when destroyed.
- **Feature environment**: `f-<slug>`, such as `f-search`. It uses dev's settings, but its tables are deleted with its stacks.

## Before you start

Run every command from `infra/` with credentials for the target account. `production` lives in a separate account from the others.

```bash
cd infra
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

Placeholders used below:

| Placeholder | Meaning |
| --- | --- |
| `<env>` | `dev`, `pre-production`, `production`, or `f-<slug>` (lowercase, at most 20 characters) |
| `<user pool ID>` | The environment's existing Cognito user pool, in the environment's region (`us-east-1`), such as `us-east-1_AbCd12345` |
| `<branch>` | A git branch name, or its slug. Usually `$(git branch --show-current)` |

Notes that apply to every command:

- **Deploy with `npm run deploy`, not `npx cdk deploy`.** The script checks the options, prints the stacks it will deploy, and runs `cdk deploy --all` only if you type `y` or `yes`. It needs a terminal: without one, and without `--yes`, it exits 1 without deploying. `npx cdk deploy` works but skips the confirmation.
- **Read the stack check before confirming.** Creating and redeploying use the same command: a stack that exists is updated, with no error. So before the prompt, the script looks up what is deployed (with the `aws` CLI and your credentials) and lists each stack as `create`, `update` or `busy`. It then warns in red about anything you may not have meant:
  - the environment's user pool is repointed, or sign-in changes identity provider (often a forgotten `-c identityProvider`)
  - the search domain is resized (often a forgotten `-c production=true`)
  - a frontend moves to another environment, or the branch's slug belongs to a frontend deployed from a different branch name
  - tables or a search domain left over from a destroyed backend will make creating its Data stack fail
  - a stack is mid-operation, or the credentials are for a different account

  With warnings, the prompt asks "Deploy anyway?". The check never blocks a deploy: a lookup that fails, for example for lack of permissions, is listed as a warning and the deploy can go ahead. `--no-check` skips the check.
- **In CI, add `--yes`** to deploy without the prompt. See [Running in CI](#running-in-ci).
- **CDK never creates, changes or deletes a user pool.** The pool needs its own managed login domain and an `admin` group, set up outside CDK. `-c userPool` only records which pool to use.
- **Pass `-c identityProvider=VT-SSO-OIDC` on every backend deploy** if users sign in through VT SSO. If you leave it out, the environment falls back to the pool's own accounts (`COGNITO`).
- **`-c production=true` picks the large sizing:** three `m7g.medium.search` nodes and a `t3.medium` Beanstalk instance. It is independent of `env`. Pass it on every `production` deploy, or the next deploy shrinks the environment to the small sizing (one `t3.small.search` node, `t3.small` instance). When `env` is `production`, the deploy script prints a red warning, and adds a line if this flag is missing.
- **Destroying uses `npx cdk destroy`**, which asks for its own confirmation. There is no destroy script and no production warning, so check the account before destroying.

---

## Create

### New tier backend, no frontend (`dev`, `pre-production`, `production`)

```bash
npm run deploy -- -c env=<env> -c account=$ACCOUNT \
  -c userPool=<user pool ID> -c identityProvider=VT-SSO-OIDC
```

For production, run it in the production account and add `-c production=true`:

```bash
npm run deploy -- -c env=production -c account=$ACCOUNT -c production=true \
  -c userPool=<user pool ID> -c identityProvider=VT-SSO-OIDC
```

Notes:

- Leaving out `-c branch` means the app contains only the three backend stacks.
- Tier tables have deletion protection and point-in-time recovery turned on, and are kept if the stacks are destroyed. **If the tier was destroyed before, its `<Model>-dlpnext-<env>` tables still exist and this deploy fails** because the names are taken. Either delete the old tables first (turn off deletion protection, then delete), or import them into the Data stack.
- The OpenSearch domain starts empty. Only rows written after the Api stack deploys are streamed to it; nothing reindexes rows that already exist.

### New feature backend, no frontend

```bash
npm run deploy -- -c env=f-<slug> -c account=$ACCOUNT \
  -c userPool=<user pool ID> -c identityProvider=VT-SSO-OIDC
```

Notes:

- Its tables are created empty and deleted when the stacks are destroyed.
- Names are lowercase and at most 20 characters including `f-`, because the OpenSearch domain is `dlpnext-<env>`.
- A feature backend can use the same user pool as dev.

### New frontend attached to an existing backend

Check out the branch, then:

```bash
npm run deploy -- -c env=<env> -c account=$ACCOUNT -c branch=$(git branch --show-current)
```

Notes:

- The backend's Api and Auth stacks must already be deployed. If they aren't, the deploy fails with "Unable to fetch parameters".
- Don't pass `-c userPool` or `-c identityProvider`: they are rejected here. The frontend reads them from the backend's SSM parameters.
- **The deploy ships the commit at HEAD, not your working tree.** Commit what you want deployed first. Uncommitted and untracked changes are left out, and `npm run deploy` lists them before it asks to continue. The bundle leaves out `infra`, docs, Markdown files, `.scratch` and `.env*` files. Beanstalk builds it on the instance. The application version's description records the commit.
- The certificate defaults to the stored wildcard certificate for `*.dlp-access-dev.dlp.cloud.lib.vt.edu`. Pass `-c certificate=<ACM certificate ARN>` only to use a different one, which must be in the same account and region.
- The frontend creates its own Cognito app client on the environment's pool. The provider named by the backend's `identityProvider` must exist on the pool, or creating the client fails.
- The slug can be at most 32 characters. If the branch name is longer, pass a shorter `-c branch=<name>`.

### New backend and new frontend together

```bash
npm run deploy -- -c env=<env> -c account=$ACCOUNT \
  -c branch=$(git branch --show-current) -c backend=provision \
  -c userPool=<user pool ID> -c identityProvider=VT-SSO-OIDC
```

Notes:

- `-c backend=provision` adds the environment's Data, Api and Auth stacks to the app. They deploy first and the Web stack follows.
- The notes for each half apply: retained tier tables block a re-create, and only the commit at HEAD is deployed.
- Add `-c production=true` for production.

---

## Update / redeploy

A redeploy uses the same command as the create. CloudFormation applies only what changed.

### Backend

```bash
npm run deploy -- -c env=<env> -c account=$ACCOUNT \
  -c userPool=<user pool ID> -c identityProvider=VT-SSO-OIDC
```

Notes:

- Pass the same `-c userPool`, `-c identityProvider` and (for production) `-c production=true` as before. A different pool ID repoints the environment. A missing `identityProvider` falls back to `COGNITO`. A missing `production=true` shrinks the domain and instance type.
- Frontends attached to the backend read the user pool and identity provider when they deploy. After changing either, redeploy each frontend so it picks up the change.
- Resolver, schema and Lambda changes take effect when the Api stack updates. No frontend redeploy is needed unless the Next.js code changed too.
- OpenSearch index templates apply only when an index is created. Changed mappings don't reach an existing index until it is deleted and reindexed.

### Frontend

Check out the branch, then:

```bash
npm run deploy -- -c env=<env> -c account=$ACCOUNT -c branch=$(git branch --show-current)
```

Notes:

- This uploads the commit at HEAD as a new application version. Commit first: uncommitted changes aren't deployed. If HEAD's files haven't changed since the last deploy, the bundle is the same and the app isn't redeployed.
- Deploying the same branch with a different `env` repoints its existing frontend to that backend.

### Both

```bash
npm run deploy -- -c env=<env> -c account=$ACCOUNT \
  -c branch=$(git branch --show-current) -c backend=provision \
  -c userPool=<user pool ID> -c identityProvider=VT-SSO-OIDC
```

This is the same command as creating both. Its backend stacks are the environment's own stacks, so it updates them in place. Pass the same flags as before.

---

## Destroy

### A specific frontend

```bash
npx cdk destroy --all -c env=<env> -c account=$ACCOUNT -c branch=<branch>
```

Notes:

- With `-c branch` and no `-c backend`, the app contains only that branch's Web stack, so `--all` destroys only it. `<env>` should be the backend the frontend is attached to.
- `<branch>` can be the branch name or its slug, so you don't need the branch checked out.
- This deletes the Beanstalk application and environment, the DNS record, the Cognito app client, the client secret and the secret's policy on the instance role. The backend and the user pool are not affected.

### All frontends attached to a backend

Each frontend's Beanstalk application is named `dlpnext-<slug>`. Its description ends with `using the <env> environment`, and the description is updated when the frontend is repointed. To list the frontends attached to a backend:

```bash
aws elasticbeanstalk describe-applications --region us-east-1 \
  --query "Applications[?Description && ends_with(Description, 'using the <env> environment')].ApplicationName" \
  --output text
```

Then destroy each one by its slug (the application name without `dlpnext-`):

```bash
for app in $(aws elasticbeanstalk describe-applications --region us-east-1 \
    --query "Applications[?Description && ends_with(Description, 'using the <env> environment')].ApplicationName" \
    --output text); do
  npx cdk destroy --all -c env=<env> -c account=$ACCOUNT -c branch="${app#dlpnext-}"
done
```

Notes:

- `cdk destroy` asks before deleting each stack. Add `--force` to skip the prompts, after checking the list.
- Beanstalk environments made outside CDK, such as the PR-preview workflow's environments, aren't Web stacks and aren't found this way. If they use this backend's instance profile, delete them separately.

### A backend

**Destroy the backend's frontends first** (see above). Frontends find their backend by name, not through cross-stack references, so CloudFormation won't stop you from deleting a backend that frontends still use. Those frontends would lose their instance role, the API and the SSM parameters they read.

```bash
npx cdk destroy --all -c env=<env> -c account=$ACCOUNT -c userPool=<user pool ID>
```

Notes:

- `-c userPool` is needed only because the app checks it whenever the backend stacks are in the app. It must be a well-formed pool ID in the environment's region. **The pool is not deleted.** Destroying the Auth stack deletes only its two SSM parameters.
- Without `-c branch`, the app contains only the three backend stacks, so `--all` destroys only them.
- **Tables:** tier tables (`dev`, `pre-production`, `production`) are kept, with deletion protection still on. Recreating the tier fails until you delete or import them. Feature environment tables are deleted.
- **OpenSearch:** the domain is deleted in every environment, along with its indexes.
- To skip CDK and the `-c userPool` check, delete the stacks with CloudFormation instead, Api first because it uses the Data stack's resources:

  ```bash
  aws cloudformation delete-stack --region us-east-1 --stack-name DlpAccessNext-<env>-Api
  aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name DlpAccessNext-<env>-Api
  aws cloudformation delete-stack --region us-east-1 --stack-name DlpAccessNext-<env>-Data
  aws cloudformation delete-stack --region us-east-1 --stack-name DlpAccessNext-<env>-Auth
  ```

---

## Running in CI

Every deploy command above works in CI with `--yes` added. Every destroy command works with `--force` added.

```bash
npm run deploy -- --yes -c env=<env> -c account=$ACCOUNT …
npx cdk destroy --all --force -c env=<env> -c account=$ACCOUNT …
```

### What `--yes` does

- **It skips the script's confirmation.** The plan, the production warning, the deployed commit and any uncommitted changes are still printed to the job log, followed by `Confirmed by --yes (CI).`
- **It also answers CDK's approval prompt.** It adds `--require-approval never`, so CDK doesn't stop to approve IAM policy or security group changes. If you pass your own `--require-approval`, that one is used instead.
- **The stack check still runs.** Its stack list and warnings go to the job log, but they don't stop the deploy. Add `--no-check` to skip the lookups, for example when the job's role can't describe the stacks, tables, search domain and Beanstalk applications.
- **It's for the script only.** `-y` means the same thing. The script removes the flag before calling `cdk deploy`.
- **It only works in CI.** The `CI` environment variable must be `true` or `1`; GitHub Actions sets it. Otherwise the script stops with `--yes only applies in CI (CI=true); run without it to confirm the deploy`. On your own machine, answer the prompt.
- **Production isn't treated differently.** `--yes` skips the production prompt too. The approval for production belongs to the pipeline, such as required reviewers on a GitHub Environment named `production`.

### Notes for pipelines

- **The deployed commit is the one the job checked out.** A frontend deploy bundles HEAD with `git archive`, so the job needs a git checkout, not just the files. On a `pull_request` event, `actions/checkout` checks out a merge commit by default. To deploy the branch's own commit, check out `${{ github.event.pull_request.head.sha }}`. A shallow clone is fine.
- **The branch name can't come from `git branch --show-current`.** Checkouts in CI are on a detached HEAD, so that command prints nothing. On GitHub Actions, use `-c branch=${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}`: the source branch for pull requests, and the pushed branch otherwise.
- **The job's role needs to look up the hosted zone.** At synth time, the frontend finds `dlp.cloud.lib.vt.edu` in Route 53. The lookup is cached in `infra/cdk.context.json`, which isn't committed, so every CI run does it.
- **Keep the context values in pipeline config.** Store `env`, `userPool`, `identityProvider` and, for production, `production=true` as each GitHub Environment's variables, not in the workflow's command line. The redeploy rules still apply: leaving one out changes the environment.
- **Run one deploy per environment at a time,** for example with `concurrency: deploy-<env>`.
- **Use short-lived credentials,** such as a role the job assumes through GitHub OIDC, with production's role trusting only the `production` Environment.

### Example: deploy a branch's frontend on push

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: dev                      # add required reviewers for production
    concurrency: deploy-dev
    permissions:
      id-token: write                     # for OIDC
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - working-directory: infra
        run: |
          npm ci
          npm run deploy -- --yes -c env=dev -c account=${{ vars.AWS_ACCOUNT_ID }} \
            -c branch=${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}
```

For a backend deploy, replace `-c branch=…` with `-c userPool=${{ vars.USER_POOL_ID }} -c identityProvider=VT-SSO-OIDC`. Add `-c production=true` in the production job.
