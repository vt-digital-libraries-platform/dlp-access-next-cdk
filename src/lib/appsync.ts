import { AwsClient } from "aws4fetch";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

// The Api stack (infra/lib/api-stack.ts) authorizes this API with IAM auth
// only, granted to the environment's Elastic Beanstalk instance role.
// Requests must be SigV4-signed, so this module resolves AWS credentials via
// the standard Node credential chain (env vars / shared config locally,
// EC2/EB instance role in production) and must only run server-side.
const REGION = process.env.AWS_REGION ?? "us-east-1";
const API_URL = process.env.APPSYNC_API_URL;

const getCredentials = defaultProvider();

export interface Connection<T> {
  items: (T | null)[] | null;
  nextToken: string | null;
}

interface GraphQLResponse<T> {
  data: T | null;
  errors?: { message: string }[];
}

export async function graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!API_URL) {
    throw new Error(
      "APPSYNC_API_URL is not set. Set it to the GraphQLApiUrl output from the environment's Api stack.",
    );
  }

  const credentials = await getCredentials();
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region: REGION,
    service: "appsync",
  });

  const response = await client.fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  // Read the body as text before parsing: a wrong URL, an IAM denial or a
  // proxy can answer with HTML or nothing, and the status is what matters.
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `AppSync request failed: HTTP ${response.status} ${response.statusText}: ${snippet(body) || "(empty body)"}`,
    );
  }

  let result: GraphQLResponse<T>;
  try {
    result = JSON.parse(body) as GraphQLResponse<T>;
  } catch {
    throw new Error(`AppSync request failed: HTTP ${response.status} response is not JSON: ${snippet(body)}`);
  }

  if (result.errors?.length) {
    throw new Error(`AppSync request failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }

  return result.data as T;
}

const SNIPPET_LENGTH = 200;

function snippet(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
}
