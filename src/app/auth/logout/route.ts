import { NextResponse } from "next/server";
import { SESSION_COOKIE, authConfig, baseUrl, getClient } from "@/lib/auth";

// Erases the session and ends the managed login session at Cognito, which
// then redirects to the home page.
export async function GET(request: Request) {
  const client = await getClient();
  const endSessionEndpoint = client.issuer.metadata.end_session_endpoint;
  if (!endSessionEndpoint) throw new Error("The user pool's OIDC metadata has no end_session_endpoint.");

  // Cognito's logout endpoint takes client_id and logout_uri rather than the
  // standard OIDC parameters.
  const logoutUrl = new URL(endSessionEndpoint);
  logoutUrl.searchParams.set("client_id", authConfig().clientId);
  logoutUrl.searchParams.set("logout_uri", `${baseUrl(request)}/`);

  const response = NextResponse.redirect(logoutUrl);
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
