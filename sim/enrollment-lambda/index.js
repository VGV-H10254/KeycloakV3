/**
 * Enrollment Lambda for the vw-baev vertical slice.
 *
 * Invoke with IAM only. Do not add a Function URL or an unauthenticated route.
 * The event is the invoke payload, not an API Gateway event.
 *
 *   { "action": "enroll", "verifiId": "<16-64 lowercase hex>" }
 *   { "action": "complete", "verifiId": "<same id>" }
 *
 * Token call:  https://kc.gateway-vw.de:8443
 * Admin call:  https://kc-admin.gateway-vw.de:8443
 * The public host is never used for /admin. Impersonation is not implemented.
 *
 * Runtime: Node.js 20.x or 22.x. Handler: index.handler
 * Environment: KC_ADMIN_CLIENT_SECRET (portal-admin). No other secret.
 */

const REALM = "vw-baev";
const CLIENT_ID = "portal-admin";
const PUBLIC_BASE = "https://kc.gateway-vw.de:8443";
const ADMIN_BASE = "https://kc-admin.gateway-vw.de:8443";
const VERIFI_ID = /^[a-f0-9]{16,64}$/;
const PASSKEY_ACTION = "webauthn-register-passwordless";
const { randomInt } = require("node:crypto");
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz2345679";

exports.handler = async (event) => {
  const command = readCommand(event);
  if (!command) return reject("rejected");
  const secret = process.env.KC_ADMIN_CLIENT_SECRET;
  if (!secret) return reject("not_configured");

  try {
    const token = await clientCredentials(secret);
    if (command.action === "enroll") return await enroll(token, command.verifiId);
    return await complete(token, command.verifiId);
  } catch (err) {
    console.log(JSON.stringify({ action: command.action, error: err.code || "failed", status: err.status || 0 }));
    return reject(err.code || "failed");
  }
};

function readCommand(event) {
  if (!event || typeof event !== "object" || typeof event.body === "string" || event.requestContext || event.rawPath) {
    return null;
  }
  if ((event.action !== "enroll" && event.action !== "complete") || !VERIFI_ID.test(event.verifiId || "")) {
    return null;
  }
  return { action: event.action, verifiId: event.verifiId };
}

function reject(error) {
  return { ok: false, error };
}

async function clientCredentials(secret) {
  const basic = Buffer.from(`${CLIENT_ID}:${secret}`, "utf8").toString("base64");
  const response = await fetch(`${PUBLIC_BASE}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (response.status !== 200) throw coded("token_rejected", response.status);
  const body = await response.json();
  if (!body.access_token || body.token_type !== "Bearer") throw coded("token_rejected", response.status);
  return body.access_token;
}

async function enroll(token, verifiId) {
  let user = await findUser(token, verifiId);
  if (!user) {
    await createUser(token, verifiId);
    user = await findUser(token, verifiId);
  }
  if (!user?.id) throw coded("user_missing", 404);

  const credentials = await listCredentials(token, user.id);
  if (credentials.some((item) => item.type === "webauthn-passwordless")) {
    return { ok: true, alreadyEnrolled: true, userId: user.id };
  }

  await putPasskeyAction(token, user);
  const password = newPassword(verifiId);
  await resetPassword(token, user.id, password);
  const after = await getUser(token, user.id);
  if ((after.requiredActions || []).includes("UPDATE_PASSWORD") || !(after.requiredActions || []).includes(PASSKEY_ACTION)) {
    throw coded("action_rejected", 409);
  }
  return { ok: true, alreadyEnrolled: false, userId: user.id, password };
}

async function complete(token, verifiId) {
  const user = await findUser(token, verifiId);
  if (!user?.id) throw coded("user_missing", 404);
  const credentials = await listCredentials(token, user.id);
  for (const item of credentials) {
    if (item.type === "password" && item.id) await deleteCredential(token, user.id, item.id);
  }
  return { ok: true, userId: user.id, passwordRemoved: true };
}

async function findUser(token, verifiId) {
  const listed = await adminSend(
    token,
    "GET",
    `/admin/realms/${REALM}/users?username=${encodeURIComponent(verifiId)}&exact=true`,
  );
  if (!Array.isArray(listed.body)) throw coded("user_lookup_rejected", listed.status);
  return listed.body.length === 1 ? listed.body[0] : null;
}

async function createUser(token, verifiId) {
  const created = await adminSend(token, "POST", `/admin/realms/${REALM}/users`, {
    username: verifiId,
    enabled: true,
    attributes: { verifi_id: [verifiId] },
    requiredActions: [PASSKEY_ACTION],
  });
  if (created.status !== 201) throw coded("user_create_rejected", created.status);
}

async function getUser(token, id) {
  const got = await adminSend(token, "GET", `/admin/realms/${REALM}/users/${encodeURIComponent(id)}`);
  if (got.status !== 200 || !got.body?.id) throw coded("user_lookup_rejected", got.status);
  return got.body;
}

async function putPasskeyAction(token, user) {
  const updated = await adminSend(token, "PUT", `/admin/realms/${REALM}/users/${encodeURIComponent(user.id)}`, {
    id: user.id,
    username: user.username,
    enabled: true,
    attributes: { ...(user.attributes || {}), verifi_id: [user.username] },
    requiredActions: [PASSKEY_ACTION],
  });
  if (updated.status !== 204) throw coded("action_rejected", updated.status);
}

async function resetPassword(token, id, password) {
  const reset = await adminSend(token, "PUT", `/admin/realms/${REALM}/users/${encodeURIComponent(id)}/reset-password`, {
    type: "password",
    value: password,
    temporary: false,
  });
  if (reset.status !== 204) throw coded("password_rejected", reset.status);
}

async function listCredentials(token, id) {
  const listed = await adminSend(token, "GET", `/admin/realms/${REALM}/users/${encodeURIComponent(id)}/credentials`);
  if (!Array.isArray(listed.body)) throw coded("credential_lookup_rejected", listed.status);
  return listed.body;
}

async function deleteCredential(token, userId, credentialId) {
  const deleted = await adminSend(
    token,
    "DELETE",
    `/admin/realms/${REALM}/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
  );
  if (deleted.status !== 204) throw coded("password_remove_rejected", deleted.status);
}

async function adminSend(token, method, path, payload) {
  const response = await fetch(`${ADMIN_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw coded("admin_rejected", response.status);
    }
  }
  return { status: response.status, body };
}

function newPassword(username) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let password = "";
    for (let i = 0; i < 20; i += 1) password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    if (!password.toLowerCase().includes(username.toLowerCase())) return password;
  }
  throw coded("password_rejected", 500);
}

function coded(code, status) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  return err;
}
