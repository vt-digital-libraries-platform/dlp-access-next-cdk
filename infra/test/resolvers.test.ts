import { openSearchQueryCode } from '../lib/resolvers';
import { numericSortFields } from '../lib/search-mappings';

type Resolver = {
  request: (ctx: object) => { params: { body: Record<string, unknown> } };
  response: (ctx: object) => { items: object[]; nextToken: string | null };
};

// Runs the generated APPSYNC_JS source in Node, with a stub for `util`.
function load(sortFields: string[]): Resolver {
  const code = openSearchQueryCode({ index: 'archive', searchFields: ['title'], numericSortFields: sortFields })
    .replace(/^import .*$/m, '')
    .replace(/^export /gm, '');
  const util = {
    error: (message: string) => {
      throw new Error(message);
    },
  };
  return new Function('util', `${code}\nreturn { request, response };`)(util);
}

const resolver = load(['start_date', 'end_date']);
const body = (args: object) => resolver.request({ args }).params.body;
const respond = (hits: object[]) => resolver.response({ result: { hits: { hits, total: { value: hits.length } } } });

describe('openSearchQueryCode sorting', () => {
  test('sorts text fields on .keyword', () => {
    expect(body({ sort: { field: 'title', direction: 'asc' } }).sort).toContainEqual({
      'title.keyword': { order: 'asc' },
    });
  });

  test.each([
    ['asc', Number.MAX_SAFE_INTEGER],
    ['desc', -Number.MAX_SAFE_INTEGER],
  ])('sorts numeric fields on the field itself, %s, with missing values last', (direction, missing) => {
    expect(body({ sort: { field: 'end_date', direction } }).sort).toContainEqual({
      end_date: { order: direction, missing },
    });
  });

  test('sorting on id needs no tiebreaker', () => {
    expect(body({ sort: { field: 'id', direction: 'asc' } }).sort).toEqual([{ 'id.keyword': { order: 'asc' } }]);
  });

  test('an empty page has no token', () => {
    expect(respond([]).nextToken).toBeNull();
  });
});

test('numeric sort fields are the date and boolean fields in the generated mappings', () => {
  expect(numericSortFields(['archive'])).toEqual([
    'archived', 'date', 'embargo_end_date', 'embargo_start_date', 'end_date', 'explicit', 'start_date',
    'visibility',
  ]);
  expect(numericSortFields(['collection'])).toEqual([
    'archived', 'embargo_end_date', 'embargo_start_date', 'end_date', 'explicit_content', 'start_date',
    'visibility',
  ]);
});

// A stand-in for OpenSearch's sort and search_after over in-memory documents:
// each hit's `sort` holds its value for every sort clause, a missing value
// without a `missing` setting is null and sorts last in either direction, and
// search_after returns the hits that sort strictly after the given values.
type SortClause = Record<string, { order: 'asc' | 'desc'; missing?: number }>;
function fakeOpenSearch(docs: Record<string, unknown>[], body: Record<string, unknown>) {
  const clauses = (body.sort as SortClause[]).map((clause) => {
    const [field, { order, missing }] = Object.entries(clause)[0];
    const source = field.replace(/\.keyword$/, '');
    const value = (doc: Record<string, unknown>) =>
      (doc[source] === undefined ? (missing ?? null) : doc[source]) as string | number | null;
    return { value, sign: order === 'asc' ? 1 : -1 };
  });
  const compare = (a: unknown[], b: unknown[]) => {
    for (let i = 0; i < clauses.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] === null) return 1;
      if (b[i] === null) return -1;
      return ((a[i] as string | number) < (b[i] as string | number) ? -1 : 1) * clauses[i].sign;
    }
    return 0;
  };
  const after = body.search_after as unknown[] | undefined;
  const hits = docs
    .map((doc) => ({ _source: doc, sort: clauses.map((c) => c.value(doc)) }))
    .sort((a, b) => compare(a.sort, b.sort))
    .filter((hit) => !after || compare(hit.sort, after) > 0)
    .slice(0, body.size as number);
  return { hits: { hits, total: { value: docs.length } } };
}

function pageThrough(docs: Record<string, unknown>[], sort: object, limit: number): string[] {
  const seen: string[] = [];
  let nextToken: string | null = null;
  do {
    const request = resolver.request({ args: { sort, limit, nextToken } });
    const page = resolver.response({ result: fakeOpenSearch(docs, request.params.body) });
    seen.push(...page.items.map((item) => (item as { id: string }).id));
    nextToken = page.items.length === limit ? page.nextToken : null;
  } while (nextToken);
  return seen;
}

describe('openSearchQueryCode paging', () => {
  test('sorts on the requested field, then on id', () => {
    expect(body({ sort: { field: 'title', direction: 'asc' } }).sort).toEqual([
      { 'title.keyword': { order: 'asc' } },
      { 'id.keyword': { order: 'asc' } },
    ]);
    expect(body({ sort: { field: 'end_date', direction: 'desc' } }).sort).toEqual([
      { end_date: { order: 'desc', missing: -Number.MAX_SAFE_INTEGER } },
      { 'id.keyword': { order: 'desc' } },
    ]);
  });

  test.each([
    ['end_date', [1609459200000, 'a']],
    ['title', ['Maps', 'a']],
  ])('page tokens round-trip both sort values on %s', (field, sort) => {
    const { nextToken } = respond([{ _source: { id: 'a' }, sort }]);
    expect(body({ sort: { field, direction: 'asc' }, nextToken }).search_after).toEqual(sort);
  });

  test('returns every document once when titles tie across a page boundary', () => {
    const docs = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, title: id === 'e' ? 'Zebra' : 'Untitled' }));
    const seen = pageThrough(docs, { field: 'title', direction: 'asc' }, 2);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('returns every document once when some have no title', () => {
    const docs = [{ id: 'a', title: 'Maps' }, { id: 'b' }, { id: 'c' }, { id: 'd', title: 'Letters' }];
    const seen = pageThrough(docs, { field: 'title', direction: 'asc' }, 1);
    expect(seen).toEqual(['d', 'a', 'b', 'c']);
  });

  test.each(['asc', 'desc'])('returns every document once on a %s date sort with undated documents', (direction) => {
    const docs = [
      { id: 'a', start_date: 1000 },
      { id: 'b' },
      { id: 'c' },
      { id: 'd', start_date: 2000 },
      { id: 'e' },
    ];
    const seen = pageThrough(docs, { field: 'start_date', direction }, 2);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
