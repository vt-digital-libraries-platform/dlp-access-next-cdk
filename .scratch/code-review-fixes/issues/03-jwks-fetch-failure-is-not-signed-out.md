# 03: A failure to fetch Cognito's signing keys shows an error instead of a sign-in loop

**What to build:** When the app can't fetch the user pool's signing keys (JWKS), for example because of a network error or a timeout, a signed-in user sees an error instead of being bounced between the app, Cognito and `/authorize` until the keys are reachable again. Today ID token verification turns every error into "not signed in", and nothing is logged. Tokens that are actually invalid, expired or for the wrong client should still count as signed out.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Confirm that a JWKS fetch failure currently returns "no session"
- [ ] Invalid, expired or wrong-audience tokens still return "no session"
- [ ] A JWKS fetch failure is logged and shown as an error, not a redirect to sign-in
- [ ] `npx tsc --noEmit` and `npm run lint` pass
