import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const SIMKL_CLIENT_ID_PATTERN = /^[a-z0-9]+$/i;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map();
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname === "/api/simkl/login-url" && request.method === "POST") {
      await handleLoginUrl(response);
      return;
    }
    if (url.pathname === "/api/simkl/callback" && request.method === "GET") {
      await handleCallback(url, response);
      return;
    }
    if (url.pathname === "/api/simkl/refresh" && request.method === "POST") {
      await handleRefresh(request, response);
      return;
    }
    if (url.pathname === "/config.js" && process.env.SIMKL_CLIENT_ID) {
      serveRuntimeConfig(response);
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    json(response, error.status || 500, { error: error.publicMessage || error.message || "Server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Nuvio Simkl Bridge running at http://${host}:${port}/`);
});

async function handleLoginUrl(response) {
  const { clientId, redirectUri } = simklConfig();
  const state = crypto.randomUUID();
  rememberOauthState(state);
  const url = new URL("https://simkl.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  json(response, 200, { url: url.toString(), state, client_id: clientId });
}

async function handleCallback(url, response) {
  const { clientId, clientSecret, redirectUri } = simklConfig();
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") || "";
  if (!consumeOauthState(state)) {
    html(response, callbackHtml({
      source: "simkl-oauth",
      status: "error",
      state,
      client_id: clientId,
      error: "invalid_state",
      error_description: "The Simkl authorization state was missing or expired. Please close this popup and connect again.",
    }));
    return;
  }
  if (error || !code) {
    html(response, callbackHtml({
      source: "simkl-oauth",
      status: "error",
      state,
      client_id: clientId,
      error: error || "missing_code",
      error_description: url.searchParams.get("error_description") || "",
    }));
    return;
  }

  const simklResponse = await fetch("https://api.simkl.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const { payload, text } = await readJsonResponse(simklResponse);
  const tokenError = simklResponse.ok ? null : tokenExchangeError(simklResponse, payload, text);
  if (tokenError) {
    console.warn(`Simkl token exchange failed: ${tokenError.error_description}`);
  }
  html(response, callbackHtml({
    source: "simkl-oauth",
    status: simklResponse.ok ? "success" : "error",
    state,
    client_id: clientId,
    tokens: simklResponse.ok ? payload : undefined,
    error: tokenError?.error,
    error_description: tokenError?.error_description,
  }));
}

async function handleRefresh(request, response) {
  const { clientId, clientSecret, redirectUri } = simklConfig();
  const body = await readJsonBody(request);
  if (!body.refresh_token) {
    json(response, 400, { error: "Missing refresh token" });
    return;
  }
  const simklResponse = await fetch("https://api.simkl.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      refresh_token: body.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "refresh_token",
    }),
  });
  const text = await simklResponse.text();
  response.writeHead(simklResponse.status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(text || "{}");
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);
  const content = await readFile(filePath);
  response.writeHead(200, { "Content-Type": mime[extname(filePath)] || "application/octet-stream" });
  response.end(content);
}

function callbackHtml(payload) {
  const targetOrigin = process.env.SIMKL_CALLBACK_ORIGIN || `http://${host}:${port}`;
  const jsonPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Simkl connected</title></head>
<body>
<script>
const payload = ${jsonPayload};
try { if (window.opener) window.opener.postMessage(payload, ${JSON.stringify(targetOrigin)}); } catch (error) {}
try { new BroadcastChannel("nuvio-simkl-bridge.simkl-oauth").postMessage(payload); } catch (error) {}
window.close();
</script>
You can close this window.
</body></html>`;
}

function serveRuntimeConfig(response) {
  const origin = process.env.SIMKL_CALLBACK_ORIGIN || `http://${host}:${port}`;
  const script = `window.NUVIO_SIMKL_BRIDGE_CONFIG = ${JSON.stringify({
    simklLoginUrlEndpoint: "/api/simkl/login-url",
    simklRefreshEndpoint: "/api/simkl/refresh",
    simklCallbackOrigin: origin,
  }, null, 2)};`;
  response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
  response.end(script);
}

function requireEnv(names) {
  const missing = names.filter((name) => !String(process.env[name] || "").trim());
  if (missing.length) {
    throw serverSetupError();
  }
}

function simklConfig() {
  requireEnv(["SIMKL_CLIENT_ID", "SIMKL_CLIENT_SECRET", "SIMKL_REDIRECT_URI"]);
  const redirectUri = String(process.env.SIMKL_REDIRECT_URI || "").trim();
  validateRedirectUri(redirectUri);
  return {
    clientId: validatedSimklClientId(),
    clientSecret: String(process.env.SIMKL_CLIENT_SECRET || "").trim(),
    redirectUri,
  };
}

function validatedSimklClientId() {
  const clientId = String(process.env.SIMKL_CLIENT_ID || "").trim();
  if (!SIMKL_CLIENT_ID_PATTERN.test(clientId)) {
    throw serverSetupError();
  }
  return clientId;
}

function validateRedirectUri(redirectUri) {
  try {
    const url = new URL(redirectUri);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error();
    }
  } catch {
    throw serverSetupError();
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return { payload: {}, text: "" };
  }
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { payload: {}, text };
  }
}

function tokenExchangeError(response, payload, text) {
  const detail = payload.error_description
    || payload.message
    || payload.error
    || cleanResponseText(text)
    || response.statusText
    || "Simkl did not return a readable error body.";
  return {
    error: payload.error || "simkl_token_exchange_failed",
    error_description: `Simkl token exchange failed with HTTP ${response.status}: ${detail}.`,
  };
}

function serverSetupError() {
  const error = new Error("Simkl sign-in is not configured on this server.");
  error.status = 503;
  error.publicMessage = "Simkl sign-in is not configured on this server yet. The site owner needs to configure the bridge OAuth app server-side; users should only have to press Connect Simkl.";
  return error;
}

function rememberOauthState(state) {
  cleanupOauthStates();
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
}

function consumeOauthState(state) {
  cleanupOauthStates();
  if (!state || !oauthStates.has(state)) {
    return false;
  }
  oauthStates.delete(state);
  return true;
}

function cleanupOauthStates() {
  const now = Date.now();
  for (const [state, expiresAt] of oauthStates.entries()) {
    if (expiresAt <= now) {
      oauthStates.delete(state);
    }
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function html(response, content) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(content);
}
