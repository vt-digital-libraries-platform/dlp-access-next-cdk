# dlp-access-next

The VT Digital Libraries access site: a Next.js 16 / React 19 app running on Elastic Beanstalk, backed by a read-only AppSync GraphQL API over DynamoDB and OpenSearch. Each backend is a set of CDK stacks in `infra/`; each frontend is an Elastic Beanstalk environment that the `frontend:*` commands in `infra/` create and remove.

The repo holds two independent npm projects, each with its own `package.json`:

- `/` - The Next.js app (App Router, Tailwind 4)
- `infra/` - CDK v2 (TypeScript) for the backends (data layer, API, sign-in pointers), and the `frontend:*` commands that host branches on Elastic Beanstalk

## Backend Environments and stacks

Each **backend environment** has its own Data, API, and Auth stacks. Backend "tier" environments are `dev`, `pre-production`, and `production` (which belongs in a separate AWS account), or short-lived feature environments named as: `f-<slug>`.

| Stack                      | Contents                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DlpAccessNext-<env>-Data` | Seven DynamoDB tables (`<Model>-dlpnext-<env>`) and an OpenSearch 2.19 domain (`dlpnext-<env>`)                                                                                                                                                                |
| `DlpAccessNext-<env>-Api`  | The AppSync API (IAM auth), the Lambda that streams Archive and Collection changes into OpenSearch (with failure alerts and a resync function, see `docs/opensearch-streaming.md`), and the environment's Beanstalk instance role (`dlp-access-next-<env>-eb`) |
| `DlpAccessNext-<env>-Auth` | A pointer to the environment's existing Cognito user pool and identity provider (two SSM parameters). The pool itself is made outside CDK                                                                                                                      |

## Frontends

A **frontend** is one git branch of the app, served at `https://<branch slug>.dlp-access-dev.dlp.cloud.lib.vt.edu`. It is not a CDK stack: `npm run frontend:deploy` creates it, and it consists of:

- an Elastic Beanstalk environment `dlpnext-<branch slug>` (Node.js, one instance behind an HTTPS load balancer) in the account's shared `dlpnext` application, tagged with its branch and backend environment
- a Cognito app client `dlpnext-<branch slug>` on the backend environment's user pool, with its secret in Secrets Manager at `dlpnext/<branch slug>/cognito-client-secret`
- a CNAME for its domain in the `dlp.cloud.lib.vt.edu` hosted zone

Multiple branches can share one backend environment. Only feature environments delete their tables and opensearch domain when their stacks are destroyed. `dev`, `pre-production` and `production` keep their data and have deletion protection and point-in-time recovery turned on.

## Running locally

```bash
npm install
APPSYNC_API_URL=< GraphQL Api Url > npm run dev
```

When run locally, the app signs AppSync requests with your local AWS credentials, so you need to be logged in to the account, with permission to call the API. Open http://localhost:3000/examples/appsync-queries to run every query in the schema. (requires VT sso auth, with `admin`)

Locally, put Cognito config in `.env.local` (git-ignored)

| Variable                    | Value                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COGNITO_ISSUER`            | `https://cognito-idp.<region>.amazonaws.com/<user pool ID>`                                                                                                                    |
| `COGNITO_CLIENT_ID`         | The app client's ID                                                                                                                                                            |
| `COGNITO_CLIENT_SECRET`     | The app client's secret                                                                                                                                                        |
| `COGNITO_IDENTITY_PROVIDER` | The identity provider on the user pool to sign in through, such as `VT-SSO-OIDC`; sign-in goes straight to it. Without it, managed login shows whatever the app client allows. |
| `APP_BASE_URL`              | Optional. The app's public origin, when it differs from the one the server sees (behind a proxy). Defaults to the request's origin.                                            |

A frontend's app client already allows `http://localhost:3000`, and `npm run frontend:status` (in `infra/`) prints its issuer, client ID and where its secret is. Any other app client needs `<origin>/authorize` as an allowed callback URL, `<origin>/` as an allowed sign-out URL, and the `openid` and `email` scopes. Cognito only accepts `http` callback URLs for `localhost`.

Other checks: `npm run build`, `npm run lint`, `npx tsc --noEmit`.

## Deploying

Run everything from `infra/`, and log in to AWS first. Backends and frontends deploy with separate commands: provisioning a new backend and a frontend for it is `npm run deploy`, then `npm run frontend:deploy`.

```bash
cd infra
npm install

# returns AWS account id of the account logged into
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# Deploy a backend environment (dev): Data, Api and Auth stacks, using an existing Cognito user pool and its federated identity provider
npm run deploy -- -c backend-env=dev -c aws-account-id=$ACCOUNT -c user-pool-id=<user pool ID> -c identity-provider=VT-SSO-OIDC

# Deploy Production: its own account, with production sizing
npm run deploy -- -c backend-env=production -c aws-account-id=<production account ID> -c production=true -c user-pool-id=<user pool ID>

# Deploy the current branch's frontend, attached to a backend that is already deployed (dev). Creates it the first time, then pushes HEAD
npm run frontend:deploy -- --backend-env dev

# Show where a frontend is and how it signs in
npm run frontend:status
```

`npm run deploy` checks the options, lists them with the stacks they produce, and runs `cdk deploy --all`. `npm run frontend:deploy` prints its plan and the commit it will ship, and asks before changing anything.
With the `production` backend, both print a red warning banner first, which also points out when production sizing (`-c production=true`, `--production`) is missing.

### Backend options (`npm run deploy`)

- `-c backend-env=<env>` and `-c aws-account-id=<12-digit ID>` are required. No account IDs are stored in the repo, and nothing ties an environment to an account: `-c aws-account-id` alone decides where the stacks go, so double-check it, especially for `production`.
- `-c user-pool-id=<user pool ID>` is the existing Cognito user pool, in the environment's region, that the environment's users sign in to. It is required on every backend deploy. Passing a different ID repoints the backend environment; each frontend keeps its app client on the old pool until it is destroyed and recreated.
- `-c identity-provider=<name>` names the federated identity provider on the user pool that users sign in through, such as `VT-SSO-OIDC`. Like `-c user-pool-id`, pass it on every deploy of the environment's stacks.
- `-c production=true` switches to production sizing: three OpenSearch nodes across three AZs instead of one. It defaults to false and is separate from the environment name, so pass it for the real `production` deploy.
- Environment names are lowercase and at most 20 characters.
- The old frontend options (`frontend-branch`, `backend`, `certificate`) are rejected: frontends deploy with `npm run frontend:deploy`.

### Frontend options (`npm run frontend:deploy`)

- `--backend-env <env>` is required: the backend the frontend calls and signs in through. It must already be deployed. A frontend stays on its backend; to move it, destroy it and deploy it again.
- `--branch <name>` defaults to the current git branch. Branch names become slugs (`whunter/Multi_Env` becomes `whunter-multi-env`) of at most 32 characters.
- The deploy ships the commit at HEAD, not the working tree.
- `--production` uses a `t3.medium` instance instead of `t3.small`. `--certificate <ARN>` overrides the default certificate, `CERTIFICATE_ID` in `infra/lib/config/web.ts`, in the deploy's account and region. Both, like the rest of the environment's settings, apply only when the frontend is created.
- `--profile <profile>` picks the AWS credentials.

Destroy a frontend branch:

```bash
npm run frontend:destroy -- --backend-env <env> --branch <branch>
```

Destroy a backend env (destroy its frontends first; see `docs/deployment.md`):

```bash
npx cdk destroy --all -c backend-env=dev -c aws-account-id=$ACCOUNT -c user-pool-id=<user pool ID>
```

## Tests

```bash
cd infra
npm test              # Jest: assertions on the synthesized templates
python3 -m venv .venv && .venv/bin/pip install -r lambda/requirements-dev.txt # one-time setup for test:lambda
npm run test:lambda   # pytest: the OpenSearch streaming and resync handlers
```

## More

- `infra/schema/schema.graphql`: the GraphQL schema, which is the source of truth for the API.
- `docs/deployment.md`: More exhaustive instructions for running deployments.
- `docs/opensearch-streaming.md`: How Archive and Collection changes reach OpenSearch, the alerts for failed batches, and how to recover them.
