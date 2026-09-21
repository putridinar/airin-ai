/**
 * GitHub OAuth handlers for AIRIN AI
 * /auth/github → redirect
 * /auth/github/callback → exchange code → set cookie / return token
 */

function b64url(data: ArrayBuffer | string): string {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function handleGitHubAuth(
  request: Request,
  env: Env
): Promise<Response> {
  const state = crypto.randomUUID();
  // Store state in KV for CSRF protection (TTL 10 min)
  if (env.SESSIONS) {
    await env.SESSIONS.put(`oauth:${state}`, "1", { expirationTtl: 600 });
  }

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_REDIRECT_URI,
    scope: "repo read:user",
    state,
  });

  return Response.redirect(
    `https://github.com/login/oauth/authorize?${params}`,
    302
  );
}

export async function handleGitHubCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const origin = env.FRONTEND_ORIGIN || "*";

  if (!code) {
    return Response.redirect(`${origin}/?error=missing_code`, 302);
  }

  if (state && env.SESSIONS) {
    const valid = await env.SESSIONS.get(`oauth:${state}`);
    if (!valid) {
      return Response.redirect(`${origin}/?error=invalid_state`, 302);
    }
    await env.SESSIONS.delete(`oauth:${state}`);
  }

  // Exchange code for token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_REDIRECT_URI,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenData.access_token) {
    const err = tokenData.error_description || tokenData.error || "token_failed";
    return Response.redirect(
      `${origin}/?error=${encodeURIComponent(err)}`,
      302
    );
  }

  // Redirect back to frontend with token in hash (or set httpOnly cookie via intermediate page)
  // Hash is safer for SPA static hosts that can't set cookies from Worker easily
  const redirect = `${origin}/#github_token=${encodeURIComponent(tokenData.access_token)}`;
  return Response.redirect(redirect, 302);
}
