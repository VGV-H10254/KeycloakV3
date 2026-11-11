#!/usr/bin/env node
/**
 * Erzeugt die mandantenspezifischen nginx-Konfigurationen aus dem Tenant-Register.
 *
 * Quelle:  keycloak/tenants.json   (nur stage='prod', ohne 'paused')
 * Ziel:    infra/nginx/generated/tenants.conf
 *
 * Warum generiert und nicht handgeschrieben: Host, Realm und RP-ID stehen im
 * Tenant-Register (Single Source of Truth). Eine zweite, abweichende Liste im nginx-
 * Config wäre genau die Art Drift, die das Register verhindern soll.
 *
 * Hosts: Mehrere Mandanten dürfen denselben Keycloak-Host teilen (z. B. kc.gateway-vw.de).
 * Je Host entsteht EIN Server-Block mit exakten Realm-Locations für alle Mandanten dieses
 * Hosts. Fremde Realms (und /realms/master) bleiben dadurch unerreichbar.
 *
 * Aufruf (vor `docker compose up -d`):
 *   node infra/nginx/generate-nginx.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { selectTenants, isMockEnabled, readEnvFile, hostOf } from '../../keycloak/tenant-scope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TENANTS_FILE = process.env.TENANTS_FILE || path.join(REPO, 'keycloak', 'tenants.json');
const OUT_DIR = path.join(HERE, 'generated');
const OUT_FILE = path.join(OUT_DIR, 'tenants.conf');

/**
 * Mock-Mandanten (stage='mock') nur, wenn KC_ENABLE_MOCK_TENANTS gesetzt ist.
 * Der Schalter kommt aus der Env-Datei (Standard: .env.prod) — dieselbe Quelle
 * wie im Compose-Stack, damit vhost und Realm immer zusammenpassen.
 */
const ENV_FILE = process.env.ENV_FILE || path.join(REPO, '.env.prod');
const envVars = readEnvFile(ENV_FILE);
// Öffentlicher HTTPS-Port des Mandanten-Vhosts (Container 443 → Host-Port).
// Wird in jedem server-Block als $kc_public_port gesetzt; kc-proxy.conf nutzt ihn
// für X-Forwarded-Port, damit der Admin-Vhost (Port 8444) nicht fälschlich 8443 meldet.
const PUBLIC_PORT = String(
  process.env.KC_PUBLIC_PORT ?? envVars.KC_PUBLIC_PORT ?? '8443'
);
const MOCK_ENABLED = isMockEnabled(
  process.env.KC_ENABLE_MOCK_TENANTS ?? envVars.KC_ENABLE_MOCK_TENANTS
);

// Keycloak-Only-Modus: kein Portal, kein IDV-Anbieter auf diesem Proxy.
// Aktivierung: --keycloak-only oder KEYCLOAK_ONLY=1. Erzeugt tenants.conf
// ohne Portal-Upstreams und ohne Portal-location-Block.
const KEYCLOAK_ONLY =
  process.argv.includes('--keycloak-only') ||
  ['1', 'true', 'yes', 'on'].includes(
    String(process.env.KEYCLOAK_ONLY ?? '').toLowerCase()
  );

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const all = JSON.parse(readFileSync(TENANTS_FILE, 'utf8')).tenants;
const tenants = selectTenants(all, { env: 'prod', mock: MOCK_ENABLED });

if (tenants.length === 0) {
  throw new Error(`Keine aktiven Prod-Mandanten (stage='prod', nicht 'paused') in ${TENANTS_FILE}`);
}

// Gruppierung: ein Server-Block je Host.
const byHost = new Map();
for (const t of tenants) {
  const host = hostOf(t);
  if (!host) throw new Error(`Mandant '${t.id}': keycloakBaseUrl ist keine gültige URL`);
  if (!byHost.has(host)) byHost.set(host, []);
  byHost.get(host).push(t);
}

// Im Voll-Stack bekommt jeder Host genau ein Portal. Teilen sich Mandanten einen Host,
// wäre nicht klar, welches Portal auf '/' antwortet — dann abbrechen statt raten.
if (!KEYCLOAK_ONLY) {
  for (const [host, list] of byHost) {
    if (list.length > 1) {
      throw new Error(
        `Host ${host} wird von ${list.length} Mandanten geteilt. Im Voll-Stack ist das ` +
          `nicht erlaubt (ein Portal pro Host). Nur mit --keycloak-only / KEYCLOAK_ONLY=1.`
      );
    }
  }
}

// Upstreams je Mandant (nur Voll-Stack).
const upstreams = KEYCLOAK_ONLY
  ? []
  : tenants.map((t) => {
      const upstream = `portal_${sanitize(t.id)}`;
      return `upstream ${upstream} {\n    server portal-${t.id}:3000;\n    keepalive 32;\n}`;
    });

// Server-Blöcke je Host.
const servers = [...byHost].map(([host, list]) => {
  const realmLocations = [...new Set(list.map((t) => t.realm))]
    .map(
      (realm) => `    # Realm '${realm}'
    location = /realms/${realm} {
        limit_req zone=kc_requests burst=30 nodelay;
        proxy_pass http://keycloak;
        include /etc/nginx/snippets/kc-proxy.conf;
    }

    location ^~ /realms/${realm}/ {
        limit_req zone=kc_requests burst=30 nodelay;
        proxy_pass http://keycloak;
        include /etc/nginx/snippets/kc-proxy.conf;
    }
`
    )
    .join('\n');

  const portalBlock = KEYCLOAK_ONLY
    ? `    # Portal wird extern betrieben (nicht über diesen Proxy).\n    # Pfade außerhalb der Keycloak-Locations: 404.\n    location / { return 404; }`
    : `    # Portal\n    location / {\n        proxy_pass http://portal_${sanitize(list[0].id)};\n        include /etc/nginx/snippets/portal-proxy.conf;\n    }`;

  const tenantLines = list
    .map((t) => `# - ${t.displayName} (${t.id}) — Realm '${t.realm}', RP-ID '${t.webAuthnRpId}'`)
    .join('\n');

  return `
# ---------------------------------------------------------------------------
# Keycloak-Host: ${host}
${tenantLines}
# ---------------------------------------------------------------------------

server {
    listen 443 ssl;
    http2 on;
    server_name ${host};

    # Öffentlicher Port für X-Forwarded-Port (kc-proxy.conf). Container lauscht auf 443,
    # nach außen ist es KC_PUBLIC_PORT (rootless Docker kann <1024 nicht veröffentlichen).
    set $kc_public_port ${PUBLIC_PORT};

    ssl_certificate     /etc/nginx/certs/${host}/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/${host}/privkey.pem;

    # Sicherheits-Header: http-Ebene (snippets/security-headers.conf, include in
    # nginx.conf) — gilt für alle Vhosts. Bewusst kein add_header hier: ein eigenes
    # add_header im server-Block würde alle geerbten Header verwerfen.

    client_max_body_size 2m;

    # Keycloak: ausschließlich die Realms der hier aufgelisteten Mandanten.
    # Exakte Locations, daher kein fremdes Realm und kein /realms/master.
${realmLocations}
    # Theme-Ressourcen (Login-Seiten)
    location ^~ /resources/ {
        proxy_pass http://keycloak;
        include /etc/nginx/snippets/kc-proxy.conf;
    }

${portalBlock}
}`;
});

const header = `# GENERIERT von infra/nginx/generate-nginx.mjs — nicht von Hand ändern.
# Quelle: keycloak/tenants.json (stage='prod'${MOCK_ENABLED ? " + stage='mock'" : ''}, ohne 'paused'), Stand ${new Date().toISOString()}
# Modus: ${KEYCLOAK_ONLY ? 'Keycloak-Only (keine Portal-Upstreams)' : 'Voll-Stack (Portal + Keycloak)'}
#
# Enthält: je Keycloak-Host einen Server-Block mit exakten Realm-Locations${KEYCLOAK_ONLY ? '' : ', Portal-Upstreams'}.
# Kein HTTP-Server-Block: ausschließlich HTTPS auf dem öffentlichen Port (KC_PUBLIC_PORT, Standard 8443).
# Der Admin-Host liegt in conf.d/admin.conf (aus dem nginx-Template gerendert).
`;

mkdirSync(OUT_DIR, { recursive: true });
const upstreamBlock = upstreams.length ? `${upstreams.join('\n\n')}\n` : '';
writeFileSync(OUT_FILE, `${header}\n${upstreamBlock}${servers.join('\n')}\n`, 'utf8');

console.log(`[generate-nginx] ${tenants.length} Mandant(en) auf ${byHost.size} Host(s) → ${OUT_FILE}`);
console.log(`[generate-nginx] Modus: ${KEYCLOAK_ONLY ? 'Keycloak-Only' : 'Voll-Stack'}`);
console.log(
  `[generate-nginx] Mock-Mandanten: ${MOCK_ENABLED ? 'aktiv' : 'aus'}` +
    ` (KC_ENABLE_MOCK_TENANTS in ${ENV_FILE})`
);
for (const [host, list] of byHost) {
  for (const t of list) {
    console.log(`  ${t.id.padEnd(30)} host=${host.padEnd(28)} realm=${t.realm}`);
  }
}
