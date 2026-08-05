import { graphqlRequest, type Connection } from "@/lib/appsync";

// Mirrors the subset of fields used from infra/schema/schema.graphql.
export interface ArchiveSummary {
  id: string;
  identifier: string;
  title: string;
  description: string[] | null;
  item_category: string;
}

export interface CollectionSummary {
  id: string;
  identifier: string;
  title: string;
  description: string[] | null;
  collection_category: string;
}

export interface SiteSummary {
  id: string;
  siteId: string;
  siteName: string;
  siteTitle: string;
  lang: string | null;
}

const ARCHIVE_FIELDS = `id identifier title description item_category`;
const COLLECTION_FIELDS = `id identifier title description collection_category`;
const SITE_FIELDS = `id siteId siteName siteTitle lang`;

const GET_ARCHIVE = `query GetArchive($id: ID!) { getArchive(id: $id) { ${ARCHIVE_FIELDS} } }`;
const LIST_ARCHIVES = `query ListArchives { listArchives(limit: 5) { items { ${ARCHIVE_FIELDS} } nextToken } }`;
const ARCHIVE_BY_IDENTIFIER = `query ArchiveByIdentifier($identifier: String!) { archiveByIdentifier(identifier: $identifier) { items { ${ARCHIVE_FIELDS} } nextToken } }`;

const GET_COLLECTION = `query GetCollection($id: ID!) { getCollection(id: $id) { ${COLLECTION_FIELDS} } }`;
const LIST_COLLECTIONS = `query ListCollections { listCollections(limit: 5) { items { ${COLLECTION_FIELDS} } nextToken } }`;
const COLLECTION_BY_IDENTIFIER = `query CollectionByIdentifier($identifier: String!) { collectionByIdentifier(identifier: $identifier) { items { ${COLLECTION_FIELDS} } nextToken } }`;

const GET_SITE = `query GetSite($id: ID!) { getSite(id: $id) { ${SITE_FIELDS} } }`;
const LIST_SITES = `query ListSites { listSites(limit: 5) { items { ${SITE_FIELDS} } nextToken } }`;
const SITE_BY_SITE_ID = `query SiteBySiteId($siteId: String!) { siteBySiteId(siteId: $siteId) { items { ${SITE_FIELDS} } nextToken } }`;

export interface QueryDemo {
  label: string;
  description: string;
  status: "success" | "error" | "skipped";
  data?: unknown;
  error?: string;
}

async function run(label: string, description: string, fn: () => Promise<unknown>): Promise<QueryDemo> {
  try {
    const data = await fn();
    return { label, description, status: "success", data };
  } catch (err) {
    return { label, description, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function skip(label: string, description: string, reason: string): QueryDemo {
  return { label, description, status: "skipped", error: reason };
}

function firstItem<T>(demo: QueryDemo): T | undefined {
  if (demo.status !== "success") return undefined;
  const items = (demo.data as Connection<T>).items ?? [];
  return items.find((item): item is T => item != null);
}

// Runs every query defined in infra/schema/schema.graphql. The listX
// queries need no arguments, so they run first; their first result seeds
// the id/identifier arguments for the getX and xByIdentifier queries.
export async function runDemoQueries(): Promise<QueryDemo[]> {
  const [archiveList, collectionList, siteList] = await Promise.all([
    run("listArchives", "List the first 5 archives.", () =>
      graphqlRequest<{ listArchives: Connection<ArchiveSummary> }>(LIST_ARCHIVES).then((d) => d.listArchives),
    ),
    run("listCollections", "List the first 5 collections.", () =>
      graphqlRequest<{ listCollections: Connection<CollectionSummary> }>(LIST_COLLECTIONS).then(
        (d) => d.listCollections,
      ),
    ),
    run("listSites", "List the first 5 sites.", () =>
      graphqlRequest<{ listSites: Connection<SiteSummary> }>(LIST_SITES).then((d) => d.listSites),
    ),
  ]);

  const firstArchive = firstItem<ArchiveSummary>(archiveList);
  const firstCollection = firstItem<CollectionSummary>(collectionList);
  const firstSite = firstItem<SiteSummary>(siteList);

  const [getArchive, archiveByIdentifier, getCollection, collectionByIdentifier, getSite, siteBySiteId] =
    await Promise.all([
      firstArchive
        ? run("getArchive", `Fetch the archive with id "${firstArchive.id}" (from listArchives).`, () =>
            graphqlRequest<{ getArchive: ArchiveSummary }>(GET_ARCHIVE, { id: firstArchive.id }).then(
              (d) => d.getArchive,
            ),
          )
        : skip("getArchive", "Fetch a single archive by id.", "listArchives returned no items to seed an id."),
      firstArchive
        ? run(
            "archiveByIdentifier",
            `Fetch archives with identifier "${firstArchive.identifier}" (from listArchives).`,
            () =>
              graphqlRequest<{ archiveByIdentifier: Connection<ArchiveSummary> }>(ARCHIVE_BY_IDENTIFIER, {
                identifier: firstArchive.identifier,
              }).then((d) => d.archiveByIdentifier),
          )
        : skip(
            "archiveByIdentifier",
            "Fetch archives by identifier.",
            "listArchives returned no items to seed an identifier.",
          ),
      firstCollection
        ? run("getCollection", `Fetch the collection with id "${firstCollection.id}" (from listCollections).`, () =>
            graphqlRequest<{ getCollection: CollectionSummary }>(GET_COLLECTION, { id: firstCollection.id }).then(
              (d) => d.getCollection,
            ),
          )
        : skip(
            "getCollection",
            "Fetch a single collection by id.",
            "listCollections returned no items to seed an id.",
          ),
      firstCollection
        ? run(
            "collectionByIdentifier",
            `Fetch collections with identifier "${firstCollection.identifier}" (from listCollections).`,
            () =>
              graphqlRequest<{ collectionByIdentifier: Connection<CollectionSummary> }>(COLLECTION_BY_IDENTIFIER, {
                identifier: firstCollection.identifier,
              }).then((d) => d.collectionByIdentifier),
          )
        : skip(
            "collectionByIdentifier",
            "Fetch collections by identifier.",
            "listCollections returned no items to seed an identifier.",
          ),
      firstSite
        ? run("getSite", `Fetch the site with id "${firstSite.id}" (from listSites).`, () =>
            graphqlRequest<{ getSite: SiteSummary }>(GET_SITE, { id: firstSite.id }).then((d) => d.getSite),
          )
        : skip("getSite", "Fetch a single site by id.", "listSites returned no items to seed an id."),
      firstSite
        ? run("siteBySiteId", `Fetch sites with siteId "${firstSite.siteId}" (from listSites).`, () =>
            graphqlRequest<{ siteBySiteId: Connection<SiteSummary> }>(SITE_BY_SITE_ID, {
              siteId: firstSite.siteId,
            }).then((d) => d.siteBySiteId),
          )
        : skip("siteBySiteId", "Fetch sites by siteId.", "listSites returned no items to seed a siteId."),
    ]);

  // Ordered to match the Query type declaration order in schema.graphql.
  return [
    getArchive,
    archiveList,
    archiveByIdentifier,
    getCollection,
    collectionList,
    collectionByIdentifier,
    getSite,
    siteList,
    siteBySiteId,
  ];
}
