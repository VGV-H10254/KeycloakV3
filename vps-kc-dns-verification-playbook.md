# VPS Verification Playbook: `kc.gateway-vw.de`

## Zweck

Dieses Playbook prüft, ob der DNS-Eintrag und die laufende IONOS-VPS-Konfiguration für Keycloak korrekt funktionieren.

Das lokale Projekt dient als Soll-Konfiguration. Entscheidend ist die tatsächlich laufende Konfiguration auf dem VPS.

> Hinweis: Der korrekte Hostname ist `kc.gateway-vw.de`, nicht `ks.gateway-vw.de`.

## 1. DNS prüfen

Auf dem VPS oder auf dem lokalen Rechner:

```bash
curl -s \
  'https://dns.google/resolve?name=kc.gateway-vw.de&type=A'
```

Mit `jq`:

```bash
curl -s \
  'https://dns.google/resolve?name=kc.gateway-vw.de&type=A' |
  jq '{Status, Answer}'
```

Erwartet wird:

```json
{
  "Status": 0,
  "Answer": [
    {
      "name": "kc.gateway-vw.de.",
      "type": 1,
      "data": "DEINE_OEFFENTLICHE_VPS_IPV4"
    }
  ]
}
```

Auch IPv6 prüfen:

```bash
curl -s \
  'https://dns.google/resolve?name=kc.gateway-vw.de&type=AAAA' |
  jq '{Status, Answer}'
```

### DNS-Statuswerte

| Status | Bedeutung |
|---:|---|
| `0` mit `Answer` | DNS-Eintrag wurde erfolgreich aufgelöst |
| `0` ohne `Answer` | Kein passender A-Record vorhanden |
| `2` | DNS-Serverfehler (`SERVFAIL`) |
| `3` | Hostname nicht vorhanden (`NXDOMAIN`) |

## 2. Docker-Portmapping auf dem VPS prüfen

```bash
cd ~/KeycloakV2

docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Erwartet wird für den Proxy ungefähr:

```text
keycloak-prod-proxy-1   ...   0.0.0.0:8443->443/tcp, [::]:8443->443/tcp
```

Die Keycloak-Container dürfen keine öffentlichen Host-Portzuordnungen besitzen. Ein Eintrag wie `8080/tcp` ist intern und unkritisch. Problematisch wären Einträge wie:

```text
0.0.0.0:8080->8080/tcp
0.0.0.0:9000->9000/tcp
0.0.0.0:5432->5432/tcp
```

Gezielt prüfen:

```bash
docker port "$(docker compose --env-file .env.prod ps -q proxy)"
```

Erwartet:

```text
443/tcp -> 0.0.0.0:8443
443/tcp -> [::]:8443
```

## 3. Nginx-Konfiguration prüfen

```bash
docker exec keycloak-prod-proxy-1 nginx -t
```

Erwartet:

```text
syntax is ok
test is successful
```

Hostnamen und Zertifikatspfade prüfen:

```bash
docker exec keycloak-prod-proxy-1 nginx -T 2>&1 |
  grep -nE 'server_name|listen 443|kc.gateway-vw.de|ssl_certificate'
```

Erwartet werden unter anderem:

```nginx
listen 443 ssl;
server_name kc.gateway-vw.de;
```

und Zertifikatspfade wie:

```nginx
ssl_certificate /etc/nginx/certs/kc.gateway-vw.de/fullchain.pem;
ssl_certificate_key /etc/nginx/certs/kc.gateway-vw.de/privkey.pem;
```

## 4. Lokalen Test mit korrektem SNI durchführen

Nicht nur mit `https://127.0.0.1:8443` testen. Dadurch wird der falsche SNI-Name `127.0.0.1` verwendet.

```bash
curl -vk \
  --resolve kc.gateway-vw.de:8443:127.0.0.1 \
  'https://kc.gateway-vw.de:8443/'
```

OIDC Discovery testen:

```bash
curl -vk \
  --resolve kc.gateway-vw.de:8443:127.0.0.1 \
  'https://kc.gateway-vw.de:8443/realms/vw-baev/.well-known/openid-configuration'
```

Issuer auslesen:

```bash
curl -sk \
  --resolve kc.gateway-vw.de:8443:127.0.0.1 \
  'https://kc.gateway-vw.de:8443/realms/vw-baev/.well-known/openid-configuration' |
  jq -r '.issuer'
```

Erwartet:

```text
https://kc.gateway-vw.de:8443/realms/vw-baev
```

## 5. Zertifikat prüfen

```bash
openssl s_client \
  -connect 127.0.0.1:8443 \
  -servername kc.gateway-vw.de </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates
```

Prüfen:

- Der Hostname `kc.gateway-vw.de` ist enthalten.
- Das Zertifikat ist nicht abgelaufen.
- Die Zertifizierungsstelle ist öffentlich vertrauenswürdig.
- Das Zertifikat ist nicht selbstsigniert.

SANs anzeigen:

```bash
openssl s_client \
  -connect 127.0.0.1:8443 \
  -servername kc.gateway-vw.de </dev/null 2>/dev/null |
  openssl x509 -noout -text |
  grep -A1 'Subject Alternative Name'
```

## 6. Von außerhalb des VPS testen

Auf dem Windows-Rechner:

```bash
curl -v \
  'https://kc.gateway-vw.de:8443/realms/vw-baev/.well-known/openid-configuration'
```

Kein `-k` verwenden. So wird die Zertifikatsprüfung aktiviert.

Unter PowerShell:

```powershell
Test-NetConnection kc.gateway-vw.de -Port 8443
```

Erwartet:

```text
TcpTestSucceeded : True
```

Wenn der lokale Test funktioniert, der externe aber nicht, sind typische Ursachen:

- DNS zeigt auf die falsche IP.
- TCP `8443` ist in der IONOS-Firewall nicht freigegeben.
- Eine Host-Firewall blockiert den Port.
- Ein AAAA-Record zeigt auf einen nicht erreichbaren IPv6-Endpunkt.
- Der VPS ist nur lokal erreichbar.

## 7. Soll-/Ist-Vergleich mit dem Projekt

Auf dem VPS:

```bash
grep -nE 'KC_PUBLIC_HOSTNAME|KC_PUBLIC_PORT|KC_ADMIN_HOSTNAME|KC_PROXY_TRUSTED_ADDRESSES|MGMT_CIDR' .env.prod
```

Erwartete Werte sind sinngemäß:

```dotenv
KC_PUBLIC_HOSTNAME=kc.gateway-vw.de
KC_PUBLIC_PORT=8443
KC_PROXY_TRUSTED_ADDRESSES=172.30.0.10/32
```

Die Compose-Datei sollte sinngemäß enthalten:

```yaml
proxy:
  ports:
    - "${KC_PUBLIC_PORT:-8443}:443"
```

Keycloak und PostgreSQL dürfen keine öffentlichen `ports:`-Einträge besitzen.

## 8. Erfolgsbedingungen

Die Einrichtung ist grundsätzlich korrekt, wenn:

- DNS auf die öffentliche VPS-IP zeigt.
- TCP `8443` extern erreichbar ist.
- Nginx auf Host-Port `8443` lauscht.
- Nginx `server_name kc.gateway-vw.de` geladen hat.
- `nginx -t` erfolgreich ist.
- Das Zertifikat öffentlich vertrauenswürdig ist und den Hostnamen enthält.
- OIDC Discovery HTTP `200` liefert.
- Der Issuer `https://kc.gateway-vw.de:8443/...` verwendet.
- Keycloak und PostgreSQL nicht direkt veröffentlicht sind.
- `/realms/master` und `/admin` über den Tenant-Host nicht öffentlich erreichbar sind.

## 9. Empfohlene Ausgaben für die weitere Analyse

Diese Ausgaben können ohne Secrets gepostet werden:

```bash
curl -s 'https://dns.google/resolve?name=kc.gateway-vw.de&type=A'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker port "$(docker compose --env-file .env.prod ps -q proxy)"
docker exec keycloak-prod-proxy-1 nginx -t
docker exec keycloak-prod-proxy-1 nginx -T 2>&1 | grep -nE 'server_name|kc.gateway-vw.de|ssl_certificate'
curl -sk --resolve kc.gateway-vw.de:8443:127.0.0.1 \
  'https://kc.gateway-vw.de:8443/realms/vw-baev/.well-known/openid-configuration'
```

Nicht posten:

- `.env.prod`
- Docker-Secret-Dateien
- private Schlüssel
- Client-Secrets
- Admin-Passwörter

NetworkIP
Samsung:
80.153.9.1

`https://kc-admin.gateway-vw.de:8443/admin/master/console/`
`https://kc-admin.gateway-vw.de:8443/realms/master/protocol/openid-connect/auth/`
``