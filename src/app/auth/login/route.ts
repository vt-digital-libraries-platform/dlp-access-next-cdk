import { NextResponse, type NextRequest } from "next/server";
import { generators } from "openid-client";
import { LOGIN_COOKIE, SCOPE, baseUrl, getClient, redirectUri, safeReturnTo } from "@/lib/auth";

// Sends the browser to the user pool's managed login.
export async function GET(request: NextRequest) {
  const client = await getClient();
  const state = generators.state();
  const nonce = generators.nonce();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  const response = NextResponse.redirect(
    client.authorizationUrl({ scope: SCOPE, state, nonce, redirect_uri: redirectUri(request) }),
  );
  response.cookies.set(LOGIN_COOKIE, JSON.stringify({ state, nonce, returnTo }), {
    httpOnly: true,
    // Lax, so the cookie is sent on the redirect back from Cognito.
    sameSite: "lax",
    secure: baseUrl(request).startsWith("https://"),
    path: "/auth",
    maxAge: 600,
  });
  return response;
}
