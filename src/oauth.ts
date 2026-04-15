import type { Env, RepoConfig } from "./index";

// ---- base64url ----

function base64urlEncode(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- JWT (HMAC-SHA256, WebCrypto) ----

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = base64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${base64urlEncode(sig)}`;
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC", key,
    base64urlDecode(sig),
    new TextEncoder().encode(`${header}.${body}`)
  );
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- PKCE ----

async function verifySha256Challenge(verifier: string, challenge: string): Promise<boolean> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64urlEncode(hash) === challenge;
}

// ---- Config lookup ----

type ClientMatch =
  | { repoAlias: string; repoConfig: RepoConfig; agentId: string; clientSecret: string }
  | null
  | "ambiguous";

function findClient(config: Record<string, RepoConfig>, clientId: string): ClientMatch {
  let found: { repoAlias: string; repoConfig: RepoConfig; agentId: string; clientSecret: string } | null = null;
  for (const [repoAlias, repoConfig] of Object.entries(config)) {
    const entry = repoConfig.agents[clientId];
    if (entry !== undefined) {
      if (found !== null) return "ambiguous";
      found = { repoAlias, repoConfig, agentId: entry.agent_id, clientSecret: entry.client_secret };
    }
  }
  return found;
}

// ---- /.well-known endpoints ----

export function handleWellKnown(request: Request): Response {
  const { origin, pathname } = new URL(request.url);

  if (pathname === "/.well-known/oauth-protected-resource") {
    return Response.json({
      resource: origin,
      authorization_servers: [origin],
    });
  }

  if (pathname === "/.well-known/oauth-authorization-server") {
    return Response.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  return new Response("Not found", { status: 404 });
}

// ---- /authorize ----

export async function handleAuthorize(
  request: Request,
  env: Env,
  config: Record<string, RepoConfig>
): Promise<Response> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");
    const state = url.searchParams.get("state") ?? "";
    const responseType = url.searchParams.get("response_type");

    if (responseType !== "code") return oauthError("unsupported_response_type");
    if (!clientId || !redirectUri || !codeChallenge) return oauthError("invalid_request");
    if (codeChallengeMethod !== "S256") {
      return oauthError("invalid_request", "Only S256 code_challenge_method is supported");
    }

    const match = findClient(config, clientId);
    if (match === "ambiguous") return oauthError("server_error", "Ambiguous client_id in server config");
    if (match === null) return oauthError("invalid_client");

    // Wrap all validated params in a short-lived JWT so the POST has nothing to forge
    const pendingToken = await signJwt({
      type: "pending",
      client_id: clientId,
      repo_alias: match.repoAlias,
      agent_id: match.agentId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      state,
      exp: Math.floor(Date.now() / 1000) + 300,
    }, env.JWT_SECRET);

    if (env.OAUTH_AUTO_APPROVE === "true") {
      return issueAuthCode(pendingToken, env.JWT_SECRET);
    }

    return new Response(
      approvalPage(clientId, match.repoAlias, match.agentId, pendingToken),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  if (request.method === "POST") {
    let body: URLSearchParams;
    try {
      body = new URLSearchParams(await request.text());
    } catch {
      return oauthError("invalid_request");
    }
    const pendingToken = body.get("pending_token");
    if (!pendingToken) return oauthError("invalid_request");

    if (body.get("action") === "deny") {
      return new Response(
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Denied</title>
<style>body{font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 16px}</style></head>
<body><h2>Authorization denied</h2><p>You may close this window.</p></body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    return issueAuthCode(pendingToken, env.JWT_SECRET);
  }

  return new Response("Method not allowed", { status: 405 });
}

async function issueAuthCode(pendingToken: string, jwtSecret: string): Promise<Response> {
  const pending = await verifyJwt(pendingToken, jwtSecret);
  if (!pending || pending.type !== "pending") return oauthError("invalid_request");

  const { redirect_uri, state, client_id, repo_alias, agent_id, code_challenge } = pending;
  if (
    typeof redirect_uri !== "string" || typeof client_id !== "string" ||
    typeof repo_alias !== "string" || typeof agent_id !== "string" ||
    typeof code_challenge !== "string"
  ) return oauthError("invalid_request");

  const authCode = await signJwt({
    type: "auth_code",
    client_id,
    repo_alias,
    agent_id,
    redirect_uri,
    code_challenge,
    exp: Math.floor(Date.now() / 1000) + 300,
  }, jwtSecret);

  const dest = new URL(redirect_uri);
  dest.searchParams.set("code", authCode);
  if (state) dest.searchParams.set("state", state as string);
  return Response.redirect(dest.toString(), 302);
}

// ---- /token ----

export async function handleToken(
  request: Request,
  env: Env,
  config: Record<string, RepoConfig>
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: URLSearchParams;
  try {
    body = new URLSearchParams(await request.text());
  } catch {
    return tokenError("invalid_request");
  }

  const grantType = body.get("grant_type");

  if (grantType === "authorization_code") {
    const code = body.get("code");
    const codeVerifier = body.get("code_verifier");
    const clientId = body.get("client_id");
    const clientSecret = body.get("client_secret");
    const redirectUri = body.get("redirect_uri");

    if (!code || !codeVerifier || !clientId || !clientSecret || !redirectUri) {
      return tokenError("invalid_request");
    }

    const payload = await verifyJwt(code, env.JWT_SECRET);
    if (!payload || payload.type !== "auth_code") return tokenError("invalid_grant");
    if (payload.client_id !== clientId) return tokenError("invalid_client");
    if (payload.redirect_uri !== redirectUri) return tokenError("invalid_grant");
    if (typeof payload.code_challenge !== "string") return tokenError("invalid_grant");
    if (!await verifySha256Challenge(codeVerifier, payload.code_challenge)) return tokenError("invalid_grant");

    const match = findClient(config, clientId);
    if (!match || match === "ambiguous") return tokenError("invalid_client");
    if (match.clientSecret !== clientSecret) return tokenError("invalid_client");

    return issueTokens(
      clientId,
      payload.repo_alias as string,
      payload.agent_id as string,
      env.JWT_SECRET
    );
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.get("refresh_token");
    const clientId = body.get("client_id");
    const clientSecret = body.get("client_secret");

    if (!refreshToken || !clientId || !clientSecret) return tokenError("invalid_request");

    const payload = await verifyJwt(refreshToken, env.JWT_SECRET);
    if (!payload || payload.type !== "refresh_token") return tokenError("invalid_grant");
    if (payload.client_id !== clientId) return tokenError("invalid_client");

    const match = findClient(config, clientId);
    if (!match || match === "ambiguous") return tokenError("invalid_client");
    if (match.clientSecret !== clientSecret) return tokenError("invalid_client");

    return issueTokens(
      clientId,
      payload.repo_alias as string,
      payload.agent_id as string,
      env.JWT_SECRET
    );
  }

  return tokenError("unsupported_grant_type");
}

async function issueTokens(
  clientId: string,
  repoAlias: string,
  agentId: string,
  secret: string
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const [accessToken, refreshToken] = await Promise.all([
    signJwt(
      { type: "access_token", client_id: clientId, repo_alias: repoAlias, agent_id: agentId, exp: now + 3600 },
      secret
    ),
    signJwt(
      { type: "refresh_token", client_id: clientId, repo_alias: repoAlias, agent_id: agentId, exp: now + 60 * 60 * 24 * 30 },
      secret
    ),
  ]);
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
  });
}

// ---- Access token verification (used by MCP handler) ----

export async function verifyAccessToken(
  request: Request,
  env: Env,
  config: Record<string, RepoConfig>
): Promise<{ repoAlias: string; agentId: string; repoConfig: RepoConfig } | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
  if (!payload || payload.type !== "access_token") return null;
  const { repo_alias, agent_id } = payload;
  if (typeof repo_alias !== "string" || typeof agent_id !== "string") return null;
  const repoConfig = config[repo_alias];
  if (!repoConfig) return null;
  return { repoAlias: repo_alias, agentId: agent_id, repoConfig };
}

// ---- Response helpers ----

function oauthError(error: string, description?: string): Response {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return Response.json(body, { status: 400 });
}

function tokenError(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

// ---- HTML helpers ----

function approvalPage(clientId: string, repoAlias: string, agentId: string, pendingToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize</title>
<style>
  body { font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 16px; }
  button { padding: 10px 24px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; }
</style>
</head>
<body>
<h2>Authorization Request</h2>
<p>Allow <strong>${esc(clientId)}</strong> to access repo <strong>${esc(repoAlias)}</strong> as agent <strong>${esc(agentId)}</strong>?</p>
<form method="POST">
  <input type="hidden" name="pending_token" value="${esc(pendingToken)}">
  <button type="submit" name="action" value="approve">Approve</button>
  <button type="submit" name="action" value="deny" style="margin-left:12px;background:#666;">Deny</button>
</form>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
