import { NextResponse, type NextRequest } from "next/server";
import { generators } from "openid-client";
import { LOGIN_COOKIE, SCOPE, baseUrl, getClient, identityProvider, redirectUri, safeReturnTo } from "@/lib/auth";

// Sends the browser to the user pool's managed login, or through it to the
// configured identity provider.
export async function GET(request: NextRequest) {
  const client = await getClient();
  const state = generators.state();
  const nonce = generators.nonce();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  const provider = identityProvider();

  const response = NextResponse.redirect(
    client.authorizationUrl({
      scope: SCOPE,
      state,
      nonce,
      redirect_uri: redirectUri(request),
      ...(provider ? { identity_provider: provider } : {}),
    }),
  );
  response.cookies.set(LOGIN_COOKIE, JSON.stringify({ state, nonce, returnTo }), {
    httpOnly: true,
    // Lax, so the cookie is sent on the redirect back from Cognito.
    sameSite: "lax",
    secure: baseUrl(request).startsWith("https://"),
    path: "/",
    maxAge: 600,
  });
  return response;
}
