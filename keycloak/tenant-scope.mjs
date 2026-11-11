/**
 * Gemeinsame Auswahl-Logik für das Mandanten-Register (keycloak/tenants.json).
 *
 * Das Register ist die einzige Quelle für Host, Realm und RP-ID. Wer einen
 * Mandanten anlegen (setup-realms.mjs), per nginx ausliefern (generate-nginx.mjs),
 * mit Zertifikaten versorgen (gen-local-certs.sh) oder im Health-Check prüfen
 * (check-local-prod.sh) will, MUSS dieselbe Teilmenge bestimmen — sonst
 * entstehen genau die Abweichungen, die das Register verhindern soll.
 *
 * Stufen (Feld 'stage'):
 *   dev   Dev-Stack: Demo-User, 'local'-Overrides (localhost:808x), keine Härtung
 *   prod  Produktiv-Stack: echte Domains, gehärtet, keine Demo-User
 *   mock  Produktiv-Stack, NUR lokal: eigener Host + eigener Realm, gehärtet wie
 *         prod. Existiert nur, wenn KC_ENABLE_MOCK_TENANTS gesetzt ist.
 *
 * Warum ein eigener Realm statt eines zweiten Host-Namens auf demselben Realm:
 *   Die RP-ID (WebAuthn) muss ein registrierbarer Domain-Suffix der Browser-Origin
 *   sein. 'vw-baev.de' ist kein Suffix von 'mock-vw-baev.de' — ein Passkey ließe
 *   sich dort nicht registrieren. Ein eigener Realm löst das sauber: eigener
 *   frontendUrl, eigene RP-ID, eigenes Realm-Attribut. Nebeneffekt: Test-Accounts
 *   und Test-Passkeys landen NICHT im echten Mandanten-Realm.
 */

import { readFileSync } from 'node:fs';

export const STAGE_DEV = 'dev';
export const STAGE_PROD = 'prod';
export const STAGE_MOCK = 'mock';

/** interpreting truthy values for flags: '1', 'true', 'yes', 'on' */
export function isMockEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Mandanten für eine Zielumgebung auswählen.
 *
 * @param {Array} tenants   Register-Einträge
 * @param {object} o
 * @param {string} o.env    'local' (Dev-Stack) | 'prod' (Produktiv-Stack)
 * @param {boolean} o.mock  Mock-Mandanten einbeziehen (nur für 'prod')
 * @param {string|null} o.only  Filter auf id oder realm
 */
export function selectTenants(tenants, { env = 'local', mock = false, only = null } = {}) {
  // 'paused: true' schließt einen Mandanten aus ALLEN Umgebungen aus (Setup und nginx
  // verwenden dieselbe Auswahl). Pausierte Mandanten bleiben im Register erhalten.
  const list = (Array.isArray(tenants) ? tenants : []).filter((t) => t.paused !== true);
  const isProd = String(env).toLowerCase() === 'prod';

  let scoped;
  if (isProd) {
    scoped = list.filter((t) => {
      const stage = t.stage || STAGE_DEV;
      if (stage === STAGE_PROD) return true;
      if (stage === STAGE_MOCK) return mock === true;
      return false;
    });
  } else {
    // Der Dev-Stack läuft auf localhost:808x ohne TLS — Mock-Hosts (https://…) sind
    // dort nicht erreichbar und würden nur einen toten Realm anlegen.
    scoped = list.filter((t) => (t.stage || STAGE_DEV) !== STAGE_MOCK);
  }

  if (only) scoped = scoped.filter((t) => t.id === only || t.realm === only);
  return scoped;
}

/**
 * Minimaler .env-Parser: KEY=WERT, '#'-Kommentare, optionale Anführungszeichen.
 * Liefert {} , wenn die Datei fehlt — der Aufrufer entscheidet dann selbst.
 */
export function readEnvFile(file) {
  const out = {};
  if (!file) return out;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Mandanten-Werte für die Zielumgebung auflösen.
 * Im Dev-Stack gewinnen die 'local'-Overrides (Host/RP-ID zeigen auf localhost),
 * damit die Prod-Mandanten lokal testbar sind. Im Prod-Stack gilt immer der
 * Registerwert.
 */
export function resolveTenant(tenant, env = 'local') {
  const isProd = String(env).toLowerCase() === 'prod';
  return !isProd && tenant.local ? { ...tenant, ...tenant.local } : { ...tenant };
}

/** Host des Mandanten (aus keycloakBaseUrl — das ist der Keycloak-Login-Host). */
export function hostOf(tenant) {
  try {
    return new URL(tenant.keycloakBaseUrl).hostname;
  } catch {
    return null;
  }
}

/** Browser-Origin des Portals (aus publicBaseUrl). */
export function originOf(tenant) {
  try {
    return new URL(tenant.publicBaseUrl).origin;
  } catch {
    return null;
  }
}
