import * as fs from 'fs';
import * as path from 'path';
import { parse, type TypeNode } from 'graphql';
import { SEARCHABLE_MODELS } from './models';

/**
 * Explicit OpenSearch mappings for the searchable models, derived from the
 * GraphQL schema the same way the Amplify app derives its own
 * (`amplify/data/opensearch-mappings.ts` in dlp-access).
 *
 * Without explicit mappings the indexes are created by dynamic mapping, which
 * guesses field types from the first documents indexed. Date detection turns
 * free-text fields such as display_date into `date` fields, and every later
 * document whose value doesn't parse (e.g. "circa 1920") is rejected.
 *
 * Type mapping:
 *   String, ID, AWSEmail, AWSURL, ...  text + .keyword subfield
 *   fields in DATE_FIELDS             date in DATE_FORMATS, ignore_malformed
 *   AWSDateTime / AWSDate             date in DATE_FORMATS, ignore_malformed
 *   Boolean                           boolean
 *   Int / Float                       long / double
 *   AWSJSON                           object, not indexed (kept in _source)
 *   AWSJSON in INDEXED_JSON_FIELDS    object with indexed subfields
 *   date_range (not in the schema)    date_range, see DATE_RANGE_FIELD
 * Attributes not declared in the schema are kept in _source but not indexed
 * ("dynamic": false).
 */

// Fields whose values are dates in varying formats, most of them typed String
// in the schema. They're indexed as dates so range filters and sorts compare
// them as dates; a value that doesn't parse is left out of the field instead
// of the whole document being rejected. The resolvers sort on these fields
// directly rather than on a .keyword subfield (see numericSortFields).
export const DATE_FIELDS = [
  'date',
  'start_date',
  'end_date',
  'embargo_start_date',
  'embargo_end_date',
];

const DATE_FORMATS = [
  'yyyy/MM/dd HH:mm:ss',
  'yyyy/MM/dd',
  'yyyy/MM',
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd',
  'yyyy-MM',
  'yyyy',
  'M/d/yyyy',
  'strict_date_optional_time',
].join('||');

type FieldMapping = Record<string, unknown>;
export interface IndexMapping {
  dynamic: false;
  date_detection: false;
  properties: Record<string, FieldMapping>;
}

const TEXT_WITH_KEYWORD: FieldMapping = {
  type: 'text',
  fields: { keyword: { type: 'keyword', ignore_above: 256 } },
};
const DATE_FIELD: FieldMapping = {
  type: 'date',
  format: DATE_FORMATS,
  ignore_malformed: true,
};

/**
 * A derived field, not in the schema: the interval a document's dates cover.
 * The streaming handler computes it (`lambda/opensearch-streaming/date_range.py`)
 * from start_date and end_date, or from date when neither is set, so "1963"
 * covers the whole year and "194X" the decade. A range filter on it matches
 * documents whose interval overlaps the filter's. Range fields can't be
 * sorted on; sort on start_date.
 */
export const DATE_RANGE_FIELD = 'date_range';
const DATE_RANGE: FieldMapping = { type: 'date_range', format: 'strict_date_optional_time' };

const SCALAR_MAPPINGS: Record<string, FieldMapping> = {
  Boolean: { type: 'boolean' },
  Int: { type: 'long' },
  Float: { type: 'double' },
  AWSDateTime: DATE_FIELD,
  AWSDate: DATE_FIELD,
  AWSJSON: { type: 'object', enabled: false },
};

// A number stored as a string ("3.14"). A value that isn't a number is left
// out of the field instead of the whole document being rejected.
const NUMBER: FieldMapping = { type: 'double', ignore_malformed: true };

// An AWSJSON field whose subfields are mapped as documents arrive: strings as
// text with a .keyword subfield, numbers as long or double. A subfield keeps
// the type of its first value, so a later document with a different type for
// it is rejected. Strings are never detected as dates (date_detection is off).
const DYNAMIC_OBJECT: FieldMapping = { type: 'object', dynamic: true };

// archiveOptions holds the viewer settings of a 3D record: the glTF keys or
// the X3DOM keys of `assets`, depending on its media_type. Keys not listed
// here are kept in _source but not indexed.
const ARCHIVE_OPTIONS: FieldMapping = {
  type: 'object',
  properties: {
    assets: {
      type: 'object',
      properties: {
        media_type: TEXT_WITH_KEYWORD,
        // glTF
        env_config: TEXT_WITH_KEYWORD,
        gltf_config: TEXT_WITH_KEYWORD,
        thumbnail: TEXT_WITH_KEYWORD,
        // X3DOM
        morpho_thumb: TEXT_WITH_KEYWORD,
        x3d_config: TEXT_WITH_KEYWORD,
        x3d_src_img: TEXT_WITH_KEYWORD,
      },
    },
    config: {
      type: 'object',
      properties: {
        _3d: {
          type: 'object',
          properties: {
            rotation: {
              type: 'object',
              properties: { horizontal: NUMBER, vertical: NUMBER },
            },
            scale_factor: NUMBER,
          },
        },
      },
    },
  },
};

/** The AWSJSON fields that are indexed, by model. The others stay unindexed. */
export const INDEXED_JSON_FIELDS: Record<string, Record<string, FieldMapping>> = {
  Archive: {
    alt_text: DYNAMIC_OBJECT,
    archiveOptions: ARCHIVE_OPTIONS,
    extracted_text: DYNAMIC_OBJECT,
    manifest_file_characterization: DYNAMIC_OBJECT,
    visual_description: DYNAMIC_OBJECT,
  },
  Collection: {
    collectionOptions: DYNAMIC_OBJECT,
    ownerinfo: DYNAMIC_OBJECT,
  },
};

const STRING_SCALARS = new Set([
  'String',
  'ID',
  'AWSEmail',
  'AWSURL',
  'AWSPhone',
  'AWSIPAddress',
  'AWSTime',
]);

function namedType(type: TypeNode): string {
  return type.kind === 'NamedType' ? type.name.value : namedType(type.type);
}

/** Mappings keyed by index name (the lowercased model name). */
export function buildSearchMappings(schema: string): Record<string, IndexMapping> {
  const definitions = parse(schema).definitions;
  const typeNames = new Set(
    definitions.flatMap((d) =>
      d.kind === 'ObjectTypeDefinition' || d.kind === 'InterfaceTypeDefinition' ? [d.name.value] : [],
    ),
  );

  const mappings: Record<string, IndexMapping> = {};
  for (const def of definitions) {
    if (def.kind !== 'ObjectTypeDefinition') continue;
    if (!(SEARCHABLE_MODELS as readonly string[]).includes(def.name.value)) continue;
    const properties: Record<string, FieldMapping> = {};
    const jsonFields = INDEXED_JSON_FIELDS[def.name.value] ?? {};
    for (const field of def.fields ?? []) {
      const name = field.name.value;
      const type = namedType(field.type);
      if (typeNames.has(type)) continue; // relationship, not a stored attribute
      if (DATE_FIELDS.includes(name) && type === 'String') {
        properties[name] = DATE_FIELD;
      } else if (type === 'AWSJSON' && jsonFields[name]) {
        properties[name] = jsonFields[name];
      } else if (SCALAR_MAPPINGS[type]) {
        properties[name] = SCALAR_MAPPINGS[type];
      } else if (STRING_SCALARS.has(type)) {
        properties[name] = TEXT_WITH_KEYWORD;
      } else {
        throw new Error(`No mapping for ${def.name.value}.${name}: ${type}`);
      }
    }
    properties[DATE_RANGE_FIELD] = DATE_RANGE;
    mappings[def.name.value.toLowerCase()] = { dynamic: false, date_detection: false, properties };
  }
  return mappings;
}

const SCHEMA_FILE = path.join(__dirname, '..', 'schema', 'schema.graphql');
let cached: Record<string, IndexMapping> | undefined;

/** The mappings of one index, generated from `schema/schema.graphql`. */
export function searchMappings(index: string): IndexMapping {
  cached ??= buildSearchMappings(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  const mapping = cached[index];
  if (!mapping) throw new Error(`No searchable model for index "${index}"`);
  return mapping;
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
