import * as path from "path";

// Every filesystem path the library needs, computed from this file's place at
// the root of infra/lib, so the files that use them can move freely.

/** The infra directory: the CDK app's root. */
export const INFRA_ROOT = path.join(__dirname, "..");
/** The root of the dlp-access-next repo. */
export const REPO_ROOT = path.join(INFRA_ROOT, "..");
/** The folder holding each Lambda function's source, one subfolder per function. */
export const LAMBDA_DIR = path.join(INFRA_ROOT, "lambda");
/** The AppSync GraphQL schema. */
export const SCHEMA_FILE = path.join(INFRA_ROOT, "schema", "schema.graphql");
