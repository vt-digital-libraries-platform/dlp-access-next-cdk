// Settings for each frontend branch's Web stack, and the rules that name and
// address a branch.

/**
 * The Node platform the app runs on, matching the hand-made
 * `appsync-stack` environment. Managed updates apply minor platform
 * versions in place, so this only needs bumping for a major change.
 */
export const SOLUTION_STACK =
  "64bit Amazon Linux 2023 v6.11.8 running Node.js 24";

export const LOCAL_ORIGIN = "http://localhost:3000";
export const CALLBACK_PATH = "/authorize";

// Each branch is served at <branch slug>.<APP_DOMAIN>, by a record in the hosted
// zone HOSTED_ZONE, over HTTPS with an existing certificate covering
// *.<APP_DOMAIN>.
export const APP_DOMAIN = "dlp-access-dev.dlp.cloud.lib.vt.edu";
// The ACM certificate covering *.<APP_DOMAIN>, by ID only: the ARN is built
// from the deploy's account and the environment's region, so no account ID
// is stored here. `-c certificate=<ARN>` overrides it.
export const CERTIFICATE_ID = "3163b25c-b6f5-4b23-8569-514064db7767";
export const HOSTED_ZONE = "dlp.cloud.lib.vt.edu";
export const TLS_POLICY = "ELBSecurityPolicy-TLS13-1-2-2021-06";

// Committed files that the Next.js server doesn't need, as git pathspecs
// (`*` also matches `/`, so `*.md` is every Markdown file). `.env*` stays
// out even if one is committed.
export const BUNDLE_EXCLUDES = [
  ".github",
  ".claude",
  ".scratch",
  ".elasticbeanstalk",
  "infra",
  "docs",
  "*.md",
  ".env*",
];

/**
 * Turns a git branch name into the slug that names a Web stack, e.g.
 * `user/Multi_Env` becomes `user-multi-env`.
 */
export function branchSlug(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Beanstalk environment names are 4 to 40 characters.
const WEB_PREFIX = "dlpnext-";
const MAX_SLUG_LENGTH = 40 - WEB_PREFIX.length;

/** Name of the branch's Beanstalk application and environment. */
export function webResourceName(slug: string): string {
  if (!slug || slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Invalid branch "${slug}": after slugifying it must be 1 to ${MAX_SLUG_LENGTH} characters; pass a shorter -c frontend-branch=<name>`,
    );
  }
  return `${WEB_PREFIX}${slug}`;
}

/** The branch's public domain name, e.g. `user-multi-env.dlp-access-dev.dlp.cloud.lib.vt.edu`. */
export function webDomainName(slug: string): string {
  return `${slug}.${APP_DOMAIN}`;
}
