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
| `DlpAccessNext-<env>-Auth` | The environment's Cognito user pool (`dlpnext-<env>`, with an `admin` group and a managed login domain), or a pointer to an existing pool |
| `DlpAccessNext-Web-<branch>` | One git branch of the Next.js app: a Beanstalk application and single-instance Node.js 24 environment (`dlpnext-<branch>`) that calls one environment's API, and the branch's Cognito app client on the environment's user pool |

Many branches can share one environment. Only feature environments delete their tables and domain when their stacks are destroyed. `dev`, `pre-production` and `production` keep their data and have deletion protection and point-in-time recovery turned on.

## Running locally

```bash
npm install
APPSYNC_API_URL=<GraphQLApiUrl output of an Api stack> npm run dev
```

The app signs AppSync requests with your local AWS credentials, so you need to be logged in to the account, with permission to call the API. Open http://localhost:3000/examples/appsync-queries to run every query in the schema.

That page requires signing in through a Cognito user pool's managed login, as a member of the pool's `admin` group. A Web stack sets these on its Beanstalk environment. Locally, put them in `.env.local` (git-ignored): the issuer, client ID and identity provider are the Web stack's `CognitoIssuer`, `CognitoClientId` and `CognitoIdentityProvider` outputs, and `aws cognito-idp describe-user-pool-client --user-pool-id <id> --client-id <id> --query UserPoolClient.ClientSecret` prints the secret.

| Variable | Value |
| --- | --- |
| `COGNITO_ISSUER` | `https://cognito-idp.<region>.amazonaws.com/<user pool ID>` |
| `COGNITO_CLIENT_ID` | The app client's ID |
| `COGNITO_CLIENT_SECRET` | The app client's secret |
| `COGNITO_IDENTITY_PROVIDER` | Optional. The identity provider on the user pool to sign in through, such as `VT-SSO-OIDC`; sign-in goes straight to it. Without it, managed login shows whatever the app client allows. |
| `APP_BASE_URL` | Optional. The app's public origin, when it differs from the one the server sees (behind a proxy). Defaults to the request's origin. |

A Web stack's app client already allows `http://localhost:3000`. Any other app client needs `<origin>/authorize` as an allowed callback URL, `<origin>/` as an allowed sign-out URL, and the `openid` and `email` scopes. Cognito only accepts `http` callback URLs for `localhost`.

Other checks: `npm run build`, `npm run lint`, `npx tsc --noEmit`.

## Deploying

Run everything from `infra/`, and log in to AWS first. `-c env` and `-c account` (the 12-digit ID of the AWS account to deploy to) are required.

```bash
cd infra
npm install
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)   # the account you're logged in to

# An environment's data, API and a new Cognito user pool
npm run deploy -- -c env=dev -c account=$ACCOUNT

# The same, using an existing Cognito user pool and its federated identity provider
npm run deploy -- -c env=dev -c account=$ACCOUNT -c userPool=<user pool ID> -c identityProvider=VT-SSO-OIDC

# Your branch of the app, attached to an environment that is already deployed
npm run deploy -- -c env=dev -c account=$ACCOUNT -c branch=$(git branch --show-current)

# Your branch of the app plus a new feature environment for it
npm run deploy -- -c env=f-search -c account=$ACCOUNT -c branch=$(git branch --show-current) -c backend=provision

# A new Cognito user pool with VT SSO as its identity provider
npm run deploy -- -c env=f-search -c account=$ACCOUNT -c identityProvider=VT-SSO-OIDC \
  -c identityProviderClientId=<client ID> -c identityProviderSecret=<Secrets Manager secret name>

# Production: its own account, with production sizing
npm run deploy -- -c env=production -c account=<production account ID> -c production=true
```

`npm run deploy` checks the options, lists them with the stacks they produce, and runs `cdk deploy --all` with the same arguments only if you answer `y` or `yes`. Any other answer deploys nothing. With `-c env=production` a red warning banner comes first, and it also points out when `-c production=true` is missing. Other `cdk deploy` flags pass through. Running `npx cdk deploy` directly skips the confirmation.

- `-c backend=attach` is the default. It deploys only the Web stack and needs the environment's Api and Auth stacks to exist already; otherwise the deploy fails with "Unable to fetch parameters".
- `-c backend=provision` also deploys the environment's Data, Api and Auth stacks, before the Web stack.
- `-c userPool=<user pool ID>` uses an existing user pool, in the environment's region, instead of provisioning one. The pool itself is left as it is, so it needs a managed login domain and an `admin` group already. Pass it on every deploy of the environment's stacks: leaving it out switches the environment to a new pool.
- `-c identityProvider=<name>` names the federated identity provider on the user pool that users sign in through, such as `VT-SSO-OIDC`. Each branch's app client then allows only that provider and the app sends users straight to it. It has to exist on the pool before a Web stack deploys. With `-c userPool` the existing pool's provider is used as it is. Without the option, users are the pool's own. Like `-c userPool`, pass it on every deploy of the environment's stacks.
- `-c identityProviderClientId=<client ID>` and `-c identityProviderSecret=<secret name>` (both, with `-c identityProvider` and a new pool) make the Auth stack create the provider as an OIDC provider. `-c identityProviderIssuer=<https URL>` sets the issuer, which defaults to VT SSO (`https://gateway.login.vt.edu`). Before deploying:
  1. Have the provider allow the redirect URI that the deploy confirmation prints as `Provider redirect` (`https://dlpnext-<env>-<account>.auth.<region>.amazoncognito.com/oauth2/idpresponse`).
  2. Store the client secret, as plain text, in Secrets Manager in the same account and region: `aws secretsmanager create-secret --name <secret name> --secret-string '<client secret>'`. Only its name is passed, so the secret stays out of the template and your shell history holds it once.

  Without these two options, add the provider to the new pool by hand after the environment deploys.
- `-c appUrl=https://<host>` (with `-c branch`) registers the app's public origin for sign-in on the branch's app client. Cognito only accepts `http` for localhost and the Beanstalk environments serve HTTP only, so until the app has HTTPS in front of it, sign-in works only when it runs on `localhost:3000`.
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
