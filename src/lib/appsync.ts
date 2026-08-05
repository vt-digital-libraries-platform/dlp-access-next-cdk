import { AwsClient } from "aws4fetch";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

// The DlpAccessNextAppSyncStack (infra/lib/appsync-stack.ts) authorizes this
// API with IAM auth only, granted to the Elastic Beanstalk instance role.
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
      "APPSYNC_API_URL is not set. Set it to the GraphQLApiUrl output from DlpAccessNextAppSyncStack.",
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

  const result = (await response.json()) as GraphQLResponse<T>;

  if (!response.ok || result.errors?.length) {
    const message = result.errors?.map((e) => e.message).join("; ") ?? response.statusText;
    throw new Error(`AppSync request failed: ${message}`);
  }

  return result.data as T;
}
