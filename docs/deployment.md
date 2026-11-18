# Deploying and destroying environments

How to create, update and destroy backends (the CDK app in `infra/`) and frontends (the `frontend:*` commands in `infra/`). The options themselves are described in `README.md`; this page is the set of commands.

## Terms

- **Backend**: one environment's three stacks. `DlpAccessNext-<env>-Data` holds the DynamoDB tables and the OpenSearch domain. `DlpAccessNext-<env>-Api` holds the AppSync API, the streaming Lambda and the environment's Beanstalk instance role. `DlpAccessNext-<env>-Auth` records which existing Cognito user pool and identity provider the environment uses.
- **Backend environment tiers**: `dev`, `pre-production` or `production`. These keep their tables when destroyed.
- **Backend feature environments**: `f-<slug>`, such as `f-search`. It uses dev's settings, but its tables are deleted with its stacks.
- **Frontend**: one git branch of the Next.js app running against one backend: an Elastic Beanstalk environment `dlpnext-<slug>` in the account's shared `dlpnext` application, its own Cognito app client on the backend's user pool, the client's secret in Secrets Manager, and a DNS record. It isn't a CloudFormation stack; `frontend:deploy` and `frontend:destroy` create and remove those pieces. The slug is the branch name in lowercase, with every run of other characters replaced by `-` (`whunter/Multi_Env` becomes `whunter-multi-env`). The branch is served at `https://<slug>.dlp-access-dev.dlp.cloud.lib.vt.edu`.

## Before you start

Run every command from `infra/` with credentials for the target account. `production` lives in a separate account from the others.

Placeholders used below:

| Placeholder      | Meaning                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `<env>`          | `dev`, `pre-production`, `production`, or `f-<slug>` (lowercase, at most 20 characters)                                |
| `<user pool ID>` | The environment's existing Cognito user pool, in the environment's region (`us-east-1`), such as `us-east-1_AbCd12345` |
| `<branch>`       | A git branch name, or its slug. Usually `$(git branch --show-current)`                                                 |

Notes that apply to every command:

- **Deploy backends with `npm run deploy`, not `npx cdk deploy`.** The script checks the options, prints the stacks it will deploy, and runs `cdk deploy --all` only if you type `y` or `yes`. It needs a terminal: without one, and without `--yes`, it exits 1 without deploying. `npx cdk deploy` works but skips the confirmation.
- **Read the stack check before confirming.** Creating and redeploying use the same command: a stack that exists is updated, with no error. So before the prompt, the script looks up what is deployed (with the `aws` CLI and your credentials) and lists each stack as `create`, `update` or `busy`. It then warns in red about anything you may not have meant:
  - the environment's user pool is repointed, or sign-in changes identity provider (often a forgotten `-c identity-provider`)
  - the search domain is resized (often a forgotten `-c production=true`)
  - tables or a search domain left over from a destroyed backend will make creating its Data stack fail
  - a stack is mid-operation, or the credentials are for a different account

  With warnings, the prompt asks "Deploy anyway?". The check never blocks a deploy: a lookup that fails, for example for lack of permissions, is listed as a warning and the deploy can go ahead. `--no-check` skips the check.

- **In CI, add `--yes`** to deploy without the prompt. See [Running in CI](#running-in-ci).
- **CDK never creates, changes or deletes a user pool.** The pool needs its own managed login domain and an `admin` group, set up outside CDK. `-c user-pool-id` only records which pool to use.
- **Pass `-c identity-provider=VT-SSO-OIDC` on every backend deploy** if users sign in through VT SSO. If you leave it out, the environment falls back to the pool's own accounts (`COGNITO`).
- **`-c production=true` picks the large search sizing:** three `m7g.medium.search` nodes. It is independent of `backend-env`. Pass it on every `production` deploy, or the next deploy shrinks the domain to the small sizing (one `t3.small.search` node). A frontend's instance size is `frontend:deploy --production` instead. When `backend-env` is `production`, the deploy script prints a red warning, and adds a line if this flag is missing.
- **Deploy and destroy frontends with `npm run frontend:deploy` and `npm run frontend:destroy`.** Both print a plan and ask before changing anything, with a red warning for the `production` backend.
- **Destroying a backend uses `npx cdk destroy`**, which asks for its own confirmation. There is no backend destroy script and no production warning, so check the account before destroying.

---

## First get the logged in account number

```bash
cd infra
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

## Create

### New feature backend, no frontend

```bash
npm run deploy -- -c backend-env=f-<slug> -c aws-account-id=$ACCOUNT \
  -c user-pool-id=<user pool ID> -c identity-provider=VT-SSO-OIDC
```

### New tier backend, no frontend (`dev`, `pre-production`, `production`)

```bash
npm run deploy -- -c backend-env=<env> -c aws-account-id=$ACCOUNT \
  -c user-pool-id=<user pool ID> -c identity-provider=VT-SSO-OIDC
```

For production, run it in the production account and add `-c production=true`:

```bash
npm run deploy -- -c backend-env=production -c aws-account-id=$ACCOUNT -c production=true \
  -c user-pool-id=<user pool ID> -c identity-provider=VT-SSO-OIDC
```

Each backend has an SNS topic for OpenSearch streaming failure alerts (stack output `StreamingAlertTopicArn`). Nobody is subscribed by default; see [Alerting in the OpenSearch streaming runbook](opensearch-streaming.md#alerting) for how to subscribe, and for what to do when an alert arrives.

### New frontend attached to an existing backend

Check out the branch, then:

```bash
npm run frontend:deploy -- --backend-env <env>
```

Notes:

- The backend's Api and Auth stacks must already be deployed: the frontend reads the API URL, user pool and identity provider from the backend's SSM parameters.
- `--branch <name>` deploys another branch than the current one.
- **The deploy ships the commit at HEAD, not your working tree.** Commit what you want deployed first. Uncommitted and untracked changes are left out, and listed before the prompt.
- The certificate defaults to the stored wildcard certificate for `*.dlp-access-dev.dlp.cloud.lib.vt.edu`. Pass `--certificate <ACM certificate ARN>` only to use a different one, which must be in the same account and region.
- Add `--production` for a production-sized instance.
- The frontend creates its own Cognito app client on the environment's pool. The provider named by the backend's `identity-provider` must exist on the pool, or creating the client fails.
- It waits for the new environment, then points the branch's domain name at it. `npm run frontend:status` prints the URL and sign-in settings afterwards.

### Update a frontend

Run the same command. When the branch's frontend exists, `frontend:deploy` only ships HEAD to it. It refuses if the frontend was created for another branch name with the same slug, or for another backend. Settings made at creation (certificate, instance size, environment variables) aren't changed; change them with `eb setenv` / `eb config`, or destroy and redeploy the frontend.

### New backend and new frontend together

Deploy the backend, then the frontend:

```bash
npm run deploy -- -c backend-env=<env> -c aws-account-id=$ACCOUNT \
  -c user-pool-id=<user pool ID> -c identity-provider=VT-SSO-OIDC
npm run frontend:deploy -- --backend-env <env>
```

For production, add `-c production=true` to the first and `--production` to the second.

---

## Destroy

### A specific frontend

```bash
npm run frontend:destroy -- --backend-env <env> --branch <branch>
```

Notes:

- `<env>` is the backend the frontend is attached to. The command refuses a frontend tagged for another backend, whose Cognito client would be left behind.
- `<branch>` can be the branch name or its slug, so you don't need the branch checked out.
- This terminates the Beanstalk environment, then deletes the DNS record, the Cognito app client and the client secret. Each step skips what is already gone, so re-run it if it stops partway. The backend and the user pool are not affected.

### All frontends attached to a backend

Each frontend's Beanstalk environment is tagged `dlpnext:backend-env=<env>`. To list the frontends attached to a backend:

```bash
aws resourcegroupstaggingapi get-resources --region us-east-1 \
  --resource-type-filters elasticbeanstalk:environment \
  --tag-filters Key=dlpnext:backend-env,Values=<env> \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
```

Then destroy each one by its slug (the environment name without `dlpnext-`):

```bash
for arn in $(aws resourcegroupstaggingapi get-resources --region us-east-1 \
    --resource-type-filters elasticbeanstalk:environment \
    --tag-filters Key=dlpnext:backend-env,Values=<env> \
    --query 'ResourceTagMappingList[].ResourceARN' --output text); do
  npm run frontend:destroy -- --backend-env <env> --branch "${arn##*/dlpnext-}"
done
```

Notes:

- `frontend:destroy` asks before each frontend. Run in CI with `--yes` to skip the prompts, after checking the list.
- Beanstalk environments made outside the `frontend:*` commands, such as the PR-preview workflow's environments, aren't tagged and aren't found this way. If they use this backend's instance profile, delete them separately.

### A backend

**Destroy the backend's frontends first** (see above). Frontends find their backend by name, not through cross-stack references, so CloudFormation won't stop you from deleting a backend that frontends still use. Those frontends would lose their instance role, the API and the SSM parameters they read.

```bash
npx cdk destroy --all -c backend-env=<env> -c aws-account-id=$ACCOUNT -c user-pool-id=<user pool ID>
```

Notes:

- `-c user-pool-id` is needed only because the app checks it whenever the backend stacks are in the app. It must be a well-formed pool ID in the environment's region. **The pool is not deleted.** Destroying the Auth stack deletes only its two SSM parameters.
- The app contains only the three backend stacks, so `--all` destroys only them.
- **Tables:** tier tables (`dev`, `pre-production`, `production`) are kept, with deletion protection still on. Recreating the tier fails until you delete or import them. Feature environment tables are deleted.
- **OpenSearch:** the domain is deleted in every environment, along with its indexes.
- To skip CDK and the `-c user-pool-id` check, delete the stacks with CloudFormation instead, Api first because it uses the Data stack's resources:

  ```bash
  aws cloudformation delete-stack --region us-east-1 --stack-name DlpAccessNext-<env>-Api
  aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name DlpAccessNext-<env>-Api
  aws cloudformation delete-stack --region us-east-1 --stack-name DlpAccessNext-<env>-Data
  aws cloudformation delete-stack --region us-east-1 --stack-name DlpAccessNext-<env>-Auth
  ```

---

## Running in CI

Every deploy command above, and `frontend:destroy`, works in CI with `--yes` added. Every `cdk destroy` command works with `--force` added.

```bash
npm run deploy -- --yes -c backend-env=<env> -c aws-account-id=$ACCOUNT …
npx cdk destroy --all --force -c backend-env=<env> -c aws-account-id=$ACCOUNT …
```

### What `--yes` does

- **It skips the script's confirmation.** The plan and the production warning (and, for `frontend:deploy`, the deployed commit and any uncommitted changes) are still printed to the job log, followed by `Confirmed by --yes (CI).`
- **For `npm run deploy`, it also answers CDK's approval prompt.** It adds `--require-approval never`, so CDK doesn't stop to approve IAM policy or security group changes. If you pass your own `--require-approval`, that one is used instead.
- **`npm run deploy`'s stack check still runs.** Its stack list and warnings go to the job log, but they don't stop the deploy. Add `--no-check` to skip the lookups, for example when the job's role can't describe the stacks, tables and search domain.
- **It's for the scripts only.** `-y` means the same thing. `npm run deploy` removes the flag before calling `cdk deploy`.
- **It only works in CI.** The `CI` environment variable must be `true` or `1`; GitHub Actions sets it. Otherwise the script stops with `--yes only applies in CI (CI=true); run without it to confirm the deploy`. On your own machine, answer the prompt.
- **Production isn't treated differently.** `--yes` skips the production prompt too. The approval for production belongs to the pipeline, such as required reviewers on a GitHub Environment named `production`.
