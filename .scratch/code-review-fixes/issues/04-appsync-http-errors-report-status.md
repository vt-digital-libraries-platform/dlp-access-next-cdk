# 04: AppSync HTTP errors report their status

**What to build:** When an AppSync request fails at the HTTP level, the error the caller sees includes the HTTP status. That covers a wrong `APPSYNC_API_URL`, an IAM 403, and a proxy returning HTML. Today the response body is parsed as JSON before the status is checked, so a body that isn't JSON produces a JSON parse error and the real status is lost. GraphQL errors in a 200 response keep their current handling.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Confirm that a 403 with an HTML or empty body currently surfaces as a JSON parse error
- [ ] A response that isn't OK produces an error with the status, the status text and a short snippet of the body
- [ ] A body that isn't JSON on an OK response produces a clear error, not a raw parse exception
- [ ] `npx tsc --noEmit` and `npm run lint` pass
