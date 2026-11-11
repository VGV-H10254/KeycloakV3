// Helfer für scripts/retire-bootstrap-admin.sh. Läuft im keycloak-setup-Container
// (Netz 'kc', Secret setup_client_secret), gestartet vom Shell-Skript.
//
// Eingabe über stdin, eine Zeile pro Wert (Werte gehen NICHT über Kommandozeile):
//   1. Name des neuen Admins
//   2. Passwort des neuen Admins
//   3. OTP-Code (leer, wenn kein Code nötig)
//   4. Name des Bootstrap-Admins (aus KC_ADMIN_USER)
//
// Ablauf: nur wenn ALLE Prüfungen bestehen, wird der Bootstrap-Admin gelöscht.
// Umgebung: KC_URL, DRY_RUN=1 (nur prüfen, nichts löschen), KC_SETUP_CLIENT_ID.

import { readFileSync } from 'node:fs';

const KC = process.env.KC_URL || 'http://keycloak-1:8080';
const DRY_RUN = process.env.DRY_RUN === '1';
const SETUP_CLIENT_ID = process.env.KC_SETUP_CLIENT_ID || 'realm-setup';
const SETUP_SECRET_FILE = '/run/secrets/setup_client_secret';

// Achtung: Keine Werte in Logs ausgeben. Fehlermeldungen beschreiben nur den Schritt.
const [namedUser = '', namedPass = '', totp = '', bootUser = ''] = readFileSync(0, 'utf8')
  .split('\n')
  .map((s) => s.replace(/\r$/, ''));

const fail = (msg) => {
  console.error(`[retire] FEHLER: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`[retire] OK: ${msg}`);

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

async function api(method, path, token) {
  const res = await fetch(`${KC}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: parse(await res.text()) };
}

async function setupToken() {
  let secret;
  try {
    secret = readFileSync(SETUP_SECRET_FILE, 'utf8').trim();
  } catch {
    return null;
  }
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SETUP_CLIENT_ID,
      client_secret: secret,
    }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token || null;
}

async function passwordToken(user, pass, otp) {
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: user,
    password: pass,
  });
  if (otp) params.set('totp', otp);
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) return null;
  return (await res.json()).access_token || null;
}

const userByName = async (token, name) => {
  const r = await api('GET', `/admin/realms/master/users?username=${encodeURIComponent(name)}&exact=true`, token);
  return Array.isArray(r.json) ? r.json[0] || null : null;
};

async function main() {
  if (!namedUser || !namedPass) fail('Name oder Passwort des neuen Admins fehlt.');
  if (!bootUser) fail('Name des Bootstrap-Admins fehlt (KC_ADMIN_USER in .env.prod).');
  if (namedUser === bootUser) fail('Der neue Admin darf nicht derselbe Benutzer wie der Bootstrap-Admin sein.');

  // 1. Setup-Client muss funktionieren, sonst wären künftige Deploys ohne Admin kaputt.
  const setupBefore = await setupToken();
  if (!setupBefore) fail('Setup-Client liefert kein Token. Abbruch, bevor etwas verändert wird.');
  ok('Setup-Client: Token erhältlich');

  // 2. Login des neuen Admins (inkl. OTP, falls aktiv).
  const token = await passwordToken(namedUser, namedPass, totp);
  if (!token) fail('Login des neuen Admins fehlgeschlagen (Name, Passwort oder OTP prüfen).');
  ok(`Login als '${namedUser}': erfolgreich`);

  // 3. Benutzer aktiv und Admin-Rolle im master-Realm direkt zugewiesen.
  const named = await userByName(token, namedUser);
  if (!named) fail(`Benutzer '${namedUser}' im master-Realm nicht gefunden.`);
  if (!named.enabled) fail(`Benutzer '${namedUser}' ist deaktiviert.`);

  const roles = await api('GET', `/admin/realms/master/users/${named.id}/role-mappings/realm`, token);
  if (!Array.isArray(roles.json) || !roles.json.some((r) => r.name === 'admin')) {
    fail(`'${namedUser}' hat die Rolle 'admin' im master-Realm nicht direkt zugewiesen.`);
  }
  ok(`'${namedUser}': Rolle 'admin' vorhanden`);

  // 4. MFA muss hinterlegt sein. Ohne zweiten Faktor wäre der Admin genauso verwundbar
  //    wie der Bootstrap-Admin mit dem Passwort allein.
  const creds = await api('GET', `/admin/realms/master/users/${named.id}/credentials`, token);
  const mfa = Array.isArray(creds.json)
    && creds.json.some((c) => ['otp', 'webauthn', 'webauthn-passwordless'].includes(c.type));
  if (!mfa) fail(`'${namedUser}' hat kein MFA-Credential (OTP oder WebAuthn). Erst einrichten.`);
  ok(`'${namedUser}': MFA-Credential hinterlegt`);

  // 5. Bootstrap-Admin suchen.
  const boot = await userByName(token, bootUser);
  if (!boot) {
    ok(`Bootstrap-Admin '${bootUser}' existiert nicht mehr. Nichts zu löschen.`);
    return;
  }
  if (boot.id === named.id) fail('Bootstrap-Admin und neuer Admin sind dieselbe Benutzer-ID.');

  if (DRY_RUN) {
    ok(`DRY-RUN: alle Prüfungen bestanden. '${bootUser}' würde jetzt gelöscht. Nichts verändert.`);
    return;
  }

  // 6. Löschen und nachprüfen.
  const del = await api('DELETE', `/admin/realms/master/users/${boot.id}`, token);
  if (del.status !== 204) fail(`Löschen von '${bootUser}' fehlgeschlagen (HTTP ${del.status}).`);
  ok(`Bootstrap-Admin '${bootUser}' gelöscht`);

  if (await userByName(token, bootUser)) fail(`Nachprüfung: '${bootUser}' existiert noch.`);

  const setupAfter = await setupToken();
  if (!setupAfter) fail('Nach dem Löschen liefert der Setup-Client kein Token. Sofort prüfen!');
  ok('Nachprüfung: Setup-Client funktioniert weiterhin');
}

main().catch((err) => fail(`unerwarteter Fehler: ${err.message}`));
