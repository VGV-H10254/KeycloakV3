import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { ensureRealm } from './realm-template.mjs';
import { selectTenants, isMockEnabled, resolveTenant, STAGE_DEV } from './tenant-scope.mjs';

/**
 * Secret lesen: bevorzugt aus Datei (<NAME>_FILE, z. B. /run/secrets/...), sonst aus
 * der Umgebungsvariable <NAME> (nur lokaler Test). Fehlermeldungen enthalten nie den Wert.
 */
function readSecret(envName) {
  const fileVar = `${envName}_FILE`;
  if (process.env[fileVar]) {
    try {
      return readFileSync(process.env[fileVar], 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new Error(`${fileVar} gesetzt, aber nicht lesbar (${err.code || 'Fehler'})`);
    }
  }
  return process.env[envName] || null;
}

const KC_URL = process.env.KC_URL || 'http://localhost:8082';
// Bootstrap-Admin: KEINE Defaults. Wird nur im 'bootstrap'-Profil gesetzt (einmalig).
const KC_ADMIN_USER = process.env.KC_ADMIN_USER || null;
const KC_ADMIN_PASS = readSecret('KC_ADMIN_PASS');
const ADMIN_CLIENT_SECRET = readSecret('KC_ADMIN_CLIENT_SECRET');
const CLIENT_SECRET = ADMIN_CLIENT_SECRET || 'dev-portal-admin-secret';

/**
 * Secret fuer den externen Service-Account-Client 'lambda-admin' - EIN Secret
 * pro Mandant (kein globaler Fallback, sonst haette ein geleaktes Lambda-Secret
 * Zugriff auf alle Realms).
 *
 * Ablage (in dieser Reihenfolge):
 *   1. Env KC_LAMBDA_CLIENT_SECRET_<TENANT-ID-GROSS>[_FILE]  (Einzeltests)
 *   2. <KC_LAMBDA_SECRET_DIR>/lambda_client_secret_<tenant-id>
 *      Default-Verzeichnis /run/lambda-secrets, per Compose aus ./secrets/lambda
 *      gemountet (enthaelt NUR lambda-Secrets, nicht DB-/Admin-Passwoerter).
 *
 * Fehlt beides, wird der Client fuer diesen Mandanten nicht angelegt.
 */
const LAMBDA_SECRET_DIR = process.env.KC_LAMBDA_SECRET_DIR || '/run/lambda-secrets';

function readLambdaSecret(tenantId) {
  const envName = `KC_LAMBDA_CLIENT_SECRET_${tenantId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const fromEnv = readSecret(envName);
  if (fromEnv) return fromEnv;

  const file = `${LAMBDA_SECRET_DIR}/lambda_client_secret_${tenantId}`;
  if (!existsSync(file)) return null;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value || null;
  } catch (err) {
    throw new Error(`lambda-Secret fuer '${tenantId}' nicht lesbar (${err.code || 'Fehler'})`);
  }
}

const USER_FILE =
  process.env.USER_FILE || fileURLToPath(new URL('../shared/users.json', import.meta.url));
const TENANTS_FILE =
  process.env.TENANTS_FILE || fileURLToPath(new URL('./tenants.json', import.meta.url));
/**
 * Verzeichnis mit den mandantenspezifischen Client-Konfigurationen
 * (keycloak-config/<tenant-id>.json). Wird per Partial-Import in den
 * jeweiligen Realm eingespielt — siehe importTenantClient().
 */
const CLIENT_CONFIG_DIR =
  process.env.CLIENT_CONFIG_DIR || fileURLToPath(new URL('../keycloak-config', import.meta.url));

/**
 * Zielumgebung:
 *   local (Default) → alle Mandanten aus dem Register; Prod-Mandanten mit ihren
 *                     'local'-Overrides (Host/RP-ID = localhost, damit lokal testbar).
 *   prod            → nur Mandanten mit stage='prod', mit echten Domains, ohne Overrides
 *                     und ohne Demo-User. Dev-Realms entstehen dadurch in Prod gar nicht.
 */
const TENANT_ENV = String(process.env.TENANT_ENV || 'local').toLowerCase();
const IS_PROD = TENANT_ENV === 'prod';
const ONLY = process.env.TENANT || process.env.REALM || null;

/**
 * Mock-Mandanten (stage='mock') nur im lokalen Test:
 *   KC_ENABLE_MOCK_TENANTS=1 → eigener Host + eigener Realm, damit Test-Accounts
 *   und Test-Passkeys den echten Mandanten-Realm nicht verunreinigen.
 *   Ohne den Schalter entsteht der Mock in einer echten Umgebung gar nicht.
 */
const MOCK_ENABLED = isMockEnabled(process.env.KC_ENABLE_MOCK_TENANTS);

/**
 * Setup-Client (Realm-Provisionierung ohne Passwort):
 *   client_credentials-Token → Rechte 'create-realm' (Master) ⇒ darf Realms anlegen und
 *   erhält laut Keycloak-Doku "full access to any new realm they create" — genug, um
 *   Clients, WebAuthn-Policies, Themes und User des Mandanten zu setzen.
 *   Der Client liegt im Master-Realm, weil die globalen Rollen ('admin', 'create-realm')
 *   dort definiert sind und Rollen realm-scoped im Token landen.
 *   KC_SETUP_REALM kann auf einen eigenen Admin-Realm gesetzt werden, wenn dort ein
 *   gleichnamiger Client existiert.
 */
const SETUP_REALM = process.env.KC_SETUP_REALM || 'master';
const SETUP_CLIENT_ID = process.env.KC_SETUP_CLIENT_ID || 'realm-setup';
const SETUP_CLIENT_SECRET = readSecret('KC_SETUP_CLIENT_SECRET');
/** Admin-Hostname (KC_HOSTNAME_ADMIN). Für den Master-Realm: 'frontendUrl'. */
const ADMIN_HOSTNAME = process.env.KC_ADMIN_HOSTNAME || null;
/** Öffentlicher HTTPS-Port des Nginx-Proxys (rootless Docker, Standard 8443). */
const PUBLIC_PORT = process.env.KC_PUBLIC_PORT || '8443';
const ADMIN_PORT = process.env.KC_ADMIN_PORT || '8444';

if (!['local', 'prod'].includes(TENANT_ENV)) {
  throw new Error(`TENANT_ENV muss 'local' oder 'prod' sein (war: '${TENANT_ENV}')`);
}
// Fail-closed: Mock-Mandanten (Test-User, Test-Passkeys) dürfen in Prod nie entstehen.
if (IS_PROD && MOCK_ENABLED) {
  throw new Error('KC_ENABLE_MOCK_TENANTS=1 ist in TENANT_ENV=prod nicht erlaubt. Variable entfernen.');
}

// ---------------------------------------------------------------- API-Helfer

function makeApi(kcUrl) {
  return async (method, path, token, body) => {
    const res = await fetch(`${kcUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* kein JSON */
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };
}

const api = makeApi(KC_URL);

/** client_credentials-Token für den Setup-Client (ohne Passwort). */
async function setupClientToken() {
  if (!SETUP_CLIENT_SECRET) return null;
  let res;
  try {
    res = await fetch(`${KC_URL}/realms/${SETUP_REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SETUP_CLIENT_ID,
        client_secret: SETUP_CLIENT_SECRET,
      }),
    });
  } catch (err) {
    throw new Error(`Keycloak nicht erreichbar unter ${KC_URL} (${err.message}) — läuft der Stack?`);
  }
  if (!res.ok) return null;
  const json = await res.json();
  return json.access_token || null;
}

/** Bootstrap-Token (admin-cli, Password-Grant) — nur für den einmaligen Aufbau. */
async function bootstrapToken() {
  if (!KC_ADMIN_USER || !KC_ADMIN_PASS) {
    throw new Error(
      'Bootstrap-Admin-Zugangsdaten fehlen (KC_ADMIN_USER/KC_ADMIN_PASS). ' +
        'Nur der einmalige Erststart braucht sie: Service "keycloak-bootstrap" im Profil "bootstrap" nutzen.'
    );
  }
  let res;
  try {
    res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: KC_ADMIN_USER,
        password: KC_ADMIN_PASS,
      }),
    });
  } catch (err) {
    throw new Error(`Keycloak nicht erreichbar unter ${KC_URL} (${err.message}) — läuft der Stack?`);
  }
  if (!res.ok) {
    throw new Error(
      `Bootstrap-Admin-Token fehlgeschlagen (${res.status}). ` +
        `Der Setup-Client ${SETUP_CLIENT_ID} existiert vermutlich noch nicht.`
    );
  }
  return (await res.json()).access_token;
}

/**
 * Setup-Client im Master-Realm sicherstellen (idempotent).
 * Wird nur benötigt, solange der Client noch nicht existiert — danach läuft die
 * Provisionierung ausschließlich mit client_credentials.
 *
 * @param {string} token Bootstrap-Token (admin-cli) — volle Rechte, damit der
 *                         Setup-Client und seine Rollen angelegt werden können.
 */
async function ensureSetupClient(token) {
  const realm = SETUP_REALM;

  const createClient = async () => {
    await api('POST', `/admin/realms/${realm}/clients`, token, {
      clientId: SETUP_CLIENT_ID,
      name: 'Realm-Provisionierung (Setup)',
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      secret: SETUP_CLIENT_SECRET,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      implicitFlowEnabled: false,
      frontchannelLogout: false,
    });
  };

  let clients = await api('GET', `/admin/realms/${realm}/clients?clientId=${SETUP_CLIENT_ID}`, token);
  let client = clients?.[0];
  if (!client) {
    await createClient();
    clients = await api('GET', `/admin/realms/${realm}/clients?clientId=${SETUP_CLIENT_ID}`, token);
    client = clients?.[0];
    console.log(`[setup-realms] Setup-Client '${SETUP_CLIENT_ID}' in Realm '${realm}' angelegt`);
  } else if (SETUP_CLIENT_SECRET) {
    const sec = await api('GET', `/admin/realms/${realm}/clients/${client.id}/client-secret`, token);
    if (sec?.value !== SETUP_CLIENT_SECRET) {
      // Secret weicht ab → Client neu anlegen (der Service-Account-User wechselt mit).
      await api('DELETE', `/admin/realms/${realm}/clients/${client.id}`, token);
      await createClient();
      clients = await api('GET', `/admin/realms/${realm}/clients?clientId=${SETUP_CLIENT_ID}`, token);
      client = clients?.[0];
      console.log(`[setup-realms] Setup-Client '${SETUP_CLIENT_ID}' neu angelegt (Secret geändert)`);
    }
  }
  if (!client) throw new Error(`Setup-Client '${SETUP_CLIENT_ID}' konnte nicht angelegt werden`);

  // Rechte des Service-Account-Users: Realm-Rolle 'create-realm' + Client-Rolle 'view-realm'.
  const sa = await api('GET', `/admin/realms/${realm}/clients/${client.id}/service-account-user`, token);
  if (!sa?.id) throw new Error('Service-Account-User des Setup-Clients nicht abrufbar');

  const realmRoles = await api('GET', `/admin/realms/${realm}/roles`, token);
  const createRealm = (realmRoles || []).find((r) => r.name === 'create-realm');
  if (!createRealm) {
    throw new Error(`Rolle 'create-realm' im Realm '${realm}' nicht gefunden`);
  }
  const assigned = await api(
    'GET',
    `/admin/realms/${realm}/users/${sa.id}/role-mappings/realm`,
    token
  );
  if (!(assigned || []).some((r) => r.name === 'create-realm')) {
    await api('POST', `/admin/realms/${realm}/users/${sa.id}/role-mappings/realm`, token, [
      { id: createRealm.id, name: createRealm.name },
    ]);
    console.log(`[setup-realms] Rolle 'create-realm' an Service-Account vergeben`);
  }

  await ensureAdminClientRoles(token, realm, sa.id);
}

/**
 * Verwaltungs-Rollen des Setup-Clients zuweisen.
 *
 * WICHTIG (Keycloak 26): Im Master-Realm liegen die Admin-Rollen auf dem Client
 * '<realm>-realm' (im Master: 'master-realm') — NICHT auf 'realm-management'
 * (den gibt es im Master-Realm nicht). Siehe RealmManager#checkMasterAdminManagementRoles.
 * In Mandanten-Realms liegt 'manage-realm' dagegen auf 'realm-management'.
 *
 * 'manage-realm' wird für das Setzen der Frontend-URL des Master-Realms
 * gebraucht (ensureMasterFrontendUrl) — ohne sie antwortet die Admin-API mit 403.
 *
 * Hinweis zur Reihenfolge: Diese Funktion läuft mit dem BOOTSTRAP-Token
 * (admin-cli, volle Rechte), NICHT mit dem Setup-Client-Token — der darf
 * Client-Rollen im Master-Realm noch nicht auflisten.
 */
async function ensureAdminClientRoles(bootToken, realm, saId) {
  // Kandidaten: der Master-Admin-Client und — falls vorhanden — 'realm-management'.
  const candidates = [];
  const masterAdminClient = (await api('GET', `/admin/realms/${realm}/clients?clientId=${realm}-realm`, bootToken))?.[0];
  if (masterAdminClient) candidates.push(masterAdminClient);
  const rmClient = (await api('GET', `/admin/realms/${realm}/clients?clientId=realm-management`, bootToken))?.[0];
  if (rmClient) candidates.push(rmClient);

  const needed = ['view-realm', 'manage-realm'];
  const granted = [];

  for (const client of candidates) {
    const clientRoles = await api('GET', `/admin/realms/${realm}/clients/${client.id}/roles`, bootToken);
    const roles = needed
      .map((name) => (clientRoles || []).find((r) => r.name === name))
      .filter(Boolean);
    if (roles.length === 0) continue;

    const assigned = await api(
      'GET',
      `/admin/realms/${realm}/users/${saId}/role-mappings/clients/${client.id}`,
      bootToken
    );
    const assignedNames = new Set((assigned || []).map((r) => r.name));
    const missing = roles.filter((r) => !assignedNames.has(r.name));

    if (missing.length > 0) {
      await api(
        'POST',
        `/admin/realms/${realm}/users/${saId}/role-mappings/clients/${client.id}`,
        bootToken,
        missing.map((r) => ({ id: r.id, name: r.name }))
      );
      granted.push(`${client.clientId}: ${missing.map((r) => r.name).join(', ')}`);
    }
  }

  if (granted.length > 0) {
    console.log(`[setup-realms] Verwaltungs-Rollen an Service-Account vergeben — ${granted.join(' | ')}`);
  }
}

/**
 * Rollen des Setup-Clients im Master-Realm nachziehen.
 *
 * Hintergrund (Keycloak 26):
 *   Beim Anlegen eines Realms legt Keycloak im Master-Realm einen
 *   Admin-Client '<realm>-realm' an und gibt dem ERSTELLER des Realms darauf
 *   alle Verwaltungsrollen — ausser 'impersonation'. Der Setup-Client ist der
 *   Ersteller und darf deshalb Client-Rollen des realm-management vergeben
 *   (manage-users, view-users, query-users, manage-clients).
 *
 *   Für 'impersonation' gilt in Keycloak: wer die Rolle vergeben will, muss
 *   sie selbst besitzen — sonst antwortet die Admin-API mit 403. Deshalb wird
 *   dem Setup-Client 'impersonation' auf dem Master-Client '<realm>-realm'
 *   nachgezogen. Damit ist der Steady State passwortlos: ab dem zweiten Lauf
 *   genügt der client_credentials-Token des Setup-Clients.
 *
 * Wird nur mit dem Bootstrap-Token (admin-cli) ausgeführt — der Setup-Client
 * kann sich die Rolle nicht selbst geben (derselbe Endpunkt).
 *
 * @param {string} bootToken  Bootstrap-Admin-Token
 * @param {string} realm      Realm-Name des Mandanten
 */
async function ensureRealmAdminClientRoles(bootToken, realm) {
  // Die '<realm>-realm'-Clients liegen immer im Master-Realm — dort liegt auch
  // der Setup-Client (Voreinstellung SETUP_REALM='master').
  const masterRealm = 'master';
  const clients = await api(
    'GET',
    `/admin/realms/${masterRealm}/clients?clientId=${realm}-realm`,
    bootToken
  );
  const client = clients?.[0];
  if (!client) return false; // Realm existiert noch nicht (erst nach ensureRealm).

  const setupClients = await api(
    'GET',
    `/admin/realms/${masterRealm}/clients?clientId=${SETUP_CLIENT_ID}`,
    bootToken
  );
  const setupClient = setupClients?.[0];
  if (!setupClient) {
    if (realm) {
      console.log(
        `[setup-realms] Setup-Client '${SETUP_CLIENT_ID}' liegt nicht im Master-Realm — ` +
          `die Vergabe von 'impersonation' an portal-admin braucht dann den Bootstrap-Admin.`
      );
    }
    return false;
  }
  const sa = await api(
    'GET',
    `/admin/realms/${masterRealm}/clients/${setupClient.id}/service-account-user`,
    bootToken
  );
  if (!sa?.id) return false;

  const clientRoles = await api(
    'GET',
    `/admin/realms/${masterRealm}/clients/${client.id}/roles`,
    bootToken
  );
  const impersonation = (clientRoles || []).find((r) => r.name === 'impersonation');
  if (!impersonation) return false;

  const assigned = await api(
    'GET',
    `/admin/realms/${masterRealm}/users/${sa.id}/role-mappings/clients/${client.id}`,
    bootToken
  );
  if ((assigned || []).some((r) => r.name === 'impersonation')) return false;

  await api(
    'POST',
    `/admin/realms/${masterRealm}/users/${sa.id}/role-mappings/clients/${client.id}`,
    bootToken,
    [{ id: impersonation.id, name: impersonation.name }]
  );
  console.log(
    `[setup-realms] Rolle 'impersonation' auf Master-Client '${realm}-realm' an ` +
      `den Setup-Client vergeben (ermöglicht die Vergabe an portal-admin)`
  );
  return true;
}

/**
 * Master-Realm: 'frontendUrl' auf den Admin-Host setzen.
 * Der globale KC_HOSTNAME ist der Fallback für alle Realms ohne eigenes 'frontendUrl'.
 * Für den Master-Realm (Admin-Konsole) muss der Admin-Host gelten, sonst lädt die
 * Konsole ihre Assets vom falschen Host und bricht ab.
 */
async function ensureMasterFrontendUrl(token) {
  if (!ADMIN_HOSTNAME) {
    console.log(
      '[setup-realms] KC_ADMIN_HOSTNAME nicht gesetzt — Frontend-URL des Master-Realms bleibt unverändert'
    );
    return;
  }
  const frontendUrl = `https://${ADMIN_HOSTNAME}:${ADMIN_PORT}`;
  const realm = await api('GET', '/admin/realms/master', token);
  const attributes = { ...(realm.attributes || {}) };
  if (attributes.frontendUrl === frontendUrl) {
    console.log(`[setup-realms] Master-Realm frontendUrl=${frontendUrl} (unverändert)`);
    return;
  }
  attributes.frontendUrl = frontendUrl;
  await api('PUT', '/admin/realms/master', token, { ...realm, attributes });
  console.log(`[setup-realms] Master-Realm frontendUrl=${frontendUrl} gesetzt`);
}

/** Mandanten nach Umgebung einengen — gemeinsame Logik mit generate-nginx.mjs. */
function pickTenants(all) {
  return selectTenants(all, { env: TENANT_ENV, mock: MOCK_ENABLED, only: ONLY });
}

/**
 * Werte eines Mandanten für die Zielumgebung auflösen.
 * In 'local' gewinnen die 'local'-Overrides; das User-Seeding bleibt unberührt
 * (das entscheidet allein stage).
 */
function resolveValues(t) {
  return resolveTenant(t, TENANT_ENV);
}

/**
 * Mandantenspezifische Client-Konfiguration per Partial-Import einspielen.
 *
 * Warum Partial-Import und nicht '--import-realm':
 *   - '--import-realm' erwartet Dateien '<realm>-realm.json' mit einer VOLLEN
 *     Realm-Repräsentation. Die Dateien in keycloak-config/ sind aber
 *     Client-Repräsentationen — der Realm-Bootstrap läuft bereits über die
 *     Admin-API (ensureRealm), ein zweiter Weg wäre redundant.
 *   - '--import-realm' läuft auf BEIDEN Knoten gleichzeitig (Cluster-Race:
 *     beide importieren in dieselbe Datenbank). Der Partial-Import läuft
 *     nur einmal, im Setup-Container.
 *
 * Policy 'OVERWRITE': der gewünschte Zustand ist die Datei — bei jedem Start
 * wird der Client auf den Inhalt der Datei zurückgesetzt. So bleibt der
 * tatsächliche Zustand identisch zu keycloak-config/.
 *
 * Fehlt die Datei für einen Mandanten, wird nichts importiert (kein Fehler) —
 * die Konfiguration ist optional.
 */
async function importTenantClient(tenant, token) {
  const file = `${CLIENT_CONFIG_DIR}/${tenant.id}.json`;
  if (!existsSync(file)) {
    console.log(`[setup-realms] ${tenant.id}: keine Client-Konfiguration — kein Import`);
    return;
  }

  let clientRep;
  try {
    clientRep = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${tenant.id}: Client-Konfiguration ${file} ist kein gültiges JSON — ${err.message}`);
  }
  if (!clientRep?.clientId) {
    throw new Error(`${tenant.id}: Client-Konfiguration ${file} hat kein 'clientId'`);
  }

  // Der Partial-Import arbeitet mit einer PartialImportRepresentation:
  // die Clients liegen unter 'clients'.
  const result = await api(
    'POST',
    `/admin/realms/${tenant.realm}/partialImport`,
    token,
    {
      clients: [clientRep],
      ifResourceExists: 'OVERWRITE',
    }
  );

  const actions = (result?.results || [])
    .map((r) => `${r.resourceType}:${r.resourceName}=${r.action}`)
    .join(', ');
  console.log(
    `[setup-realms] ${tenant.id}: client '${clientRep.clientId}' importiert` +
      (actions ? ` (${actions})` : '')
  );
}

async function main() {
  const all = JSON.parse(readFileSync(TENANTS_FILE, 'utf8')).tenants;
  if (!Array.isArray(all) || all.length === 0) throw new Error(`Keine Mandanten in ${TENANTS_FILE}`);

  const tenants = pickTenants(all);
  if (tenants.length === 0) {
    const where = IS_PROD
      ? `stage='prod'${MOCK_ENABLED ? " (+ 'mock')" : ''}`
      : "allen Stufen (ohne 'mock')";
    throw new Error(
      `Kein Mandant für TENANT_ENV=${TENANT_ENV} (${where}) und Filter ` +
        `'${ONLY ?? '*'}' in ${TENANTS_FILE}`
    );
  }

  // Demo-User nur für Dev-Realms (lokal). In Prod wird users.json NICHT gelesen.
  const users = IS_PROD ? [] : JSON.parse(readFileSync(USER_FILE, 'utf8')).list;

  console.log(
    `[setup-realms] TENANT_ENV=${TENANT_ENV} → ${tenants.length} Mandant(en) ` +
      `(${tenants.map((t) => t.realm).join(', ')}) aus ${TENANTS_FILE}` +
      (ONLY ? ` (Filter: ${ONLY})` : '')
  );

  // Token: bevorzugt client_credentials (ohne Passwort). Fehlt der Setup-Client noch,
  // wird er einmalig mit dem Bootstrap-Admin angelegt.
  let token = await setupClientToken();
  let boot = null;

  if (!token) {
    console.log(
      `[setup-realms] Setup-Client '${SETUP_CLIENT_ID}' liefert noch keinen Token — ` +
        `Bootstrap über admin-cli (KC_ADMIN_USER/KC_ADMIN_PASS)`
    );
    boot = await bootstrapToken();
    await ensureSetupClient(boot);
    token = await setupClientToken();
    if (!token) {
      throw new Error(
        `client_credentials-Token für '${SETUP_CLIENT_ID}' nicht erhältlich — ` +
          `KC_SETUP_CLIENT_SECRET prüfen`
      );
    }
    console.log(`[setup-realms] Setup läuft jetzt über client_credentials (kein Passwort)`);
  } else {
    console.log(`[setup-realms] Authentifizierung: client_credentials (Client '${SETUP_CLIENT_ID}')`);

    // Der Setup-Client existiert schon, seine Verwaltungs-Rollen müssen aber
    // unter Umständen nachgezogen werden (z. B. nach einem Keycloak-Update, das
    // die Rollen des Master-Realms verändert hat). Dafür brauchen wir Rechte auf
    // den Master-Client — der Setup-Token selbst hat sie nicht (403).
    // Der Bootstrap-Admin ist aber nur für den ERSTSTART gedacht; deshalb wird
    // die Nachziehung nur versucht, wenn die Bootstrap-Zugangsdaten gesetzt sind.
    if (KC_ADMIN_USER && KC_ADMIN_PASS) {
      try {
        boot = await bootstrapToken();
        const setupClients = await api('GET', `/admin/realms/${SETUP_REALM}/clients?clientId=${SETUP_CLIENT_ID}`, boot);
        const setupClient = setupClients?.[0];
        if (setupClient) {
          const sa = await api('GET', `/admin/realms/${SETUP_REALM}/clients/${setupClient.id}/service-account-user`, boot);
          if (sa?.id) await ensureAdminClientRoles(boot, SETUP_REALM, sa.id);
        }
      } catch {
        // Bootstrap-Zugangsdaten fehlen oder sind abgelaufen — kein Drama:
        // die Provisionierung läuft ohnehin mit dem Setup-Token weiter.
        console.log(
          `[setup-realms] Bootstrap-Admin nicht verfügbar — ` +
            `Verwaltungs-Rollen des Setup-Clients werden nicht nachgezogen.`
        );
      }
    }
  }

  for (const t of tenants) {
    const v = resolveValues(t);
    const stage = t.stage || 'dev';
    const secret = t.clientSecret || CLIENT_SECRET;
    const lambdaClientSecret = readLambdaSecret(t.id);

    if (IS_PROD && !t.clientSecret && !ADMIN_CLIENT_SECRET) {
      throw new Error(
        `Mandant '${t.id}': kein Client-Secret. In Prod entweder 'clientSecret' im ` +
          `Tenant-Register oder KC_ADMIN_CLIENT_SECRET setzen.`
      );
    }

    // Grant für bestehende Realms nachziehen, BEVOR ensureRealm läuft: dann
    // gelingt die Rollenzuweisung an portal-admin direkt mit dem Setup-Token.
    if (boot) await ensureRealmAdminClientRoles(boot, t.realm);

    await ensureRealm({
      realm: t.realm,
      displayName: t.displayName,
      loginTheme: t.loginTheme,
      rpEntityName: t.rpEntityName || `${t.displayName} Passkey`,
      publicBaseUrl: v.publicBaseUrl,
      keycloakBaseUrl: v.keycloakBaseUrl || v.publicBaseUrl,
      webAuthnRpId: v.webAuthnRpId || 'localhost',
      stage,
      clientSecret: secret,
      // Externer Service-Account fuer AWS Lambda / andere Konsumenten. Ohne Secret
      // (keine Datei unter ./secrets/lambda) wird der Client nicht angelegt.
      lambdaClientSecret,
      lambdaRoles: Array.isArray(t.lambdaRoles) ? t.lambdaRoles : undefined,
      // 'impersonation' für den Registrierungs-Pfad (Standard: an, siehe realm-template.mjs)
      portalImpersonation: t.portalImpersonation ?? true,
      // Demo-User ausschließlich in Dev-Realms (Mock-Realms verhalten sich wie prod).
      users: stage === STAGE_DEV ? users : [],
      token,
      // Bootstrap-Admin als Rückfall für die Rollenzuweisung (siehe realm-template.mjs).
      bootToken: boot,
      kcUrl: KC_URL,
      adminUser: KC_ADMIN_USER,
      adminPass: KC_ADMIN_PASS,
    });

    // Beim ersten Anlegen entsteht der Master-Client '<realm>-realm' erst mit
    // dem Realm — den Grant also danach nachziehen.
    if (boot) await ensureRealmAdminClientRoles(boot, t.realm);

    // Mandantenspezifische Client-Konfiguration (keycloak-config/<tenant-id>.json).
    await importTenantClient(t, token);

    console.log('---');
  }

  console.log(`[setup-realms] Alle ${tenants.length} Realm(e) hergestellt.`);
  // Kein Passwort ins Log: Container-Logs werden zentral gesammelt und gelesen.
  console.log(`  Admin-Konsole: ${KC_URL}/admin`);

  if (IS_PROD) await ensureMasterFrontendUrl(token);
}

main().catch((err) => {
  console.error('[setup-realms] FEHLER:', err.message);
  process.exit(1);
});
