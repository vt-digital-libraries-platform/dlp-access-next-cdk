import * as fs from 'fs';
import * as path from 'path';

interface FieldMapping {
  readonly type?: string;
}

/** The `mappings` object of `schema/opensearch/<index>.json`. */
export function searchMappings(index: string): { properties: Record<string, FieldMapping> } {
  const file = path.join(__dirname, '..', 'schema', 'opensearch', `${index}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).mappings;
}

/**
 * Top-level fields mapped as `date` or `boolean` in any of the given
 * indices. They have no `.keyword` subfield, and OpenSearch sorts them by
 * number (epoch millis, or 0/1).
 */
export function numericSortFields(indices: readonly string[]): string[] {
  const fields = indices.flatMap((index) =>
    Object.entries(searchMappings(index).properties)
      .filter(([, mapping]) => mapping.type === 'date' || mapping.type === 'boolean')
      .map(([field]) => field),
  );
  return [...new Set(fields)].sort();
}
