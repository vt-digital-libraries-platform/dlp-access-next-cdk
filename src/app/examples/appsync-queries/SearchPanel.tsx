"use client";

import { useState, useTransition } from "react";
import { searchCatalog, type SearchResponse, type SearchScope } from "./actions";

const SCOPES: { value: SearchScope; label: string }[] = [
  { value: "archives", label: "Archives" },
  { value: "collections", label: "Collections" },
  { value: "both", label: "Both" },
];

const TYPE_STYLES = {
  Archive: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  Collection: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

export function SearchPanel() {
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState<SearchScope>("both");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searched, setSearched] = useState("");
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      setSearched(term.trim());
      setResponse(await searchCatalog(term, scope));
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search archives and collections…"
            aria-label="Search term"
            className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={pending || !term.trim()}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {pending ? "Searching…" : "Search"}
          </button>
        </div>
        <fieldset className="flex flex-wrap gap-4 text-sm text-zinc-700 dark:text-zinc-300">
          <legend className="sr-only">Record type</legend>
          {SCOPES.map((s) => (
            <label key={s.value} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="scope"
                value={s.value}
                checked={scope === s.value}
                onChange={() => setScope(s.value)}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
      </form>

      {response && (
        <div className="flex flex-col gap-2">
          {response.error ? (
            <p className="text-sm text-red-700 dark:text-red-400">{response.error}</p>
          ) : (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Showing {response.items.length} of {response.total} results for “{searched}”.
              </p>
              {response.items.length > 0 && (
                <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {response.items.map((item) => (
                    <li key={`${item.type}-${item.id}`} className="flex flex-col gap-1 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_STYLES[item.type]}`}>
                          {item.type}
                          {item.category ? ` · ${item.category}` : ""}
                        </span>
                        <span className="text-sm font-medium text-black dark:text-zinc-50">
                          {item.title ?? "(untitled)"}
                        </span>
                      </div>
                      <code className="text-xs text-zinc-500 dark:text-zinc-400">{item.identifier ?? item.id}</code>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
