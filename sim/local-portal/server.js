/**
 * Local mock portal for the vw-baev slice.
 *
 * It must be reached as https://vw-baev.de. That is the redirect URI registered
 * on portal-bootstrap. It does not call Keycloak Admin and it does not call
 * impersonation. The browser is sent to portal-bootstrap. The Lambda is
 * reached only through IAM InvokeFunction.
 *
 * Required environment:
 *   AWS_REGION
 *   ENROLLMENT_FUNCTION_NAME
 *   TLS_CERT_FILE
 *   TLS_KEY_FILE
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const REALM = "vw-baev";
const CLIENT_ID = "portal-bootstrap";
const ISSUER = "https://kc.gateway-vw.de:8443/realms/vw-baev";
const REDIRECT_URI = "https://vw-baev.de/api/auth/kc/callback";
const PORTAL_HOST = "vw-baev.de";
const VERIFI_ID = /^[a-f0-9]{16,64}$/;
const COOKIE_TTL_S = 300;

const sessions = new Map();
const lambda = new LambdaClient({ region: required("AWS_REGION") });
const functionName = required("ENROLLMENT_FUNCTION_NAME");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]
  ));
}

function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || "").split(";")) {
    const cut = part.indexOf("=");
    if (cut < 1) continue;
    out.set(part.slice(0, cut).trim(), decodeURIComponent(part.slice(cut + 1).trim()));
  }
  return out;
}

function hostCookie(name, value, maxAge = COOKIE_TTL_S) {
  return `__Host-${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearCookie(name) {
  return hostCookie(name, "", 0);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
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
    .container { max-width: 40rem; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,.1); }
    button { padding: 12px 24px; font-size: 16px; color: white; background: #0070f3; border: 0; border-radius: 4px; cursor: pointer; }
    input { width: 100%; padding: 8px; margin: 8px 0 16px; box-sizing: border-box; }
    code { font-size: 0.95em; word-break: break-all; }
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
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": extraHeaders["content-security-policy"] || "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
  if (extraHeaders["set-cookie"]) headers["set-cookie"] = extraHeaders["set-cookie"];
  if (extraHeaders.location) headers.location = extraHeaders.location;
  res.writeHead(status, headers);
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function formValues(body) {
  return new URLSearchParams(body);
}

function sessionFrom(req) {
  const cookies = parseCookies(req.headers.cookie);
  const id = cookies.get("__Host-portal");
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function newSession(verifiId) {
  const id = b64url(randomBytes(32));
  const session = {
    id,
    verifiId,
    csrf: b64url(randomBytes(32)),
    expiresAt: Date.now() + COOKIE_TTL_S * 1000,
  };
  sessions.set(id, session);
  return session;
}

async function invokeLambda(action, verifiId) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({ action, verifiId })),
  }));
  if (response.FunctionError) throw Object.assign(new Error("lambda failed"), { status: 502 });
  const payload = JSON.parse(Buffer.from(response.Payload || "{}").toString("utf8"));
  if (!payload.ok) throw Object.assign(new Error("lambda rejected"), { status: 502 });
  return payload;
}

function loginPage(csrf) {
  return page("Verimi mock", `
    <h2>Sign in with Verimi</h2>
    <p>This is a local mock. It creates a portal session only. It does not call Verimi or Keycloak.</p>
    <form method="post" action="/login">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label for="verifi">Verimi subject, 16 to 64 lowercase hex characters. Leave empty to generate one.</label>
      <input id="verifi" name="verifiId" autocomplete="off" spellcheck="false">
      <button type="submit">Continue</button>
    </form>
  `);
}

function homePage(session) {
  return page("Portal", `
    <h2>vw-baev mock portal</h2>
    <p>Signed in through the Verimi mock. Subject <code>${escapeHtml(session.verifiId)}</code>.</p>
    <p>The button invokes the private Lambda. The passkey is created afterwards on the Keycloak host, not by the Lambda.</p>
    <form method="post" action="/enroll">
      <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
      <button type="submit">Passkey einrichten</button>
    </form>
    <form method="post" action="/logout">
      <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
      <button type="submit">Sign out</button>
    </form>
  `);
}

function enrollPage(session, password) {
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  session.oidc = { state, nonce, verifier, expiresAt: Date.now() + COOKIE_TTL_S * 1000 };
  const fields = {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
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
  return {
    html: page("One-time password", `
      <h2>Type this password on the Keycloak page</h2>
      <p>It is shown once. It is not your portal password. Refreshing this page creates another one.</p>
      <p><code>${escapeHtml(password)}</code></p>
      <form method="post" action="${escapeHtml(ISSUER)}/protocol/openid-connect/auth">
        ${inputs}
        <button type="submit">Continue to Keycloak</button>
      </form>
    `),
    cookies: [hostCookie("oidc-state", state), hostCookie("pkce", verifier)],
  };
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const tokenResponse = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (tokenResponse.status !== 200) throw Object.assign(new Error("token rejected"), { status: 502 });
  const token = await tokenResponse.json();
  if (!token.access_token) throw Object.assign(new Error("token rejected"), { status: 502 });
  const infoResponse = await fetch(`${ISSUER}/protocol/openid-connect/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (infoResponse.status !== 200) throw Object.assign(new Error("userinfo rejected"), { status: 502 });
  return infoResponse.json();
}

function checkCsrf(session, form) {
  return session && safeEqual(session.csrf, form.get("csrf") || "");
}

const server = createHttpsServer({
  cert: readFileSync(required("TLS_CERT_FILE")),
  key: readFileSync(required("TLS_KEY_FILE")),
}, async (req, res) => {
  const host = String(req.headers.host || "").split(":")[0];
  if (host !== PORTAL_HOST) {
    send(res, 404, page("Not found", "<h2>Not found</h2>"));
    return;
  }
  const url = new URL(req.url || "/", `https://${PORTAL_HOST}`);
  try {
    if (/impersonat/i.test(url.pathname) || url.searchParams.has("impersonate")) {
      send(res, 403, page("Rejected", "<h2>Impersonation is disabled</h2>"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      const session = sessionFrom(req);
      if (!session) {
        const csrf = b64url(randomBytes(32));
        send(res, 200, loginPage(csrf), { "set-cookie": hostCookie("login-csrf", csrf) });
        return;
      }
      send(res, 200, homePage(session));
      return;
    }

    if (req.method === "POST" && url.pathname === "/login") {
      const cookies = parseCookies(req.headers.cookie);
      const form = formValues(await readBody(req));
      if (!safeEqual(cookies.get("__Host-login-csrf") || "", form.get("csrf") || "")) {
        send(res, 403, page("Rejected", "<h2>Login was not started by this browser</h2>"));
        return;
      }
      const entered = form.get("verifiId") || "";
      const verifiId = entered ? entered.trim().toLowerCase() : randomBytes(16).toString("hex");
      if (!VERIFI_ID.test(verifiId)) {
        send(res, 400, page("Rejected", "<h2>The Verimi subject must be 16 to 64 lowercase hex characters</h2>"));
        return;
      }
      const session = newSession(verifiId);
      send(res, 303, "", {
        "set-cookie": [hostCookie("portal", session.id), clearCookie("login-csrf")],
        location: "/",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/enroll") {
      const session = sessionFrom(req);
      const form = formValues(await readBody(req));
      if (!checkCsrf(session, form)) {
        send(res, 403, page("Rejected", "<h2>Portal session missing</h2>"));
        return;
      }
      const result = await invokeLambda("enroll", session.verifiId);
      if (result.alreadyEnrolled) {
        send(res, 200, page("Already enrolled", `<h2>This subject already has a passkey</h2><p>Subject <code>${escapeHtml(session.verifiId)}</code>. No new password was created.</p>`));
        return;
      }
      if (!result.password || !result.userId) throw Object.assign(new Error("lambda rejected"), { status: 502 });
      session.kcUserId = result.userId;
      const started = enrollPage(session, result.password);
      send(res, 200, started.html, {
        "set-cookie": started.cookies,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action https://kc.gateway-vw.de:8443",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/kc/callback") {
      const session = sessionFrom(req);
      const cookies = parseCookies(req.headers.cookie);
      const state = url.searchParams.get("state") || "";
      const expected = cookies.get("__Host-oidc-state") || "";
      const clear = { "set-cookie": [clearCookie("oidc-state"), clearCookie("pkce")] };
      if (!session?.oidc || !state || !expected || !safeEqual(state, expected) || !safeEqual(state, session.oidc.state)) {
        send(res, 400, page("Rejected", "<h2>State check failed</h2>"), clear);
        return;
      }
      if (url.searchParams.get("error")) {
        send(res, 400, page("Rejected", "<h2>Keycloak did not complete enrollment</h2>"), clear);
        return;
      }
      const code = url.searchParams.get("code") || "";
      const verifier = cookies.get("__Host-pkce") || "";
      if (!code || !safeEqual(verifier, session.oidc.verifier)) {
        send(res, 400, page("Rejected", "<h2>Authorization code missing</h2>"), clear);
        return;
      }
      const info = await exchangeCode(code, verifier);
      if (info.preferred_username !== session.verifiId || !info.sub) {
        send(res, 403, page("Rejected", "<h2>The Keycloak subject did not match this portal session</h2>"), clear);
        return;
      }
      session.kcUserId = info.sub;
      session.oidc = null;
      try {
        await invokeLambda("complete", session.verifiId);
      } catch {
        send(res, 502, page("Password still present", `
          <h2>The passkey step returned, but the password was not removed</h2>
          <p>Keycloak sub <code>${escapeHtml(info.sub)}</code></p>
          <form method="post" action="/complete">
            <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
            <button type="submit">Remove the one-time password</button>
          </form>
        `), clear);
        return;
      }
      send(res, 200, page("Passkey created", `
        <h2>Enrollment finished</h2>
        <p>Verimi subject <code>${escapeHtml(session.verifiId)}</code></p>
        <p>Keycloak sub <code>${escapeHtml(info.sub)}</code></p>
        <p>The one-time password has been removed. The passkey stays on this device.</p>
      `), clear);
      return;
    }

    if (req.method === "POST" && url.pathname === "/complete") {
      const session = sessionFrom(req);
      const form = formValues(await readBody(req));
      if (!checkCsrf(session, form) || !session.kcUserId) {
        send(res, 403, page("Rejected", "<h2>Portal session missing</h2>"));
        return;
      }
      await invokeLambda("complete", session.verifiId);
      send(res, 200, page("Passkey created", `
        <h2>Enrollment finished</h2>
        <p>Verimi subject <code>${escapeHtml(session.verifiId)}</code></p>
        <p>Keycloak sub <code>${escapeHtml(session.kcUserId)}</code></p>
        <p>The one-time password has been removed.</p>
      `));
      return;
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      const session = sessionFrom(req);
      const form = formValues(await readBody(req));
      if (session && checkCsrf(session, form)) sessions.delete(session.id);
      send(res, 303, "", {
        "set-cookie": [clearCookie("portal"), clearCookie("oidc-state"), clearCookie("pkce")],
        location: "/",
      });
      return;
    }

    send(res, 404, page("Not found", "<h2>Not found</h2>"));
  } catch (err) {
    send(res, err.status || 500, page("Error", "<h2>The enrollment step failed</h2><p>No password or token is shown.</p>"));
  }
});

server.listen(8443, "127.0.0.1");
