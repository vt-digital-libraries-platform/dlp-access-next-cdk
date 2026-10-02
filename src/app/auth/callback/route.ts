import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_COOKIE, SESSION_COOKIE, baseUrl, getClient, redirectUri, safeReturnTo } from "@/lib/auth";

function failure(message: string) {
  return new NextResponse(`Sign-in failed: ${message}`, { status: 400 });
}

// The return URL that Cognito redirects to after authentication. Exchanges
// the authorization code for tokens and stores the ID token as the session.
export async function GET(request: NextRequest) {
  const loginCookie = request.cookies.get(LOGIN_COOKIE)?.value;
  if (!loginCookie) return failure("the sign-in attempt expired. Try again.");

  let login: { state?: string; nonce?: string; returnTo?: string };
  try {
    login = JSON.parse(loginCookie);
  } catch {
    return failure("the sign-in attempt is invalid. Try again.");
  }

  let idToken: string | undefined;
  let expiresAt: number | undefined;
  try {
    const client = await getClient();
    const params = Object.fromEntries(request.nextUrl.searchParams);
    // Checks the state, and the ID token's signature, audience and nonce.
    const tokenSet = await client.callback(redirectUri(request), params, {
      state: login.state,
      nonce: login.nonce,
    });
    idToken = tokenSet.id_token;
    expiresAt = tokenSet.claims().exp;
  } catch (err) {
    console.error("Cognito callback error:", err);
    return failure(err instanceof Error ? err.message : String(err));
  }
  if (!idToken || !expiresAt) return failure("Cognito returned no ID token.");

  const base = baseUrl(request);
  const response = NextResponse.redirect(`${base}${safeReturnTo(login.returnTo)}`);
  response.cookies.set(SESSION_COOKIE, idToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: base.startsWith("https://"),
    path: "/",
    expires: new Date(expiresAt * 1000),
  });
  response.cookies.set(LOGIN_COOKIE, "", { path: "/auth", maxAge: 0 });
  return response;
}
