// scripts/create-test-user.mjs
//
// Erzeugt (idempotent) einen Test-User in einem Keycloak-Realm (z. B. vw-baev)
// mit verimi-id (UUID) und sub (UUID). Zum Testen/Entwickeln.
//
// Aufruf:
//   KC_URL=http://localhost:8082 \
//   KC_ADMIN_USER=kc-admin KC_ADMIN_PASS_FILE=./secrets/admin_password \
//   node scripts/create-test-user.mjs
//
// Optional per Env:
//   REALM=vw-baev            (Default: vw-baev)
//   USERNAME=testuser        (Default: testuser-<random>)
//   VERIMI_ID=<uuid>         (Default: generiert)
//   SUB=<uuid>               (Default: generiert)
//   DELETE=1                 (loescht den User statt anzulegen)
//
// ACHTUNG: Nur fuer Dev/Test. In Prod NICHT verwenden — echte Nutzer entstehen
// ueber Identitaetsnachweis/Onboarding. Vor Go-Live diese Datei loeschen.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const KC_URL = process.env.KC_URL || 'http://localhost:8082';
const KC_ADMIN_USER = process.env.KC_ADMIN_USER || null;
const KC_ADMIN_PASS = process.env.KC_ADMIN_PASS_FILE
  ? readFileSync(process.env.KC_ADMIN_PASS_FILE, 'utf8').replace(/\r?\n$/, '')
  : process.env.KC_ADMIN_PASS || null;
const REALM = process.env.REALM || 'vw-baev';
const USERNAME = process.env.USERNAME || `testuser-${randomUUID().slice(0, 8)}`;
const VERIMI_ID = process.env.VERIMI_ID || randomUUID();
const SUB = process.env.SUB || randomUUID();
const DELETE = process.env.DELETE === '1';

if (!KC_ADMIN_USER || !KC_ADMIN_PASS) {
  console.error('KC_ADMIN_USER / KC_ADMIN_PASS (oder _FILE) fehlen');
  process.exit(1);
}

async function api(method, path, token, body) {
  const res = await fetch(`${KC_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, json };
}

async function bootstrapToken() {
  const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: KC_ADMIN_USER, password: KC_ADMIN_PASS }),
  });
  if (!res.ok) throw new Error(`Bootstrap-Token fehlgeschlagen (${res.status})`);
  return (await res.json()).access_token;
}

const token = await bootstrapToken();

// User suchen (by username = verimi_id, wie im Realm-Template)
const found = await api('GET', `/admin/realms/${REALM}/users?username=${encodeURIComponent(VERIMI_ID)}&exact=true`, token);
const existing = found.json?.[0];

if (DELETE) {
  if (!existing) { console.log(`User mit verimi_id=${VERIMI_ID} nicht gefunden — nichts zu tun.`); process.exit(0); }
  await api('DELETE', `/admin/realms/${REALM}/users/${existing.id}`, token);
  console.log(`Geloescht: ${REALM}/${existing.id}`);
  process.exit(0);
}

const payload = {
  username: VERIMI_ID,
  enabled: true,
  firstName: null,
  lastName: null,
  email: null,
  attributes: { verifi_id: [VERIMI_ID], sub: [SUB] },
};

if (existing) {
  await api('PUT', `/admin/realms/${REALM}/users/${existing.id}`, token, { ...existing, ...payload });
  console.log(`Aktualisiert: ${REALM}/${existing.id} (verifi_id=${VERIMI_ID}, sub=${SUB})`);
} else {
  await api('POST', `/admin/realms/${REALM}/users`, token, payload);
  console.log(`Angelegt: ${REALM} username=${VERIMI_ID} (verifi_id=${VERIMI_ID}, sub=${SUB})`);
}
console.log(`Login-Username in Keycloak = verimi_id = ${VERIMI_ID}`);
"