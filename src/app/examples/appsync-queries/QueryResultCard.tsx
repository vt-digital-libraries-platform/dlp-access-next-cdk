import type { QueryDemo } from "./queries";

const STATUS_STYLES: Record<QueryDemo["status"], string> = {
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  skipped: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

export function QueryResultCard({ result }: { result: QueryDemo }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <code className="text-sm font-semibold text-black dark:text-zinc-50">{result.label}</code>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${STATUS_STYLES[result.status]}`}
        >
          {result.status}
        </span>
      </div>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">{result.description}</p>
      {result.status === "success" ? (
        <pre className="overflow-x-auto rounded bg-zinc-100 p-3 text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {JSON.stringify(result.data, null, 2)}
        </pre>
      ) : (
        <p className="text-sm text-red-700 dark:text-red-400">{result.error}</p>
      )}
    </section>
  );
}
