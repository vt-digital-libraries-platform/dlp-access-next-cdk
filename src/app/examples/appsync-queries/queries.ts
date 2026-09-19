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

export interface PartnerSummary {
  id: string;
  identifier: string;
  title: string;
  description: string[] | null;
  visibility: boolean;
}

export interface HistorySummary {
  id: string;
  siteID: string;
  userEmail: string;
  event: unknown;
}

export interface MetadataFieldSummary {
  id: string;
  columnName: string;
  labelName: string;
  type: string;
  category: string;
}

export interface PageContentSummary {
  id: string;
  page_content_category: string;
  content: string;
}

const ARCHIVE_FIELDS = `id identifier title description item_category`;
const COLLECTION_FIELDS = `id identifier title description collection_category`;
const SITE_FIELDS = `id siteId siteName siteTitle lang`;
const PARTNER_FIELDS = `id identifier title description visibility`;
const HISTORY_FIELDS = `id siteID userEmail event`;
const METADATA_FIELD_FIELDS = `id columnName labelName type category`;
const PAGE_CONTENT_FIELDS = `id page_content_category content`;

const GET_ARCHIVE = `query GetArchive($id: ID!) { getArchive(id: $id) { ${ARCHIVE_FIELDS} } }`;
const LIST_ARCHIVES = `query ListArchives { listArchives(limit: 5) { items { ${ARCHIVE_FIELDS} } nextToken } }`;
const ARCHIVE_BY_IDENTIFIER = `query ArchiveByIdentifier($identifier: String!) { archiveByIdentifier(identifier: $identifier) { items { ${ARCHIVE_FIELDS} } nextToken } }`;

const GET_COLLECTION = `query GetCollection($id: ID!) { getCollection(id: $id) { ${COLLECTION_FIELDS} } }`;
const LIST_COLLECTIONS = `query ListCollections { listCollections(limit: 5) { items { ${COLLECTION_FIELDS} } nextToken } }`;
const COLLECTION_BY_IDENTIFIER = `query CollectionByIdentifier($identifier: String!) { collectionByIdentifier(identifier: $identifier) { items { ${COLLECTION_FIELDS} } nextToken } }`;

const GET_SITE = `query GetSite($id: ID!) { getSite(id: $id) { ${SITE_FIELDS} } }`;
const LIST_SITES = `query ListSites { listSites(limit: 5) { items { ${SITE_FIELDS} } nextToken } }`;
const SITE_BY_SITE_ID = `query SiteBySiteId($siteId: String!) { siteBySiteId(siteId: $siteId) { items { ${SITE_FIELDS} } nextToken } }`;

const GET_PARTNER = `query GetPartner($id: ID!) { getPartner(id: $id) { ${PARTNER_FIELDS} } }`;
const LIST_PARTNERS = `query ListPartners { listPartners(limit: 5) { items { ${PARTNER_FIELDS} } nextToken } }`;
const PARTNER_BY_IDENTIFIER = `query PartnerByIdentifier($identifier: String!) { partnerByIdentifier(identifier: $identifier) { items { ${PARTNER_FIELDS} } nextToken } }`;

const GET_HISTORY = `query GetHistory($id: ID!) { getHistory(id: $id) { ${HISTORY_FIELDS} } }`;
const LIST_HISTORIES = `query ListHistories { listHistories(limit: 5) { items { ${HISTORY_FIELDS} } nextToken } }`;

const GET_METADATA_FIELD = `query GetMetadataField($id: ID!) { getMetadataField(id: $id) { ${METADATA_FIELD_FIELDS} } }`;
const LIST_METADATA_FIELDS = `query ListMetadataFields { listMetadataFields(limit: 5) { items { ${METADATA_FIELD_FIELDS} } nextToken } }`;

const GET_PAGE_CONTENT = `query GetPageContent($id: ID!) { getPageContent(id: $id) { ${PAGE_CONTENT_FIELDS} } }`;
const LIST_PAGE_CONTENTS = `query ListPageContents { listPageContents(limit: 5) { items { ${PAGE_CONTENT_FIELDS} } nextToken } }`;

// Demonstrates the Archive.partner and PageContent.pageContentSiteId
// relation fields, not just the top-level get/list/byIndex queries.
const ARCHIVE_WITH_PARTNER_FIELDS = `id identifier title partner { ${PARTNER_FIELDS} }`;
const GET_ARCHIVE_WITH_PARTNER = `query GetArchiveWithPartner($id: ID!) { getArchive(id: $id) { ${ARCHIVE_WITH_PARTNER_FIELDS} } }`;

const PAGE_CONTENT_WITH_SITE_FIELDS = `id page_content_category pageContentSiteId { ${SITE_FIELDS} }`;
const GET_PAGE_CONTENT_WITH_SITE = `query GetPageContentWithSite($id: ID!) { getPageContent(id: $id) { ${PAGE_CONTENT_WITH_SITE_FIELDS} } }`;

const SEARCH_ARCHIVE_FIELDS = `id identifier title item_category`;
const SEARCH_COLLECTION_FIELDS = `id identifier title collection_category`;

const FULLTEXT_ARCHIVES = `query FulltextArchives($allFields: String) { fulltextArchives(allFields: $allFields, limit: 5) { items { ${SEARCH_ARCHIVE_FIELDS} } nextToken total } }`;
const FULLTEXT_COLLECTIONS = `query FulltextCollections($allFields: String) { fulltextCollections(allFields: $allFields, limit: 5) { items { ${SEARCH_COLLECTION_FIELDS} } nextToken total } }`;
const SEARCH_OBJECTS = `query SearchObjects($allFields: String) { searchObjects(allFields: $allFields, limit: 5) { items { __typename ... on Archive { ${SEARCH_ARCHIVE_FIELDS} } ... on Collection { ${SEARCH_COLLECTION_FIELDS} } } nextToken total } }`;
const SEARCH_ARCHIVES_FILTERED = `query FulltextArchivesFiltered($identifier: String) { fulltextArchives(filter: { identifier: { eq: $identifier } }, limit: 5) { items { ${SEARCH_ARCHIVE_FIELDS} } total } }`;

// First word of at least 4 letters, used as a search term seeded from real data.
function searchTerm(title: string | undefined): string | undefined {
  return title?.match(/[A-Za-z]{4,}/)?.[0];
}

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
  const [archiveList, collectionList, siteList, partnerList, historyList, metadataFieldList, pageContentList] =
    await Promise.all([
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
      run("listPartners", "List the first 5 partners.", () =>
        graphqlRequest<{ listPartners: Connection<PartnerSummary> }>(LIST_PARTNERS).then((d) => d.listPartners),
      ),
      run("listHistories", "List the first 5 history events.", () =>
        graphqlRequest<{ listHistories: Connection<HistorySummary> }>(LIST_HISTORIES).then((d) => d.listHistories),
      ),
      run("listMetadataFields", "List the first 5 metadata fields.", () =>
        graphqlRequest<{ listMetadataFields: Connection<MetadataFieldSummary> }>(LIST_METADATA_FIELDS).then(
          (d) => d.listMetadataFields,
        ),
      ),
      run("listPageContents", "List the first 5 page content entries.", () =>
        graphqlRequest<{ listPageContents: Connection<PageContentSummary> }>(LIST_PAGE_CONTENTS).then(
          (d) => d.listPageContents,
        ),
      ),
    ]);

  const firstArchive = firstItem<ArchiveSummary>(archiveList);
  const firstCollection = firstItem<CollectionSummary>(collectionList);
  const firstSite = firstItem<SiteSummary>(siteList);
  const firstPartner = firstItem<PartnerSummary>(partnerList);
  const firstHistory = firstItem<HistorySummary>(historyList);
  const firstMetadataField = firstItem<MetadataFieldSummary>(metadataFieldList);
  const firstPageContent = firstItem<PageContentSummary>(pageContentList);

  const [
    getArchive,
    archiveByIdentifier,
    getCollection,
    collectionByIdentifier,
    getSite,
    siteBySiteId,
    getPartner,
    partnerByIdentifier,
    getHistory,
    getMetadataField,
    getPageContent,
    archiveWithPartner,
    pageContentWithSite,
  ] = await Promise.all([
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
      firstPartner
        ? run("getPartner", `Fetch the partner with id "${firstPartner.id}" (from listPartners).`, () =>
            graphqlRequest<{ getPartner: PartnerSummary }>(GET_PARTNER, { id: firstPartner.id }).then(
              (d) => d.getPartner,
            ),
          )
        : skip("getPartner", "Fetch a single partner by id.", "listPartners returned no items to seed an id."),
      firstPartner
        ? run(
            "partnerByIdentifier",
            `Fetch partners with identifier "${firstPartner.identifier}" (from listPartners).`,
            () =>
              graphqlRequest<{ partnerByIdentifier: Connection<PartnerSummary> }>(PARTNER_BY_IDENTIFIER, {
                identifier: firstPartner.identifier,
              }).then((d) => d.partnerByIdentifier),
          )
        : skip(
            "partnerByIdentifier",
            "Fetch partners by identifier.",
            "listPartners returned no items to seed an identifier.",
          ),
      firstHistory
        ? run("getHistory", `Fetch the history event with id "${firstHistory.id}" (from listHistories).`, () =>
            graphqlRequest<{ getHistory: HistorySummary }>(GET_HISTORY, { id: firstHistory.id }).then(
              (d) => d.getHistory,
            ),
          )
        : skip("getHistory", "Fetch a single history event by id.", "listHistories returned no items to seed an id."),
      firstMetadataField
        ? run(
            "getMetadataField",
            `Fetch the metadata field with id "${firstMetadataField.id}" (from listMetadataFields).`,
            () =>
              graphqlRequest<{ getMetadataField: MetadataFieldSummary }>(GET_METADATA_FIELD, {
                id: firstMetadataField.id,
              }).then((d) => d.getMetadataField),
          )
        : skip(
            "getMetadataField",
            "Fetch a single metadata field by id.",
            "listMetadataFields returned no items to seed an id.",
          ),
      firstPageContent
        ? run(
            "getPageContent",
            `Fetch the page content with id "${firstPageContent.id}" (from listPageContents).`,
            () =>
              graphqlRequest<{ getPageContent: PageContentSummary }>(GET_PAGE_CONTENT, {
                id: firstPageContent.id,
              }).then((d) => d.getPageContent),
          )
        : skip(
            "getPageContent",
            "Fetch a single page content entry by id.",
            "listPageContents returned no items to seed an id.",
          ),
      firstArchive
        ? run(
            "getArchive (with partner relation)",
            `Fetch the archive with id "${firstArchive.id}" and resolve its partner relation field.`,
            () =>
              graphqlRequest<{ getArchive: unknown }>(GET_ARCHIVE_WITH_PARTNER, { id: firstArchive.id }).then(
                (d) => d.getArchive,
              ),
          )
        : skip(
            "getArchive (with partner relation)",
            "Fetch an archive and resolve its partner relation field.",
            "listArchives returned no items to seed an id.",
          ),
      firstPageContent
        ? run(
            "getPageContent (with site relation)",
            `Fetch the page content with id "${firstPageContent.id}" and resolve its pageContentSiteId relation field.`,
            () =>
              graphqlRequest<{ getPageContent: unknown }>(GET_PAGE_CONTENT_WITH_SITE, {
                id: firstPageContent.id,
              }).then((d) => d.getPageContent),
          )
        : skip(
            "getPageContent (with site relation)",
            "Fetch a page content entry and resolve its pageContentSiteId relation field.",
            "listPageContents returned no items to seed an id.",
          ),
    ]);

  const archiveTerm = searchTerm(firstArchive?.title);
  const collectionTerm = searchTerm(firstCollection?.title);
  const objectTerm = archiveTerm ?? collectionTerm;

  const [fulltextArchives, fulltextArchivesFiltered, fulltextCollections, searchObjects] = await Promise.all([
    archiveTerm
      ? run("fulltextArchives", `Full-text search archives for "${archiveTerm}" (a word from listArchives).`, () =>
          graphqlRequest<{ fulltextArchives: unknown }>(FULLTEXT_ARCHIVES, { allFields: archiveTerm }).then(
            (d) => d.fulltextArchives,
          ),
        )
      : skip("fulltextArchives", "Full-text search archives.", "listArchives returned no title to seed a search term."),
    firstArchive
      ? run(
          "fulltextArchives (filter)",
          `Search archives with a structured filter: identifier eq "${firstArchive.identifier}".`,
          () =>
            graphqlRequest<{ fulltextArchives: unknown }>(SEARCH_ARCHIVES_FILTERED, {
              identifier: firstArchive.identifier,
            }).then((d) => d.fulltextArchives),
        )
      : skip(
          "fulltextArchives (filter)",
          "Search archives with a structured filter.",
          "listArchives returned no items to seed an identifier.",
        ),
    collectionTerm
      ? run(
          "fulltextCollections",
          `Full-text search collections for "${collectionTerm}" (a word from listCollections).`,
          () =>
            graphqlRequest<{ fulltextCollections: unknown }>(FULLTEXT_COLLECTIONS, {
              allFields: collectionTerm,
            }).then((d) => d.fulltextCollections),
        )
      : skip(
          "fulltextCollections",
          "Full-text search collections.",
          "listCollections returned no title to seed a search term.",
        ),
    objectTerm
      ? run(
          "searchObjects",
          `Search archives and collections together for "${objectTerm}"; each item is tagged by __typename.`,
          () =>
            graphqlRequest<{ searchObjects: unknown }>(SEARCH_OBJECTS, { allFields: objectTerm }).then(
              (d) => d.searchObjects,
            ),
        )
      : skip("searchObjects", "Search archives and collections together.", "No archive or collection title to seed a search term."),
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
    getPartner,
    partnerList,
    partnerByIdentifier,
    getHistory,
    historyList,
    getMetadataField,
    metadataFieldList,
    getPageContent,
    pageContentList,
    archiveWithPartner,
    pageContentWithSite,
    searchObjects,
    fulltextCollections,
    fulltextArchives,
    fulltextArchivesFiltered,
  ];
}
