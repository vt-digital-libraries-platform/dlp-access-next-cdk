import { runDemoQueries } from "./queries";
import { QueryResultCard } from "./QueryResultCard";

// Queries run against live AppSync data on every request rather than being
// cached at build time.
export const dynamic = "force-dynamic";

export default async function AppSyncQueriesExamplePage() {
  const apiUrlConfigured = Boolean(process.env.APPSYNC_API_URL);
  const results = apiUrlConfigured ? await runDemoQueries() : [];

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-16 font-sans dark:bg-black sm:px-16">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            AppSync query examples
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Runs every query defined in{" "}
            <code className="rounded bg-zinc-200 px-1 py-0.5 text-sm dark:bg-zinc-800">
              infra/schema/schema.graphql
            </code>{" "}
            against the AppSync API on page load and renders the result of each below.
          </p>
        </div>

        {!apiUrlConfigured ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Set the <code>APPSYNC_API_URL</code> environment variable to the{" "}
            <code>GraphQLApiUrl</code> output from <code>DlpAccessNextAppSyncStack</code>{" "}
            (and optionally <code>AWS_REGION</code>, default <code>us-east-1</code>) to run
            these queries.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {results.map((result) => (
              <QueryResultCard key={result.label} result={result} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
