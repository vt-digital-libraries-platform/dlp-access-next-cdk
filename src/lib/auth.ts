import { cookies } from "next/headers";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { Issuer, type Client } from "openid-client";

// Cognito sign-in through the user pool's managed login (OIDC authorization
// code flow). The session is the Cognito ID token itself, kept in an httpOnly
// cookie and verified against the user pool's signing keys on every request,
// so there is no server-side session store. It must only run server-side.

export const SESSION_COOKIE = "dlp_id_token";
// Holds the state, nonce and return path between /auth/login and /authorize.
export const LOGIN_COOKIE = "dlp_oidc_login";
export const ADMIN_GROUP = "admin";
export const CALLBACK_PATH = "/authorize";
export const SCOPE = "email openid";

export interface Session {
  username: string;
  email: string | null;
  groups: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. It is required for Cognito sign-in.`);
  return value;
}

// The provider users sign in through: the name of a federated identity
// provider on the user pool, or COGNITO for the pool's own users. When set,
// sign-in goes straight to it instead of showing managed login's chooser.
export function identityProvider(): string | undefined {
  return process.env.COGNITO_IDENTITY_PROVIDER || undefined;
}

export function authConfig() {
  return {
    // https://cognito-idp.<region>.amazonaws.com/<user pool id>
    issuer: requireEnv("COGNITO_ISSUER").replace(/\/$/, ""),
    clientId: requireEnv("COGNITO_CLIENT_ID"),
    clientSecret: requireEnv("COGNITO_CLIENT_SECRET"),
  };
}

// The app's public origin. Behind a proxy the request's own origin can differ
// from the one the browser sees, so APP_BASE_URL overrides it.
export function baseUrl(request: Request): string {
  return (process.env.APP_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, "");
}

export function redirectUri(request: Request): string {
  return `${baseUrl(request)}${CALLBACK_PATH}`;
}

// Only same-site paths, so the return path can't be used as an open redirect.
export function safeReturnTo(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

let clientPromise: Promise<Client> | undefined;

export function getClient(): Promise<Client> {
  if (!clientPromise) {
    const { issuer, clientId, clientSecret } = authConfig();
    clientPromise = Issuer.discover(issuer).then(
      (discovered) =>
        new discovered.Client({
          client_id: clientId,
          client_secret: clientSecret,
          response_types: ["code"],
        }),
    );
    // A failed discovery is retried on the next request.
    clientPromise.catch(() => {
      clientPromise = undefined;
    });
  }
  return clientPromise;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

// jose's codes for a token that is malformed, expired, issued for another
// client or pool, or signed with a key the pool doesn't have. Any other
// failure, such as not reaching the pool's signing keys, is an error rather
// than a signed-out user, or every request would send the user to sign in.
const INVALID_TOKEN_CODES = new Set([
  errors.JWSInvalid.code,
  errors.JWTInvalid.code,
  errors.JWTExpired.code,
  errors.JWTClaimValidationFailed.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWKSMultipleMatchingKeys.code,
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
]);

async function verifyIdToken(token: string): Promise<Session | null> {
  const { issuer, clientId } = authConfig();
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId });
    if (payload.token_use !== "id") return null;
    const groups = payload["cognito:groups"];
    return {
      username: String(payload["cognito:username"] ?? payload.sub),
      email: typeof payload.email === "string" ? payload.email : null,
      groups: Array.isArray(groups) ? groups.map(String) : [],
    };
  } catch (err) {
    if (err instanceof errors.JOSEError && INVALID_TOKEN_CODES.has(err.code)) return null;
    console.error("ID token verification error:", err);
    throw new Error("Couldn't verify the sign-in session.", { cause: err });
  }
}

// null when signed out. Throws when the session can't be verified, such as
// when the user pool's signing keys can't be fetched.
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? verifyIdToken(token) : null;
}

export function isAdmin(session: Session | null): boolean {
  return Boolean(session?.groups.includes(ADMIN_GROUP));
}
