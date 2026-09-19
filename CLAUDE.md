# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Two independent npm projects, each with its own `package.json` and `node_modules`:

- **Root**: Next.js 16 / React 19 app (App Router, Tailwind 4). Deployed to Elastic Beanstalk (`.elasticbeanstalk/`, `.platform/`, PR-preview workflows in `.github/workflows/`).
- **`infra/`**: CDK v2 (TypeScript) stack `DlpAccessNextAppSyncStack`. It builds an AppSync GraphQL API over the *existing* Amplify-provisioned DynamoDB tables and OpenSearch domain. It creates no tables or domains of its own.

## Commands

Root: `npm run dev`, `npm run build`, `npm run lint`, `npx tsc --noEmit`. There is no test suite.

CDK: run everything from `infra/`, or `--app is required` is raised.

```bash
cd infra
npx cdk synth   -c openSearchDomainEndpoint=<endpoint>
npx cdk deploy  -c openSearchDomainEndpoint=<endpoint>
```

- `openSearchDomainEndpoint` is a required context value (`bin/appsync.ts` throws without it). Use the domain's endpoint host, not its name.
- Optional context: `tableSuffix` (default `bxbkjhe235e3jcwcjcji5txvlm-vtdlpdev`, the vtdlpdev Amplify env) and `ebInstanceRoleName`.
- Deploys are user-run (the auto-mode classifier blocks Claude from running them); hand the user the command to run with `!`.

The Next.js server needs `APPSYNC_API_URL` set to the stack's `GraphQLApiUrl` output.

## Architecture

- **Schema is the source of truth**: `infra/schema/schema.graphql`. It is read-only (Query only, no Mutation/Subscription), and Archive/Collection are searchable through `fulltextArchives`, `fulltextCollections` and `searchObjects` (returns `[CatalogItem]`).
- **Resolvers are generated code strings**: `infra/lib/resolvers.ts` has generators (`getByIdCode`, `listScanCode`, `queryByIndexCode`, `hasOneCode`, `hasManyCode`, `openSearchQueryCode`) that emit APPSYNC_JS 1.0.0 source. `infra/lib/appsync-stack.ts` wires them to data sources per model via `MODELS`, `LIST_QUERY_FIELD` and `GLOBAL_INDEXES`. Adding a model means updating the schema plus those tables.
- **Auth is IAM only**. The Elastic Beanstalk instance role is granted `appsync:GraphQL`. The Next.js side signs requests with SigV4 in `src/lib/appsync.ts` (`aws4fetch` plus the Node credential chain), so it must only run server-side.
- **Demo page**: `src/app/examples/appsync-queries/` runs every query in the schema. The `list*` results seed the arguments for the `get*`, `*ByIdentifier` and search queries. Empty tables produce "skipped" entries instead of failures.

## AppSync JS runtime gotchas

- Variables cannot be reassigned (`let x = ...; x = ...` fails). Deploy validation reports only "The code contains one or more errors", so build values with a single `const` expression.
- `util.transform.toElasticsearchQueryDSL` returns a JSON *string*; wrap it in `JSON.parse`.
- Results typed as an interface (`CatalogItem`) need `__typename` set on each item. A Collection is identified by `collection_category`, otherwise it is an Archive.
- OpenSearch paging uses `search_after` sorted on `<field>.keyword` (except `visibility` and `start_date`). Total hits cap at 10000, as in Amplify.
- Import the OpenSearch domain with `Domain.fromDomainAttributes` and an explicit ARN. `Domain.fromDomainEndpoint` mis-derives the name (it keeps the `search-` prefix), which grants IAM on the wrong ARN and causes 403s at query time.
