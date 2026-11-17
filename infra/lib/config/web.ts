/**
 * Settings for each frontend branch's Web stack, and the rules that name and
 * address a branch.
 */

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
  checkSlugLength(slug, slug, "-c frontend-branch=<name>");
  return `${WEB_PREFIX}${slug}`;
}

function checkSlugLength(branch: string, slug: string, flag: string): void {
  if (!slug || slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Invalid branch "${branch}": after slugifying it must be 1 to ${MAX_SLUG_LENGTH} characters; pass a shorter ${flag}`,
    );
  }
}

// Git never allows these in a branch name, and the deploy scripts print the
// name before asking to confirm, where escape sequences could rewrite the screen.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/**
 * Checks a branch name and returns its slug. `option` names the option in
 * errors, e.g. `frontend-branch`, and `flag` shows how to pass it.
 */
export function validBranchSlug(
  branch: string,
  option: string,
  flag: string,
): string {
  if (CONTROL_CHARACTERS.test(branch)) {
    throw new Error(
      `Invalid ${option} ${JSON.stringify(branch)}: a git branch name has no control characters`,
    );
  }
  const slug = branchSlug(branch);
  checkSlugLength(branch, slug, flag);
  return slug;
}

const CERTIFICATE_ARN_PATTERN =
  /^arn:aws:acm:([a-z0-9-]+):(\d{12}):certificate\/[0-9a-f-]+$/;

/** Checks that `arn` is an ACM certificate in the account and region. */
export function checkCertificateArn(
  arn: string,
  region: string,
  awsAccountId: string,
): void {
  const [, certificateRegion, certificateAccount] =
    CERTIFICATE_ARN_PATTERN.exec(arn) ?? [];
  if (certificateRegion === undefined) {
    throw new Error(`Invalid certificate "${arn}": use an ACM certificate ARN`);
  }
  if (certificateRegion !== region || certificateAccount !== awsAccountId) {
    throw new Error(
      `Invalid certificate "${arn}": the certificate must be in account ${awsAccountId} and ${region}, the environment's region`,
    );
  }
}

/**
 * Every frontend's secrets are named under this prefix, e.g.
 * `dlpnext/<slug>/cognito-client-secret`.
 */
export const FRONTEND_SECRET_PREFIX = "dlpnext/";

/** The Secrets Manager secret holding the branch's Cognito client secret. */
export function frontendSecretName(slug: string): string {
  return `${FRONTEND_SECRET_PREFIX}${slug}/cognito-client-secret`;
}

/** The Beanstalk application every frontend's environment lives in, one per account. */
export const FRONTEND_APPLICATION = "dlpnext";

/** The default certificate's ARN in the deploying account and region. */
export function defaultCertificateArn(
  region: string,
  awsAccountId: string,
): string {
  return `arn:aws:acm:${region}:${awsAccountId}:certificate/${CERTIFICATE_ID}`;
}

/** The branch's public domain name, e.g. `user-multi-env.dlp-access-dev.dlp.cloud.lib.vt.edu`. */
export function webDomainName(slug: string): string {
  return `${slug}.${APP_DOMAIN}`;
}
