"use server";

import { graphqlRequest } from "@/lib/appsync";

export type SearchScope = "archives" | "collections" | "both";

export interface SearchResultItem {
  id: string;
  identifier: string | null;
  title: string | null;
  type: "Archive" | "Collection";
  category: string | null;
}

export interface SearchResponse {
  items: SearchResultItem[];
  total: number;
  error?: string;
}

const LIMIT = 25;
const ARCHIVE_FIELDS = `id identifier title item_category`;
const COLLECTION_FIELDS = `id identifier title collection_category`;

const QUERIES: Record<SearchScope, { field: string; query: string }> = {
  archives: {
    field: "fulltextArchives",
    query: `query($allFields: String, $limit: Int) { fulltextArchives(allFields: $allFields, limit: $limit) { items { ${ARCHIVE_FIELDS} } total } }`,
  },
  collections: {
    field: "fulltextCollections",
    query: `query($allFields: String, $limit: Int) { fulltextCollections(allFields: $allFields, limit: $limit) { items { ${COLLECTION_FIELDS} } total } }`,
  },
  both: {
    field: "searchObjects",
    query: `query($allFields: String, $limit: Int) { searchObjects(allFields: $allFields, limit: $limit) { items { __typename ... on Archive { ${ARCHIVE_FIELDS} } ... on Collection { ${COLLECTION_FIELDS} } } total } }`,
  },
};

interface RawItem {
  __typename?: string;
  id: string;
  identifier: string | null;
  title: string | null;
  item_category?: string | null;
  collection_category?: string | null;
}

export async function searchCatalog(term: string, scope: SearchScope): Promise<SearchResponse> {
  const allFields = term.trim();
  if (!allFields) return { items: [], total: 0, error: "Enter a search term." };
  if (!(scope in QUERIES)) return { items: [], total: 0, error: "Invalid search scope." };

  const { field, query } = QUERIES[scope];
  try {
    const data = await graphqlRequest<Record<string, { items: (RawItem | null)[] | null; total: number | null }>>(
      query,
      { allFields, limit: LIMIT },
    );
    const conn = data[field];
    const items = (conn?.items ?? []).filter((i): i is RawItem => Boolean(i)).map((i): SearchResultItem => {
      const type =
        scope === "archives" ? "Archive" : scope === "collections" ? "Collection" : i.__typename === "Collection" ? "Collection" : "Archive";
      return {
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        type,
        category: (type === "Collection" ? i.collection_category : i.item_category) ?? null,
      };
    });
    return { items, total: conn?.total ?? items.length };
  } catch (err) {
    return { items: [], total: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
