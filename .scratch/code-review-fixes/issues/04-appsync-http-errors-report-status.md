# 04: AppSync HTTP errors report their status

**What to build:** When an AppSync request fails at the HTTP level, the error the caller sees includes the HTTP status. That covers a wrong `APPSYNC_API_URL`, an IAM 403, and a proxy returning HTML. Today the response body is parsed as JSON before the status is checked, so a body that isn't JSON produces a JSON parse error and the real status is lost. GraphQL errors in a 200 response keep their current handling.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Confirm that a 403 with an HTML or empty body currently surfaces as a JSON parse error
- [x] A response that isn't OK produces an error with the status, the status text and a short snippet of the body
- [x] A body that isn't JSON on an OK response produces a clear error, not a raw parse exception
- [x] `npx tsc --noEmit` and `npm run lint` pass

## Comments

Implemented in 8ec8599 and the follow-up review commit. `graphqlRequest` reads the body as text, checks the status first, and throws `AppSync request failed: HTTP <status> <status text>: <body snippet>` (whitespace collapsed, 200 characters, `(empty body)` when blank; the status text is left out when the response has none, as over HTTP/2). An OK response whose body isn't JSON throws `HTTP <status> response is not JSON: <snippet>`. GraphQL errors on a 200 are unchanged. Confirmed before and after with a script that compiles `appsync.ts` against a local HTTP server (403 with HTML, empty and AppSync JSON bodies, a long 502, 403 with no status text, 200 with HTML or empty bodies, 200 with GraphQL errors, and a good 200); before the change the HTML and empty bodies surfaced as `SyntaxError`s.

On a non-OK response with AppSync's own JSON error body, the message carries the raw JSON snippet rather than the parsed `errors` messages.

`npm run lint` still fails only on generated files in `infra/cdk.out/`, as noted on 03; `src` lints clean.
