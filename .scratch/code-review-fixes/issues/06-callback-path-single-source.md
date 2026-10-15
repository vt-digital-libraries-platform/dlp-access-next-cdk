# 06: The Web stack's sign-in callback path can't drift from the app's route

**What to build:** Renaming the sign-in callback route can't leave the Cognito app client registered with the old URL. Today the Web stack and the app's auth module each define the `/authorize` path, and nothing ties the two together. A rename in only one place would break every sign-in with Cognito's `redirect_mismatch`. Either share one definition across the root and `infra/` projects (they are separate npm projects), or add a test that fails when the two disagree. Also move the comment that explains `BUNDLE_EXCLUDES` back above that constant: it now sits above the local-origin and callback-path constants.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The callback path is defined once, or a test fails when the two copies differ
- [x] The `BUNDLE_EXCLUDES` comment sits directly above `BUNDLE_EXCLUDES`
- [x] `npm test` (in `infra/`) and `npx tsc --noEmit` pass

## Comments

Kept two copies, because the root app and `infra/` are separate npm projects. `infra/lib/web-stack.ts` now exports `CALLBACK_PATH`. A Web stack test in `infra/test/app.test.ts` reads `src/lib/auth.ts` as text and fails when its `CALLBACK_PATH` differs. The same test also fails when `src/app/<path>/route.ts` doesn't exist, so it catches a renamed route folder too. Both constants have a comment that points at the test.
