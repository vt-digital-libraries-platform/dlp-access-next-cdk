# 06: The Web stack's sign-in callback path can't drift from the app's route

**What to build:** Renaming the sign-in callback route can't leave the Cognito app client registered with the old URL. Today the Web stack and the app's auth module each define the `/authorize` path, and nothing ties the two together. A rename in only one place would break every sign-in with Cognito's `redirect_mismatch`. Either share one definition across the root and `infra/` projects (they are separate npm projects), or add a test that fails when the two disagree. Also move the comment that explains `BUNDLE_EXCLUDES` back above that constant: it now sits above the local-origin and callback-path constants.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The callback path is defined once, or a test fails when the two copies differ
- [ ] The `BUNDLE_EXCLUDES` comment sits directly above `BUNDLE_EXCLUDES`
- [ ] `npm test` (in `infra/`) and `npx tsc --noEmit` pass
