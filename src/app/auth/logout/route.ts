import { NextResponse } from "next/server";
import { SESSION_COOKIE, authConfig, baseUrl, getClient } from "@/lib/auth";

// Erases the session and ends the managed login session at Cognito, which
// then redirects to the home page. The session cookie is cleared even when
// Cognito's logout endpoint can't be found: the user is then signed out of
// the app and sent home, though managed login may still remember them.
export async function GET(request: Request) {
  const home = `${baseUrl(request)}/`;
  let target: string | URL = home;
  try {
    target = await cognitoLogoutUrl(home);
  } catch (err) {
    console.error("Couldn't build Cognito's logout URL:", err);
  }

  const response = NextResponse.redirect(target);
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

async function cognitoLogoutUrl(logoutUri: string): Promise<URL> {
  const client = await getClient();
  const endSessionEndpoint = client.issuer.metadata.end_session_endpoint;
  if (!endSessionEndpoint)
    throw new Error(
      "The user pool's OIDC metadata has no end_session_endpoint.",
    );

  // Cognito's logout endpoint takes client_id and logout_uri rather than the
  // standard OIDC parameters.
  const logoutUrl = new URL(endSessionEndpoint);
  logoutUrl.searchParams.set("client_id", authConfig().clientId);
  logoutUrl.searchParams.set("logout_uri", logoutUri);
  return logoutUrl;
}
