import { openSearchQueryCode } from '../lib/resolvers';
import { dateFields } from '../lib/search-mappings';

type Resolver = {
  request: (ctx: object) => { params: { body: Record<string, unknown> } };
  response: (ctx: object) => { items: object[]; nextToken: string | null };
};

// Runs the generated APPSYNC_JS source in Node, with a stub for `util`.
function load(numericSortFields: string[]): Resolver {
  const code = openSearchQueryCode({ index: 'archive', searchFields: ['title'], numericSortFields })
    .replace(/^import .*$/m, '')
    .replace(/^export /gm, '');
  return new Function('util', `${code}\nreturn { request, response };`)({ error: () => {} });
}

const resolver = load(['start_date', 'end_date']);
const body = (args: object) => resolver.request({ args }).params.body;

describe('openSearchQueryCode sorting', () => {
  test('sorts text fields on .keyword and passes the token through', () => {
    expect(body({ sort: { field: 'title', direction: 'asc' }, nextToken: 'Maps' })).toMatchObject({
      sort: [{ 'title.keyword': { order: 'asc' } }],
      search_after: ['Maps'],
    });
  });

  test.each([
    ['asc', Number.MAX_SAFE_INTEGER],
    ['desc', -Number.MAX_SAFE_INTEGER],
  ])('sorts numeric fields on the field itself, %s, with missing values last', (direction, missing) => {
    expect(body({ sort: { field: 'end_date', direction }, nextToken: '1609459200000' })).toMatchObject({
      sort: [{ end_date: { order: direction, missing } }],
      search_after: [1609459200000],
    });
  });

  test('returns a numeric sort value as a string token', () => {
    const hit = (sort: unknown[]) => ({ _source: { id: 'a' }, sort });
    const page = (hits: object[]) => resolver.response({ result: { hits: { hits, total: { value: 1 } } } });
    expect(page([hit([1609459200000])]).nextToken).toBe('1609459200000');
    expect(page([hit(['Maps'])]).nextToken).toBe('Maps');
    expect(page([]).nextToken).toBeNull();
  });
});

test('date fields come from the mapping files', () => {
  expect(dateFields(['archive'])).toEqual(['end_date', 'start_date']);
  expect(dateFields(['archive', 'collection'])).toEqual([
    'embargo_end_date',
    'embargo_start_date',
    'end_date',
    'start_date',
  ]);
});
