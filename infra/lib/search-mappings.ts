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

/** Top-level fields mapped as `date` in any of the given indices. */
export function dateFields(indices: readonly string[]): string[] {
  const fields = indices.flatMap((index) =>
    Object.entries(searchMappings(index).properties)
      .filter(([, mapping]) => mapping.type === 'date')
      .map(([field]) => field),
  );
  return [...new Set(fields)].sort();
}
