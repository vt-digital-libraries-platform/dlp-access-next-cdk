# dlp-access-next

The VT Digital Libraries access site: a Next.js 16 / React 19 app running on Elastic Beanstalk, backed by a read-only AppSync GraphQL API over DynamoDB and OpenSearch. All of the AWS infrastructure is defined with CDK in `infra/`.

The repo holds two independent npm projects, each with its own `package.json`:

- `/` - The Next.js app (App Router, Tailwind 4)
- `infra/` - CDK v2 (TypeScript): the data layer, API and Elastic Beanstalk hosting

## Backend Environments and stacks

Each **backend environment** has its own Data, API, and Auth stacks. Backend "tier" environments are `dev`, `pre-production`, and `production` (which belongs in a separate AWS account), or short-lived feature environments named as: `f-<slug>`.

| Stack                        | Contents                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DlpAccessNext-<env>-Data`   | Seven DynamoDB tables (`<Model>-dlpnext-<env>`) and an OpenSearch 2.19 domain (`dlpnext-<env>`)                                                                                                                                                                                                                                       |
| `DlpAccessNext-<env>-Api`    | The AppSync API (IAM auth), the Lambda that streams Archive and Collection changes into OpenSearch, and the environment's Beanstalk instance role (`dlp-access-next-<env>-eb`)                                                                                                                                                        |
| `DlpAccessNext-<env>-Auth`   | A pointer to the environment's existing Cognito user pool and identity provider (two SSM parameters). The pool itself is made outside CDK                                                                                                                                                                                             |
| `DlpAccessNext-Web-<branch>` | One git branch of the dlp-access-next app: an Elastic Beanstalk application in a Node.js environment (`dlpnext-<branch>`, one instance behind an HTTPS load balancer) at `https://<branch>.dlp-access-dev.dlp.cloud.lib.vt.edu`, that calls one environment's API, and the branch's Cognito app client on the environment's user pool |

Multiple branches can share one backend environment. Only feature environments delete their tables and opensearch domain when their stacks are destroyed. `dev`, `pre-production` and `production` keep their data and have deletion protection and point-in-time recovery turned on.

## Running locally

```bash
npm install
APPSYNC_API_URL=< GraphQL Api Url > npm run dev
```

When run locally, the app signs AppSync requests with your local AWS credentials, so you need to be logged in to the account, with permission to call the API. Open http://localhost:3000/examples/appsync-queries to run every query in the schema. (requires VT sso auth, with `admin`)

Locally, put Cognito config in `.env.local` (git-ignored)

| Variable                    | Value                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COGNITO_ISSUER`            | `https://cognito-idp.<region>.amazonaws.com/<user pool ID>`                                                                                                                              |
| `COGNITO_CLIENT_ID`         | The app client's ID                                                                                                                                                                      |
| `COGNITO_CLIENT_SECRET`     | The app client's secret                                                                                                                                                                  |
| `COGNITO_IDENTITY_PROVIDER` | The identity provider on the user pool to sign in through, such as `VT-SSO-OIDC`; sign-in goes straight to it. Without it, managed login shows whatever the app client allows. |
| `APP_BASE_URL`              | Optional. The app's public origin, when it differs from the one the server sees (behind a proxy). Defaults to the request's origin.                                                      |

A Web stack's app client already allows `http://localhost:3000`. Any other app client needs `<origin>/authorize` as an allowed callback URL, `<origin>/` as an allowed sign-out URL, and the `openid` and `email` scopes. Cognito only accepts `http` callback URLs for `localhost`.

Other checks: `npm run build`, `npm run lint`, `npx tsc --noEmit`.

## Deploying

Run everything from `infra/`, and log in to AWS first. `-c backend-env` and `-c aws-account-id` (the 12-digit ID of the AWS account to deploy to) are required, and so is `-c user-pool-id` whenever an environment's stacks are deployed.

```bash
cd infra
npm install

# returns AWS account id of the account logged into
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# Deploy a backend environment (dev). Data and API stacks, using an existing Cognito user pool and its federated identity provider
npm run deploy -- -c backend-env=dev -c aws-account-id=$ACCOUNT -c user-pool-id=<user pool ID> -c identity-provider=VT-SSO-OIDC

# Deploy a frontend branch, attached to an environment that is already deployed (dev)
npm run deploy -- -c backend-env=dev -c aws-account-id=$ACCOUNT -c frontend-branch=$(git branch --show-current)

# Deploy a frontend branch, attached to a new "feature" backend environment for it
npm run deploy -- -c backend-env=f-search -c aws-account-id=$ACCOUNT -c frontend-branch=$(git branch --show-current) -c backend=provision \
  -c user-pool-id=<user pool ID> -c identity-provider=VT-SSO-OIDC

# Deploy Production: its own account, with production sizing
npm run deploy -- -c backend-env=production -c aws-account-id=<production account ID> -c production=true -c user-pool-id=<user pool ID>
```

`npm run deploy` checks the options, lists them with the stacks they produce, and runs `cdk deploy --all`.
With `-c backend-env=production` a red warning banner comes first, and it also points out when `-c production=true` is missing.

### Options

- `-c backend=attach` is the default. It deploys only the Web stack and needs the environment's Api and Auth stacks to exist already; otherwise the deploy fails with "Unable to fetch parameters".
- `-c backend=provision` deploys a new backend environment's Data, Api and Auth stacks, before the Web stack.
- `-c user-pool-id=<user pool ID>` is the existing Cognito user pool, in the environment's region, that the environment's users sign in to. It is required on every deploy of the backend environment's stacks. Passing a different ID repoints the backend environment, and each Web stack moves its app client to the new pool the next time it deploys.
- `-c identity-provider=<name>` names the federated identity provider on the user pool that users sign in through, such as `VT-SSO-OIDC`. Like `-c user-pool-id`, pass it on every deploy of the environment's stacks.
- `-c certificate=<ARN>` is optional with `-c frontend-branch`; it defaults to the certificate whose ID is `CERTIFICATE_ID` in `infra/lib/web-stack.ts`, in the deploy's account and the environment's region. Each branch is served at `https://<branch>.dlp-access-dev.dlp.cloud.lib.vt.edu` (a CNAME in the `dlp.cloud.lib.vt.edu` hosted zone) The URL is registered for sign-in on the branch's Cognito app client and set as `APP_BASE_URL`.
- Deploying the same branch with a different `backend-env` repoints its Web stack at that environment.
- `-c production=true` switches to production sizing: three OpenSearch nodes across three AZs instead of one, and a `t3.medium` Beanstalk instance instead of `t3.small`. It defaults to false and is separate from the environment name, so pass it for the real `production` deploy.
- No account IDs are stored in the repo, and nothing ties an environment to an account: `-c aws-account-id` alone decides where the stacks go, so double-check it, especially for `production`.
- Branch names become slugs (`whunter/Multi_Env` becomes `whunter-multi-env`) of at most 32 characters. Environment names are lowercase and at most 20 characters.
- The Web stack's `AppUrl` output is the app's address. `EndpointUrl` is the load balancer's own name, which the certificate does not cover.

Destroy a frontend branch:

```bash
npx cdk destroy DlpAccessNext-Web-<branch> -c backend-env=<env> -c aws-account-id=$ACCOUNT -c frontend-branch=<branch>
```

Destroy a backend env (must delete attached frontends first):

```bash
# destroy's current branch frontend
npx cdk destroy --all -c backend-env=dev -c aws-account-id=$ACCOUNT -c frontend-branch=$(git branch --show-current) && \
npx cdk destroy --all -c backend-env=dev -c aws-account-id=$ACCOUNT -c user-pool-id=<user pool ID>
```

## Tests

```bash
cd infra
npm test              # Jest: assertions on the synthesized templates
python3 -m venv .venv && .venv/bin/pip install -r lambda/requirements-dev.txt # one-time setup for test:lambda
npm run test:lambda   # pytest: the OpenSearch streaming handler
```


## More

- `infra/schema/schema.graphql`: the GraphQL schema, which is the source of truth for the API.
- `docs/deployment.md`: More exhaustive instructions for running deployments.
