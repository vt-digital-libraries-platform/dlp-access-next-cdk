# dlp-access-next

The next version of the VT Digital Libraries access site: a Next.js 16 / React 19 app on Elastic Beanstalk, backed by a read-only AppSync GraphQL API over DynamoDB and OpenSearch. All of the AWS infrastructure is defined with CDK in `infra/`.

The repo holds two independent npm projects, each with its own `package.json`:

| Path | What it is |
| --- | --- |
| `/` | The Next.js app (App Router, Tailwind 4) |
| `infra/` | CDK v2 (TypeScript): the data layer, API and Elastic Beanstalk hosting |

## Environments and stacks

Each **environment** has its own data and API. Environments are `dev`, `pre-production`, `production` (which belongs in a separate AWS account), or a short-lived feature environment named `f-<slug>`.

| Stack | Contents |
| --- | --- |
| `DlpAccessNext-<env>-Data` | Seven DynamoDB tables (`<Model>-dlpnext-<env>`) and an OpenSearch 2.19 domain (`dlpnext-<env>`) |
| `DlpAccessNext-<env>-Api` | The AppSync API (IAM auth), the Lambda that streams Archive and Collection changes into OpenSearch, and the environment's Beanstalk instance role (`dlp-access-next-<env>-eb`) |
| `DlpAccessNext-Web-<branch>` | One git branch of the Next.js app: a Beanstalk application and single-instance Node.js 24 environment (`dlpnext-<branch>`) that calls one environment's API |

Many branches can share one environment. Only feature environments delete their tables and domain when their stacks are destroyed. `dev`, `pre-production` and `production` keep their data and have deletion protection and point-in-time recovery turned on.

## Running locally

```bash
npm install
APPSYNC_API_URL=<GraphQLApiUrl output of an Api stack> npm run dev
```

The app signs AppSync requests with your local AWS credentials, so you need to be logged in to the account, with permission to call the API. Open http://localhost:3000/examples/appsync-queries to run every query in the schema.

Other checks: `npm run build`, `npm run lint`, `npx tsc --noEmit`.

## Deploying

Run everything from `infra/`, and log in to AWS first. `-c env` and `-c account` (the 12-digit ID of the AWS account to deploy to) are required.

```bash
cd infra
npm install
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)   # the account you're logged in to

# An environment's data and API
npx cdk deploy --all -c env=dev -c account=$ACCOUNT

# Your branch of the app, attached to an environment that is already deployed
npx cdk deploy --all -c env=dev -c account=$ACCOUNT -c branch=$(git branch --show-current)

# Your branch of the app plus a new feature environment for it
npx cdk deploy --all -c env=f-search -c account=$ACCOUNT -c branch=$(git branch --show-current) -c backend=provision
```

- `-c backend=attach` is the default. It deploys only the Web stack and needs the environment's Api stack to exist already; otherwise the deploy fails with "Unable to fetch parameters".
- `-c backend=provision` also deploys the environment's Data and Api stacks, before the Web stack.
- Deploying the same branch with a different `env` repoints its Web stack at that environment.
- `-c production=true` switches to production sizing: three OpenSearch nodes across three AZs instead of one, and a `t3.medium` Beanstalk instance instead of `t3.small`. It defaults to false and is separate from the environment name, so pass it for the real `production` deploy.
- No account IDs are stored in the repo, and nothing ties an environment to an account: `-c account` alone decides where the stacks go, so double-check it, especially for `production`.
- Branch names become slugs (`whunter/Multi_Env` becomes `whunter-multi-env`) of at most 32 characters. Environment names are lowercase and at most 20 characters.
- The Web stack's `EndpointUrl` output and the Beanstalk console give the app's address. It serves HTTP only, with no load balancer or custom domain.

To tear down a branch deployment:

```bash
npx cdk destroy DlpAccessNext-Web-<branch> -c env=<env> -c account=$ACCOUNT -c branch=<branch>
```

## Tests

```bash
cd infra
npm test              # Jest: assertions on the synthesized templates
npm run test:lambda   # pytest: the OpenSearch streaming handler
```

`test:lambda` needs a one-time setup: `python3 -m venv .venv && .venv/bin/pip install -r lambda/requirements-dev.txt`.

## More

- `CLAUDE.md`: architecture, naming rules and gotchas (AppSync JS runtime, OpenSearch paging, streaming failures).
- `docs/issues/multi-env-data-layer.md`: the spec for the per-environment data layer.
- `infra/schema/schema.graphql`: the GraphQL schema, which is the source of truth for the API.
