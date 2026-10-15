"use client";

// Shown when the page throws, notably when the session can't be verified
// because the user pool's signing keys are unreachable. Redirecting to
// sign-in instead would loop until the keys are reachable again.
export default function AppSyncQueriesError({ reset }: { reset: () => void }) {
  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-16 font-sans dark:bg-black sm:px-16">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Something went wrong
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          The page couldn&apos;t load, possibly because your sign-in couldn&apos;t be verified. Try again in a
          moment.
        </p>
        <button
          type="button"
          onClick={reset}
          className="self-start text-sm text-zinc-600 underline dark:text-zinc-400"
        >
          Try again
        </button>
      </main>
    </div>
  );
}
