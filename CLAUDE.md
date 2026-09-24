# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Two independent npm projects, each with its own `package.json` and `node_modules`:

- **Root**: Next.js 16 / React 19 app (App Router, Tailwind 4). Deployed to Elastic Beanstalk (`.elasticbeanstalk/`, `.platform/`, PR-preview workflows in `.github/workflows/`).
- **`infra/`**: CDK v2 (TypeScript). Each environment gets two stacks. `DlpAccessNext-<env>-Data` holds the DynamoDB tables and the OpenSearch domain. `DlpAccessNext-<env>-Api` holds the AppSync API, the Lambda that streams table changes to OpenSearch, and the environment's Elastic Beanstalk instance role. Each git branch of the Next.js app can get a `DlpAccessNext-Web-<branch>` stack, an Elastic Beanstalk application and environment that uses one environment's API. The Amplify apps still run separately with their own data. The spec is `docs/issues/multi-env-data-layer.md`.

## Commands

Root: `npm run dev`, `npm run build`, `npm run lint`, `npx tsc --noEmit`. The root app has no test suite.

CDK: run everything from `infra/`, or `--app is required` is raised.

```bash
cd infra
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx cdk synth  --all -c env=dev -c account=$ACCOUNT
npx cdk deploy --all -c env=dev -c account=$ACCOUNT
npx cdk deploy --all -c env=dev -c account=$ACCOUNT -c branch=$(git branch --show-current)                          # Web stack on the existing dev stacks
npx cdk deploy --all -c env=f-search -c account=$ACCOUNT -c branch=$(git branch --show-current) -c backend=provision # also deploys f-search's Data and Api
npm test                 # Jest: assertions on each environment's synthesized templates
npm run test:lambda      # pytest: streaming handler (one-time setup: python3 -m venv .venv && .venv/bin/pip install -r lambda/requirements-dev.txt)
```

- `env` is required. Allowed values are `dev`, `pre-production`, `production`, or `f-<slug>` for a feature environment, which uses dev's settings except for data protection. Names are lowercase and at most 20 characters, because the domain is `dlpnext-<env>` and OpenSearch allows 28. Per-environment settings (region, sizing, removal policy) live in `infra/lib/environments.ts`.
- `account` is required: the 12-digit AWS account ID to deploy to. No account IDs are stored in the repo. `production` belongs in a separate account from the others.
- Only feature environments (`f-<slug>`) delete their data when their stacks are destroyed. `dev`, `pre-production` and `production` keep their tables and domain, and turn on table deletion protection and PITR.
- `-c branch` adds a Web stack. The branch name is slugified (`whunter/Multi_Env` becomes `whunter-multi-env`); the Beanstalk application and environment are named `dlpnext-<slug>`, so the slug can be at most 32 characters. With `-c backend=attach` (the default), the app contains only the Web stack, and the environment's Api stack must already be deployed; otherwise the deploy fails with "Unable to fetch parameters". With `-c backend=provision`, the app also contains the environment's Data and Api stacks, and the Web stack deploys after them. Deploying the same branch with a different `env` repoints its existing Web stack.
- Deploys are user-run (the auto-mode classifier blocks Claude from running them); hand the user the command to run with `!`.

The Next.js server needs `APPSYNC_API_URL` set to the Api stack's `GraphQLApiUrl` output; the Web stack sets it for you. Beanstalk environments made outside CDK (the PR-preview workflow's `dev-env-sc` template, `eb deploy`) must set it themselves and use the `EbInstanceProfileName` output (`dlp-access-next-<env>-eb`) as their instance profile.

## Architecture

- **Schema is the source of truth**: `infra/schema/schema.graphql`. It is read-only (Query only, no Mutation/Subscription), and Archive/Collection are searchable through `fulltextArchives`, `fulltextCollections` and `searchObjects` (returns `[CatalogItem]`).
- **Resolvers are generated code strings**: `infra/lib/resolvers.ts` has generators (`getByIdCode`, `listScanCode`, `queryByIndexCode`, `hasOneCode`, `hasManyCode`, `openSearchQueryCode`) that emit APPSYNC_JS 1.0.0 source. `infra/lib/api-stack.ts` wires them to data sources. The model list, list-query names and GSIs are in `infra/lib/models.ts` (`MODELS`, `LIST_QUERY_FIELD`, `GLOBAL_INDEXES`), which the Data stack also uses to create the tables. Adding a model means updating the schema and `models.ts`.
- **Tables and search copy the vtdlpdev Amplify resources**. Tables are named `<Model>-dlpnext-<env>`, with hash key `id`, the same GSIs and `NEW_AND_OLD_IMAGES` streams. The streaming handler (`infra/lambda/opensearch-streaming/`, Amplify's Python function) names the index after the table name's first `-` segment, lowercased, so table names must start with `<Model>-`. Only Archive and Collection are streamed. Indices use dynamic mapping; an index-template custom resource sets only `auto_expand_replicas: 0-1`.
- **Streaming failures**: the handler re-raises errors (Amplify's version swallowed them). The event source mapping then retries 3 times, bisects the batch, and sends records that still fail to the `OpenSearchStreamingFailureQueueUrl` SQS queue. Rows written before the Api stack existed are never indexed (the stream starts at `LATEST`).
- **Web stacks find their environment by name, not by cross-stack reference**, so they can attach to stacks deployed from another CDK app run. The instance profile is `dlp-access-next-<env>-eb`, and the Api stack writes the API URL to the SSM parameter `/dlp-access-next/<env>/graphql-api-url`, which CloudFormation resolves at deploy time. Both names come from `infra/lib/environments.ts`. The source bundle is the repo root minus `.gitignore` entries, `infra`, docs and `.env*` (see `BUNDLE_EXCLUDES` in `infra/lib/web-stack.ts`), and the Node.js 24 platform's prebuild hook (`.platform/hooks/prebuild`) builds it. `SOLUTION_STACK` pins the platform version; managed updates apply minor versions in place. Environments are single-instance, with no load balancer or custom domain.
- **Auth is IAM only**. Each environment's own Elastic Beanstalk instance role (`dlp-access-next-<env>-eb`) is granted `appsync:GraphQL`. The OpenSearch domain has no resource policy, so access comes only from the IAM grants on the roles that need it. The Next.js side signs requests with SigV4 in `src/lib/appsync.ts` (`aws4fetch` plus the Node credential chain), so it must only run server-side.
- **Demo page**: `src/app/examples/appsync-queries/` runs every query in the schema. The `list*` results seed the arguments for the `get*`, `*ByIdentifier` and search queries. Empty tables produce "skipped" entries instead of failures.

## AppSync JS runtime gotchas

- Variables cannot be reassigned (`let x = ...; x = ...` fails). Deploy validation reports only "The code contains one or more errors", so build values with a single `const` expression.
- `util.transform.toElasticsearchQueryDSL` returns a JSON *string*; wrap it in `JSON.parse`.
- Results typed as an interface (`CatalogItem`) need `__typename` set on each item. A Collection is identified by `collection_category`, otherwise it is an Archive.
- OpenSearch paging uses `search_after` sorted on `<field>.keyword` (except `visibility` and `start_date`). Total hits cap at 10000, as in Amplify.
