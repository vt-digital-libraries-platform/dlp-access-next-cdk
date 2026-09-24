# Provision a per-environment data layer (DynamoDB, OpenSearch, streaming Lambda)

Labels: `ready-for-agent`

## Problem Statement

The CDK app stands up an AppSync GraphQL API, but it owns none of the data behind it. It imports the Amplify-provisioned DynamoDB tables and OpenSearch domain of a single Amplify environment (vtdlpdev). This causes several problems:

- The team can't run separate `dev`, `pre-production`, `production` or short-lived feature environments. Every deployment reads and searches the same vtdlpdev data.
- The data layer's lifecycle is tied to Amplify, which the team plans to move away from.
- Keeping OpenSearch in sync with DynamoDB depends on Amplify's streaming Lambda. That Lambda runs on a deprecated Python runtime, retries a failed record forever, and has no failure queue.
- Access to the API is granted to the account-wide default Elastic Beanstalk instance role. As a result, any Beanstalk app in the account can call it.

## Solution

Each environment gets its own data layer and API, both provisioned by the CDK app and chosen by a single environment name at deploy time. For each environment the app creates:

- the seven DynamoDB tables the schema reads
- an OpenSearch domain
- a streaming Lambda that keeps the `archive` and `collection` search indices in step with the Archive and Collection tables
- the AppSync API
- a dedicated Elastic Beanstalk instance role that may call that API

Everything that affects data or query behavior copies the existing vtdlpdev Amplify resources exactly: table keys, secondary indexes, stream view type, index names, dynamic mapping, and document IDs and shape. That way clients, resolvers and ingest see no difference.

Things clients can't see are modernized: a supported runtime, encryption, TLS 1.2, sizing per environment, bounded retries and a failure queue. There is one data layer and API per environment, not per git branch. Every branch deployment of the Next.js front end for an environment shares that environment's stacks.

Amplify stays live alongside this work, and the new environments are separate data silos. New environments start empty, and the ingest pipeline fills them.

## User Stories

1. As a DLP developer, I want to deploy a complete environment by passing one environment name, so that standing up `dev`, `pre-production` or a feature environment takes one command.
2. As a DLP developer, I want each environment's per-environment settings (target account, region, search sizing, data protection) in one typed configuration map, so that I can see and review every difference between environments in one place.
3. As a DLP developer, I want synthesis to fail with a clear message when I pass an unknown environment name, so that I don't accidentally deploy with default settings.
4. As a DLP developer, I want synthesis to fail when an environment name is too long for OpenSearch's domain-name limit, so that I find out at synth time and not halfway through a deploy.
5. As a DLP developer, I want to be able to create a short-lived feature environment with a short slug name, so that I can try out backend changes without touching `dev`.
6. As a DLP developer, I want feature environments, and only feature environments, to delete their tables and search domain when the stack is destroyed, so that throwaway environments don't leave behind resources that cost money.
7. As a DLP operator, I want `dev`, `pre-production` and `production` tables and search domains kept when their stacks are deleted, so that a mistaken `cdk destroy` or refactor can't lose the collection data.
8. As a DLP operator, I want deletion protection and point-in-time recovery on `dev`, `pre-production` and `production` tables, so that the data can be recovered after accidental deletes or bad writes.
9. As a DLP operator, I want `production` pinned to the production AWS account in configuration, so that deploying with the wrong credentials fails and doesn't create production resources in the development account.
10. As a DLP operator, I want `production` to refuse to synthesize while its account ID is still a placeholder, so that nobody can deploy production before it has been deliberately configured.
11. As a DLP developer, I want the stateful resources (tables, search domain) in a different stack from the stateless ones (API, resolvers, streaming Lambda), so that I can change, redeploy or tear down the API without putting data at risk.
12. As a DLP developer, I want each environment's tables to have the same hash key, secondary indexes, projections and stream view type as the vtdlpdev Amplify tables, so that the existing resolvers and ingest scripts work without changes.
13. As a DLP developer, I want table names to follow a `<Model>-dlpnext-<env>` pattern, so that tables from different environments in the shared account never collide, and the streaming handler still works out the right search index from the table name.
14. As a DLP developer, I want the Archive and Collection search indices to keep the names `archive` and `collection`, so that the existing OpenSearch resolvers query them unchanged.
15. As a DLP developer, I want search indices to use dynamic mapping as vtdlpdev does today, so that the `.keyword` sort fields and the typed `visibility` and `start_date` fields behave the same as in Amplify.
16. As a DLP developer, I want the search domain on a current OpenSearch 2.x engine, so that new domains aren't built on a legacy engine.
17. As a DLP operator, I want encryption at rest, node-to-node encryption, enforced HTTPS and TLS 1.2 on every search domain, so that the new environments are more secure than the Amplify ones they replace.
18. As a DLP operator, I want search domain access granted only through IAM on the roles that need it (the streaming Lambda, the API's search data source and the index-template installer), so that no broad resource policy opens the indices to other principals.
19. As a DLP operator, I want `dev`, feature and `pre-production` search domains to run on a single small node with no replicas, so that non-production environments are cheap and report healthy (green) status.
20. As a DLP operator, I want `production` search to run on two nodes across two availability zones with one replica, so that production search survives the loss of a node or an AZ.
21. As a curator adding or editing an Archive, I want the change to show up in search shortly after it is written, so that search results match the catalog.
22. As a curator deleting an Archive or Collection, I want it removed from the search index, so that deleted items stop appearing in search results.
23. As a DLP developer, I want the streaming Lambda to index documents with the same document IDs and document shape as Amplify's streaming function, so that search results and `__typename` resolution match the Amplify behavior.
24. As a DLP developer, I want the streaming Lambda to run on a supported Python runtime, so that it can be created and updated, since the Amplify function's python3.8 runtime is deprecated.
25. As a DLP operator, I want a failing stream record retried a bounded number of times, with the batch split to isolate the bad record, so that one malformed item doesn't block indexing for a whole shard for up to 24 hours.
26. As a DLP operator, I want records that still fail after retries sent to a failure queue, so that I can inspect and replay them rather than lose them silently.
27. As a DLP developer, I want the streaming Lambda's timeout sized for a full batch of 100 records, so that normal batches don't time out and get retried.
28. As a DLP developer, I want only the Archive and Collection tables streamed into search, and Partner not indexed, so that search holds only the types the schema searches.
29. As a DLP developer, I want each environment's AppSync API named after the environment, so that I can tell environments apart in the console and in logs.
30. As a DLP developer, I want the API's schema, resolvers and IAM-only authorization unchanged, so that the Next.js server-side client and the demo page keep working against any environment.
31. As a DLP developer deploying Next.js branch previews, I want each environment to provide its own Elastic Beanstalk instance role and instance profile allowed to call that environment's API, so that every branch instance for an environment can use the API without granting access to unrelated Beanstalk apps.
32. As a DLP operator, I want a branch deployed against `dev` to be unable to call the `pre-production` API, so that experimental front-end code can't read or depend on pre-production data.
33. As a DLP developer, I want the stack to output the GraphQL URL, API ID, API ARN and the Elastic Beanstalk instance profile name, so that I can wire the Beanstalk configuration template and `APPSYNC_API_URL` from the stack outputs.
34. As a DLP developer, I want the old "import the Amplify resources" mode and its context values removed, so that there's one way to deploy and no leftover configuration.
35. As a DLP developer, I want to destroy the old import-based AppSync stack only after the new `dev` environment is verified, so that the demo page always has a working backend.
36. As a DLP developer, I want the project's contributor guidance updated with the new deploy commands, environment names and naming rules, so that the next person (or agent) deploys correctly.
37. As an ingest maintainer, I want the new table names to follow a predictable pattern, so that pointing ingest at a CDK environment later only means changing a table-name setting.
38. As a DLP developer, I want automated checks against the synthesized templates for each environment, so that config-map or naming regressions are caught without a deploy.
39. As a DLP developer, I want automated checks for the streaming handler's output, so that changes to the copied Amplify code (such as removing `_type`) can't silently change document IDs, index names or delete behavior.

## Implementation Decisions

- **Environment selection.** Pass the environment name as a CDK context value (`env`). A typed configuration map, keyed by environment name, holds each environment's account, region, search sizing (instance type, node count, AZ count, replicas, volume size and type) and data-protection settings (removal policy, deletion protection, PITR). Environment names not in the map are rejected, except that feature environments (names prefixed `f-`) are allowed and inherit `dev` settings, except that they use DESTROY. Environment names are limited to 20 characters so that the domain name fits OpenSearch's 28-character limit.
- **Accounts.** `dev`, `pre-production` and feature environments deploy to the current development account, 226388486048 in us-east-1. `production` is in a separate account; its entry holds a placeholder account ID that throws at synthesis time until filled in. Production is not touched in this work.
- **Two stacks per environment.** `DlpAccessNext-<env>-Data` owns the seven tables and the search domain. `DlpAccessNext-<env>-Api` owns the AppSync API, data sources, resolvers, the streaming Lambda with its event-source mappings and failure queue, and the Elastic Beanstalk instance role and profile. The Api stack uses resources from the Data stack.
- **Tables.** Archive, Collection, Site, Partner, History, MetadataField and PageContent, named `<Model>-dlpnext-<env>`, which keeps the handler's rule of deriving the index from the table name's first `-` segment. Each has a string hash key `id`, streams with `NEW_AND_OLD_IMAGES` and on-demand billing, and is encrypted with the AWS-owned key. GSIs, each projecting `ALL`:
  - `Identifier` (hash `identifier`) on Archive, Collection and Partner
  - `gsi-Collection.archives` (hash `collectionArchivesId`) on Archive
  - `SiteId` (hash `siteId`) on Site

  These match the live vtdlpdev tables. The existing per-model tables of model names, list-query field names and GSI names stay the single source for wiring resolvers.
- **Search domain.** Named `dlpnext-<env>`. Latest OpenSearch 2.x engine, with encryption at rest, node-to-node encryption, enforced HTTPS and TLS 1.2 minimum. It has no fine-grained access control. It has no resource policy. Access comes from IAM identity grants on the streaming Lambda, the AppSync OpenSearch data source and the index-template installer. (Changed during implementation: in the same account, an Allow-only resource policy doesn't restrict other principals, and naming Api-stack roles in the Data stack's policy creates a cross-stack cycle.) No explicit mappings are created, so indices are created on first write with dynamic mapping, as in vtdlpdev. A custom resource installs one index template for `archive` and `collection` that sets only `index.auto_expand_replicas: 0-1`: 0 replicas on one node (green) and 1 on two or more. Replica count is therefore not a per-environment setting.
- **Sizing.** `dev`, feature and `pre-production`: 1 × `t3.small.search`, 10 GB gp3, 0 replicas. `production`: 2 × `m7g.medium.search` across 2 AZs, 1 replica, to be revisited against the real production domain before production is deployed. `t2.small` is not used because it doesn't support encryption at rest.
- **Data protection.** `dev`, `pre-production` and `production`: tables and domain use RETAIN, and tables have deletion protection and PITR on. Feature environments only: DESTROY, with deletion protection and PITR off. (`dev` was changed from DESTROY to RETAIN after the grilling.)
- **Streaming Lambda.** Amplify's Python streaming function is copied into the repo and changed only to:
  - run on python3.12
  - drop the boto3 that was bundled into the zip, since the runtime provides it
  - stop sending the `_type` field in bulk actions, which OpenSearch 2.x rejects
  - re-raise errors after logging them, and skip batches with nothing to send. Amplify's version swallowed every exception, so the retry, bisect and failure-queue settings would never have triggered, and an empty bulk request would now fail.

  Its environment variables (endpoint, region, debug flag, external-versioning flag set to false) and indexing behavior (index from the table name, compound document ID from the keys, index on INSERT and MODIFY, delete on REMOVE) are kept. The timeout is 30 s and memory stays at 128 MB.
- **Event-source mappings.** Archive and Collection streams only, not Partner. Batch size 100, 1 s batching window, starting position `LATEST`, 3 retries, bisect-batch-on-error, and an SQS on-failure destination per environment.
- **AppSync API.** Named `dlp-access-next-<env>`. The schema, resolver generators and the wiring of queries and relations to data sources don't change. The OpenSearch data source points at the provisioned domain directly, so the endpoint parsing and the ARN workaround for imported domains are no longer needed. Auth stays IAM-only.
- **Elastic Beanstalk access.** Each Api stack creates an instance role and instance profile named `dlp-access-next-<env>-eb`, trusted by EC2, and grants it `appsync:GraphQL` on that environment's API. The environment's Beanstalk configuration template refers to this profile, and all branch instances for the environment share it. The shared default `aws-elasticbeanstalk-ec2-role` is no longer granted anything.
- **Outputs.** GraphQL API URL, API ID, API ARN, and the Elastic Beanstalk instance profile name. The table names and domain endpoint are also output, for ingest and debugging.
- **Removed.** The `tableSuffix`, `openSearchDomainEndpoint` and `ebInstanceRoleName` context values, and all importing of Amplify tables, domain and role.
- **Docs.** Contributor guidance is updated for the new deploy command shape, environment names, naming rules and the Data/Api split.
- **Rollout.** Work happens on branch `whunter/multi-env`. The user deploys `dev` (Claude can't run deploys), adds a few Archive and Collection records, and checks the AppSync demo page against the new API URL. After that, the old `DlpAccessNextAppSyncStack` is destroyed. `pre-production` follows; `production` comes later.

## Testing Decisions

- **Good tests** check behavior seen from outside the code being tested: the synthesized CloudFormation for an environment, or the bulk request the streaming handler sends. They don't check construct IDs, internal helper functions or how the config map is laid out.
- **Seam A: synthesizing the whole CDK app per environment.** Jest with the CDK assertions library, synthesizing the app for `dev`, `pre-production` and a sample feature env name. Assertions cover:
  - table names, key schema, GSIs and stream view type
  - domain engine version, instance type and count, encryption and TLS settings
  - removal policies, deletion protection and PITR per environment
  - event-source mappings on the Archive and Collection streams only, with retry, bisect and on-failure settings
  - the Lambda's runtime and timeout
  - the Elastic Beanstalk role's `appsync:GraphQL` grant scoped to that environment's API
  - the domain having no resource policy, and the index template targeting `archive` and `collection`
  - `production` failing to synthesize with a placeholder account
  - names that are unknown or too long being rejected
- **Seam B: the streaming handler's entry point.** pytest drives the handler with hand-built DynamoDB stream events (INSERT, MODIFY, REMOVE, for Archive and Collection table names following the new naming pattern) and replaces the outbound signed HTTP call with a stub that captures the request. Assertions cover the target index name, the document ID, the absence of `_type`, the document body, and delete actions on REMOVE.
- **End to end.** Manual, with no automation: deploy `dev`, write records, and use the AppSync demo page to run every query, including full-text search.
- **Prior art.** The repo has no test suite yet. These are its first automated tests, so both harnesses (Jest in the CDK project, pytest next to the Lambda source) are new and should be set up as simply as possible.

## Out of Scope

- Deploying or configuring `production` beyond the placeholder entry in the config map, and checking production sizing against the existing production domain.
- Migrating or seeding data from the Amplify tables. New environments start empty and ingest fills them.
- A reindex or backfill tool for loading the search index from existing table rows.
- Pointing the ingest pipeline or the Amplify admin app at CDK environments, and retiring Amplify.
- Indexing Partner, or any table other than Archive and Collection, in OpenSearch.
- Tying data stacks to git branches, and wiring feature environments into the PR-preview GitHub workflows.
- The Next.js front end's per-branch deployment work, beyond pointing the Beanstalk configuration template at the new instance profile.
- CI/CD for CDK deploys, including cross-account production pipelines.
- Schema, resolver or query-behavior changes.

## Further Notes

- Facts about vtdlpdev (pulled live on 2026-09-24):
  - The Amplify domain runs Elasticsearch 7.10 on a single t2.small with 10 GB gp2. Its indices have 5 shards and 1 replica, so the cluster is permanently yellow.
  - The domain has no resource policy, and encryption at rest and node-to-node encryption are both off.
  - The `archive` index has about 9.9k documents and `collection` about 420, all dynamically mapped.
  - The Amplify streaming Lambda also streams the empty Partner table.
- Because the streaming handler works out the index from the table name's first `-` segment, a table name that doesn't start with `Archive-` or `Collection-` silently writes to the wrong index. Seam B should lock this in.
- Since the event-source mappings start at `LATEST`, rows written before an environment's Api stack exists are never indexed. That's acceptable now, since new environments start empty, but it's the reason a backfill tool will be needed before any migration.
- The local Amplify backend checkout (`vtdlp-amplify-backends/vtdlpdev`) is out of date compared to the deployed vtdlpdev environment, so the live resources are the reference, not that checkout.
