/**
 * Public enrollment-page simulator (Node 24).
 *
 * This does not create a passkey. WebAuthn can run only in the user's browser
 * on the Keycloak origin. It also does not call impersonation: those session
 * cookies are returned to the Admin API caller and never reach this browser.
 *
 * The HTTP server bootstrap from the Lambda template is kept. The static
 * redirect page is not: a fixed Keycloak host is not an authorization request,
 * and a URL injected into JavaScript is an open redirect.
 */
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_BODY = 1024;
const COOKIE_TTL_S = 300;

// The prod stack does not create passkey-prototyp or vw-baev-mock.
// vw-baev is the only test target. Env vars cannot retarget it.
const TEST = {
  realm: "vw-baev",
  issuer: "https://kc.gateway-vw.de:8443/realms/vw-baev",
  clientId: "portal-mock",
  redirectUri: "https://vw-baev.de/api/auth/kc/callback",
};

function listenAddress() {
  const raw = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
  if (!raw) return { host: "127.0.0.1", port: 3000 };
  if (raw.includes("://")) {
    throw new Error("AWS_LAMBDA_HTTP_ENDPOINT must be host:port, not a URL");
  }
  const cut = raw.lastIndexOf(":");
  const port = Number(raw.slice(cut + 1));
  if (cut < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AWS_LAMBDA_HTTP_ENDPOINT must be host:port");
  }
  return { host: raw.slice(0, cut), port };
}

function oidcConfig() {
  const issuer = process.env.KC_ISSUER || TEST.issuer;
  const redirectUri = process.env.REDIRECT_URI || TEST.redirectUri;
  const clientId = process.env.KC_CLIENT_ID || TEST.clientId;
  if (issuer !== TEST.issuer || redirectUri !== TEST.redirectUri || clientId !== TEST.clientId) {
    return null;
  }
  const issuerUrl = new URL(issuer);
  if (!issuerUrl.pathname.endsWith("/")) issuerUrl.pathname += "/";
  const authUrl = new URL("protocol/openid-connect/auth", issuerUrl);
  return {
    realm: TEST.realm,
    clientId,
    redirectUri,
    authUrl: authUrl.toString(),
    origin: authUrl.origin,
  };
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]
  ));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || "").split(";")) {
    const cut = part.indexOf("=");
    if (cut < 1) continue;
    out.set(part.slice(0, cut).trim(), part.slice(cut + 1).trim());
  }
  return out;
}

function hostCookie(name, value) {
  return `__Host-${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_TTL_S}`;
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f4f4f9; }
    .container { max-width: 36rem; text-align: left; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,.1); }
    button { padding: 12px 24px; font-size: 16px; color: white; background: #0070f3; border: 0; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0051a2; }
    code { font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

function send(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...extraHeaders,
  });
  res.end(html);
}

function home() {
  const config = oidcConfig();
  const button = config
    ? `<form method="post" action="/start"><button type="submit">Start ${escapeHtml(config.realm)} login</button></form>`
    : `<p>Start is disabled. This simulator accepts only realm <code>${escapeHtml(TEST.realm)}</code>, client <code>${escapeHtml(TEST.clientId)}</code>, and the registered redirect URI.</p>`;
  return page("Enrollment simulation", `
    <h2>Test realm: ${escapeHtml(TEST.realm)}</h2>
    <p>This page does not create a passkey and does not call impersonation. Keycloak must create the browser session itself.</p>
    <p>Client <code>${escapeHtml(TEST.clientId)}</code> is passkey-only. An unknown user stops at the passkey prompt. The code returns to the registered portal callback, not to this page.</p>
    ${button}
  `);
}

function startResponse(config) {
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const fields = {
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const html = page("Continue to Keycloak", `
    <h2>Continue in the browser</h2>
    <p>This POST contains the normal authorization fields only. It will not enroll a passkey for an unknown user. That is the expected result until a Keycloak enrollment authenticator exists.</p>
    <form method="post" action="${escapeHtml(config.authUrl)}">
      ${inputs}
      <button type="submit">Continue to Keycloak</button>
    </form>
  `);
  return {
    html,
    headers: {
      "set-cookie": [hostCookie("oidc-state", state), hostCookie("pkce", verifier)],
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action ${config.origin}`,
    },
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function callbackPage(req) {
  const url = new URL(req.url, "https://localhost");
  const cookies = parseCookies(req.headers.cookie);
  const state = url.searchParams.get("state") || "";
  const expected = cookies.get("__Host-oidc-state") || "";
  const codePresent = url.searchParams.has("code");
  const error = url.searchParams.get("error");
  if (!state || !expected || !safeEqual(state, expected)) {
    return { status: 400, html: page("Rejected", "<h2>State check failed</h2><p>The callback was not started by this browser.</p>") };
  }
  const detail = error
    ? `<p>Keycloak returned <code>${escapeHtml(error)}</code>. No passkey was created.</p>`
    : `<p>Authorization code present: <strong>${codePresent ? "yes" : "no"}</strong>. This function does not exchange it and does not log it.</p>`;
  return {
    status: 200,
    html: page("Callback", `<h2>Portal callback</h2>${detail}<p>Code exchange belongs in a private function with <code>client_secret_basic</code>.</p>`),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "https://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      send(res, 200, home());
      return;
    }
    if (req.method === "POST" && (url.pathname === "/impersonate" || url.pathname === "/start")) {
      const body = await readBody(req);
      if (url.pathname === "/impersonate" || /impersonat/i.test(body) || url.searchParams.has("impersonate")) {
        send(res, 403, page("Rejected", "<h2>Impersonation is disabled</h2><p>It cannot create a browser session for an unregistered user.</p>"));
        return;
      }
      const config = oidcConfig();
      if (!config) {
        send(res, 409, page("Rejected", `<h2>Target rejected</h2><p>Only realm <code>${escapeHtml(TEST.realm)}</code> with client <code>${escapeHtml(TEST.clientId)}</code> is allowed.</p>`));
        return;
      }
      const started = startResponse(config);
      send(res, 200, started.html, started.headers);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/auth/kc/callback") {
      const result = callbackPage(req);
      send(res, result.status, result.html, {
        "set-cookie": [hostCookie("oidc-state", ""), hostCookie("pkce", "")].map((cookie) => cookie.replace(`Max-Age=${COOKIE_TTL_S}`, "Max-Age=0")),
      });
      return;
    }
    send(res, 404, page("Not found", "<h2>Not found</h2>"));
  } catch (err) {
    const status = err.status || 500;
    send(res, status, page("Error", "<h2>Request rejected</h2>"));
  }
});

const address = listenAddress();
server.listen(address.port, address.host);
