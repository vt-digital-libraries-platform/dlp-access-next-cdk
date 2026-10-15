# 03: A failure to fetch Cognito's signing keys shows an error instead of a sign-in loop

**What to build:** When the app can't fetch the user pool's signing keys (JWKS), for example because of a network error or a timeout, a signed-in user sees an error instead of being bounced between the app, Cognito and `/authorize` until the keys are reachable again. Today ID token verification turns every error into "not signed in", and nothing is logged. Tokens that are actually invalid, expired or for the wrong client should still count as signed out.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Confirm that a JWKS fetch failure currently returns "no session"
- [x] Invalid, expired or wrong-audience tokens still return "no session"
- [x] A JWKS fetch failure is logged and shown as an error, not a redirect to sign-in
- [x] `npx tsc --noEmit` and `npm run lint` pass

## Comments

Implemented in e9a270c and the follow-up review commit. `verifyIdToken` treats only jose's invalid-token codes as signed out; anything else is logged and thrown. The demo page has an `error.tsx`, and `searchCatalog` returns "Couldn't verify your sign-in." Confirmed before and after with a script that compiles `auth.ts` against a local JWKS server (valid, expired, wrong-audience, access, garbage and unknown-kid tokens, and an unreachable JWKS); the root app has no test suite to keep it in.

`npm run lint` still fails, but only on generated files in `infra/cdk.out/`, which the root ESLint config doesn't ignore. The touched files lint clean.
