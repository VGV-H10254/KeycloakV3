# Externer Service-Account `lambda-admin` (AWS Lambda & Co.)

Stand: 2026-11-09 · gilt für `TENANT_ENV=prod`

## 1. Warum ein eigener Client

| Client | Zweck | Secret | Rollen |
|---|---|---|---|
| `vw-baev` | Portal-Frontend (OIDC, public) | **keins** | – |
| `portal-admin` | Portal-**Backend**, Identity des Portals | `secrets/admin_client_secret` | `view-users`, `query-users`, `manage-users`, `impersonation` |
| `realm-setup` | Provisionierung (master) | `secrets/setup_client_secret` | `create-realm` + Realm-Admin |
| **`lambda-admin`** | externe Konsumenten (Lambda) | **eigenes Secret je Mandant** | `view-users`, `query-users` (Default) |

`portal-admin` darf **nicht** von außen mitbenutzt werden: der Client hält in Prod
`impersonation` (Registrierungs-Pfad). Ein Leak dieses Secrets erlaubt die Übernahme
**jeder** User-Session im Realm. `lambda-admin` hat bewusst **kein** `impersonation`.

## 2. Client-Steckbrief

| Eigenschaft | Wert | Begründung |
|---|---|---|
| `clientId` | `lambda-admin` | ein Client je Realm (Isolationsgrenze = Realm) |
| `publicClient` | `false` | `client_credentials` nur für confidential Clients |
| `serviceAccountsEnabled` | `true` | maschineller Token-Flow ohne User |
| `standardFlowEnabled` | `false` | kein Browser-Login über diesen Client |
| `implicitFlowEnabled` | `false` | deprecated Flow |
| `directAccessGrantsEnabled` | `false` | kein Password-Grant |
| `access.token.lifespan` | `300` s | geleaktes Token ist nach 5 min wertlos |
| Rollen | `view-users`, `query-users` | Least Privilege; erweiterbar pro Mandant |

Provisioniert in `keycloak/realm-template.mjs` (Block „Externer Service-Account-Client").
**Opt-in:** existiert kein Secret, wird der Client nicht angelegt.

### Rollen erweitern

In `keycloak/tenants.json` beim Mandanten:

```json
{ "id": "vw-baev", "lambdaRoles": ["view-users", "query-users", "manage-users"] }
```

Erlaubt: `view-users`, `query-users`, `manage-users`, `view-realm`.
`impersonation` wird beim Setup mit Fehler abgelehnt.

## 3. Secrets

Ablage: `./secrets/lambda/lambda_client_secret_<tenant-id>` (0400, gitignored).
Der Setup-Container sieht **nur** dieses Verzeichnis (`./secrets/lambda:/run/lambda-secrets:ro`),
nicht `db_password`/`admin_password`.

```bash
# auf dem VPS, als root (jq optional):
sudo env DOCKER_USER=vps-prod ./scripts/create-secrets.sh
# ohne jq:
sudo env DOCKER_USER=vps-prod LAMBDA_TENANTS='vw-baev apvn vw-ltkt' ./scripts/create-secrets.sh
```

Danach Client anlegen/aktualisieren:

```bash
docker compose --env-file .env.prod --profile setup run --rm keycloak-setup
# Log: "[vw-baev] client lambda-admin Rollen: view-users, query-users"
```

### Rotation

| Schritt | Aktion |
|---|---|
| 1 | neues Secret erzeugen (`openssl rand -hex 32` → Datei ersetzen) |
| 2 | `setup`-Profil erneut ausführen |
| 3 | Lambda-Env/Secrets-Manager aktualisieren, neu deployen |

Achtung: Weicht das Secret ab, löscht `ensureClient` den Client und legt ihn neu an
(neuer Service-Account-User, Rollen werden im gleichen Lauf neu zugewiesen).
Alte Tokens bleiben maximal `access.token.lifespan` (300 s) gültig.

## 4. Netzwerk & Firewall (der eigentliche Stolperstein)

| Endpoint | Host | Erreichbar für |
|---|---|---|
| Token + Realm-Endpoints | `kc.gateway-vw.de:8443` | Internet (nur `/realms/<tenant>/…`, `/resources/`) |
| **Admin-REST-API** | `kc-admin.gateway-vw.de:8444` | **nur** Provider-Firewall-Allowlist |

Der Public-Vhost liefert für alles außerhalb der Realm-Locations **404**
(`infra/nginx/generated/tenants.conf`, `location / { return 404; }`). Ein
`/admin/realms/...`-Call gegen `:8443` schlägt daher fehl — auch mit gültigem Token.

**nginx kann nicht filtern.** Bei Rootless Docker sieht nginx für jeden Client
`172.30.0.1`; `allow`/`deny` in `admin.conf.template` sind deshalb auskommentiert
und würden bei Aktivierung *alle* Clients gleich behandeln. Die Zugriffskontrolle
liegt in der Provider-Firewall auf Port `8444`.

**Lambda braucht eine statische Egress-IP**, sonst ist keine Allowlist möglich:

| Option | Aufwand | Bewertung |
|---|---|---|
| Lambda in VPC + NAT Gateway mit Elastic IP | ~35 USD/Monat | **empfohlen** |
| API Gateway als Proxy mit fester IP | hoch | nur bei vielen Konsumenten |
| Port 8444 öffentlich öffnen | – | **nein** |

Firewall-Regel (Provider-Panel, nicht nginx):

```
TCP 8444  ← <EIP>/32        # Lambda-Egress
TCP 8444  ← <MGMT_CIDR>     # Admin-Konsole
TCP 8444  ← DENY ALL
```

## 5. Lambda: minimales Beispiel

```js
const KC_ADMIN_URL  = process.env.KC_ADMIN_URL;      // https://kc-admin.gateway-vw.de:8444
const KC_REALM      = "vw-baev";
const CLIENT_ID     = "lambda-admin";
const CLIENT_SECRET = await getSecretFromSecretsManager(); // NICHT hardcoden

let cache = { token: null, exp: 0 };

async function getToken() {
  if (cache.token && Date.now() < cache.exp - 30_000) return cache.token;

  const res = await fetch(
    `${KC_ADMIN_URL}/realms/${KC_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) throw new Error(`KC token ${res.status}`);
  const data = await res.json();
  cache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cache.token;
}
```

Regeln:
- Admin-Calls **immer** gegen `KC_ADMIN_URL`, nie gegen den Public-Vhost.
- Secret aus Secrets Manager/SSM, nicht im Code oder in Env-Klartext im Repo.
- Token cachen: sonst ein Token-Request pro Invoke (Cold-Start-Latenz + Last).

## 6. Verifikation

```bash
# 1. Client existiert und ist confidential
docker exec keycloak-prod-keycloak-1-1 bash -c '
  export HOME=/tmp; K=/opt/keycloak/bin/kcadm.sh; C=/tmp/kcadm.config
  "$K" config credentials --config "$C" --server http://localhost:8080 \
    --realm master --user kc-admin --password "$(cat /run/secrets/admin_password)" >/dev/null
  "$K" get clients -r vw-baev -q clientId=lambda-admin --config "$C" \
    --fields clientId,publicClient,serviceAccountsEnabled
'

# 2. Token-Flow (von einer allowlisteten IP).
#    Achtung: die Secret-Datei ist 0400 und gehoert der gemappten Container-UID,
#    vps-prod kann sie NICHT lesen -> sudo, oder Wert aus dem Secrets Manager.
curl -s -o /dev/null -w "%{http_code}\n" \
  -d grant_type=client_credentials -d client_id=lambda-admin \
  -d client_secret="$(sudo cat secrets/lambda/lambda_client_secret_vw-baev)" \
  https://kc-admin.gateway-vw.de:8444/realms/vw-baev/protocol/openid-connect/token
# erwartet: 200
```

| Symptom | Ursache |
|---|---|
| `401 unauthorized_client` | falscher Client (public) oder Secret falsch |
| `404` | Public-Vhost statt Admin-Vhost benutzt |
| Timeout | Egress-IP nicht in der Firewall-Allowlist |

## 7. Offene Punkte

- [ ] PKCE (`pkce.code.challenge.method=S256`) für die 9 Tenant-Clients in
      `keycloak-config/*.json` nachziehen (public Clients ohne PKCE).
- [ ] Pro-Mandant `clientSecret` für `portal-admin` setzen (aktuell teilen alle
      9 Realms `secrets/admin_client_secret`).
- [ ] Test-Secrets (`test-*`) vor Go-Live durch `openssl rand -hex 32` ersetzen.
- [ ] `impersonation` aus `portal-admin` entfernen, sobald der Registrierungspfad
      ohne Impersonation auskommt.
