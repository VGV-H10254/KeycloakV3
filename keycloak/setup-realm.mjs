import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { ensureRealm } from './realm-template.mjs';

const KC_URL = process.env.KC_URL || 'http://localhost:8082';
const KC_ADMIN_USER = process.env.KC_ADMIN_USER || 'admin';
const KC_ADMIN_PASS = process.env.KC_ADMIN_PASS || 'admin';
const CLIENT_SECRET = process.env.KC_ADMIN_CLIENT_SECRET || 'dev-portal-admin-secret';
const USER_FILE =
  process.env.USER_FILE || fileURLToPath(new URL('../shared/users.json', import.meta.url));
const TENANTS_FILE =
  process.env.TENANTS_FILE || fileURLToPath(new URL('./tenants.json', import.meta.url));

const SEL = process.env.TENANT || process.env.REALM || 'passkey-prototyp';

async function main() {
  let tenant = {
    id: 'kundenportal',
    realm: process.env.REALM || 'passkey-prototyp',
    displayName: process.env.DISPLAY_NAME || 'Kundenportal',
    loginTheme: process.env.LOGIN_THEME || 'kundenportal',
    rpEntityName: 'Kundenportal Passkey-Prototyp',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:8080',
  };

  if (existsSync(TENANTS_FILE)) {
    try {
      const all = JSON.parse(readFileSync(TENANTS_FILE, 'utf8')).tenants || [];
      const match = all.find((t) => t.id === SEL || t.realm === SEL);
      if (match) tenant = match;
    } catch (err) {
      console.warn(`[setup-realm] tenants.json nicht lesbar (${err.message}) — nutze Defaults.`);
    }
  }

  const users = JSON.parse(readFileSync(USER_FILE, 'utf8')).list;
  const stage = tenant.stage || 'dev';

  console.log(`[setup-realm] Realm "${tenant.realm}" (Theme: ${tenant.loginTheme}, ${tenant.publicBaseUrl})`);
  await ensureRealm({
    realm: tenant.realm,
    displayName: tenant.displayName,
    loginTheme: tenant.loginTheme,
    rpEntityName: tenant.rpEntityName || `${tenant.displayName} Passkey`,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || tenant.publicBaseUrl,
    keycloakBaseUrl: tenant.keycloakBaseUrl || tenant.publicBaseUrl,
    webAuthnRpId: tenant.webAuthnRpId || 'localhost',
    stage,
    clientSecret: CLIENT_SECRET,
    // Demo-User ausschließlich in Dev-Realms.
    users: stage === 'prod' ? [] : users,
    kcUrl: KC_URL,
    adminUser: KC_ADMIN_USER,
    adminPass: KC_ADMIN_PASS,
  });

  console.log('---');
  console.log('Setup abgeschlossen.');
  // Kein Passwort ins Log.
  console.log(`  Admin-Konsole: ${KC_URL}/admin`);
  console.log(`  Account/Passkeys: ${KC_URL}/realms/${tenant.realm}/account`);
}

main().catch((err) => {
  console.error('Setup fehlgeschlagen:', err.message);
  process.exit(1);
});
