# VPS verification runbook: KeycloakV2 on IONOS (rootless Docker)

- Date: 2026-10-29
- Status: **not yet verifiable**, see section 1
- Scope: deployment correctness, public exposure, configuration, security controls, resilience
- Related: `architecture_10-29-2026.md` (design and read-only checks of 2026-10-29), `security-measures.md` (claimed controls)
- Basis: repository review plus Docker and Keycloak 26.7.5 documentation. No access to the VPS was available, so every VPS result below is still to be measured.

## Rules for every test

- Non-destructive. No real user logins, no client creation, no brute force against production realms.
- Run exposure tests from **outside** the VPS (your PC on mobile data, or a cloud VM). Tests from the VPS itself say nothing about the firewall.
- Placeholders: `<VPS_IPv4>`, `<VPS_IPv6>`, `<MGMT_IP>` (the `MGMT_CIDR` address without `/32`), `<ADMIN_HOST>` (`KC_ADMIN_HOSTNAME`), `<PROJECT_DIR>`.
- Never paste secret values into tickets, chat or logs. All commands below print names, modes, hashes or status codes only.
- Stop at the first FAIL in a phase, fix it, and re-run that phase.

Helpers (set on the VPS in the project directory):

```bash
cd <PROJECT_DIR>
dc() { docker compose --env-file .env.prod "$@"; }
```

Helpers (set on your PC for exposure tests):

```bash
VPS=<VPS_IPv4>
U=https://kc.gateway-vw.de:8443
R="--resolve kc.gateway-vw.de:8443:$VPS"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; echo; }
```

---

## 1. Blockers (fix before the VPS checks mean anything)

| ID | Finding | Evidence | Action |
|---|---|---|---|
| B0 | Repo copy and VPS state disagree. On 2026-10-29 the public endpoint served a self-signed certificate for `kc.gateway-vw.de`, but this folder has no `infra/nginx/certs/kc.gateway-vw.de/`. | `architecture_10-29-2026.md` section 2; `infra/nginx/certs/` listing | Phase 0 decides which copy is authoritative. Deploy nothing before that. |
| B1 | Local test environment with plaintext secrets. Four `.env.prod` copies with secret values exist in three folders: `KeycloakV2/.env.prod`, `C:\dev\test\.env.prod`, `C:\dev\test\.env.prod_261028`, `C:\dev\Vorbereitung vps IONOS\.env - Kopie.prod`. The first file's header says "DIES IST KEINE PROD-KONFIGURATION". | Header of `.env.prod`; key names checked only | On the VPS, create `.env.prod` from `.env.prod.example`. Never copy these files. Rotate DB, bootstrap-admin and client secrets if any copy ever reached a server. Delete the copies after rotation (ask first). |
| B2 | No certificate directories for `kc.gateway-vw.de` or `kc-admin.gateway-vw.de`. `generated/tenants.conf` (line 25) references the first, so nginx cannot start from this copy (`[emerg] cannot load certificate`). | `infra/nginx/certs/` listing vs. `tenants.conf` | Publicly trusted certificates via DNS-01. Only 8443 is reachable, so HTTP-01 (port 80) and TLS-ALPN-01 (port 443) cannot validate. |
| B3 | Public path broken. DNS is NXDOMAIN, TCP 8443 times out, TCP 443 answers with RST, the public certificate is self-signed. | `architecture_10-29-2026.md` section 2 | A record for `kc.gateway-vw.de`. IONOS firewall: allow TCP 8443 over IPv4 and IPv6. Make 443 DROP, not RST. Replace the certificate (B2). |
| B4 | Client IP lost under rootless Docker by default. Published ports do not propagate the source address unless `userland-proxy` is disabled (RootlessKit 3.0 or newer). nginx then sees one NAT address for all clients. | Docker rootless troubleshooting: "Port forwarding with `docker run -p` does not propagate source IP addresses" | Effects: the admin `allow MGMT_CIDR` rule denies the admins (fail closed); `limit_req` at 10 r/s becomes one shared bucket for all portals, so one attacker throttles everyone; Keycloak sees one client address for all logins. Fix in section 6.1, verify in Phase 6. |
| B5 | Secret files are owned by the host operator, but Keycloak runs as container UID 1000. Under rootless Docker container UID n maps to host `subuid_start + n - 1`, so UID 1000 is host `S+999`. `create-secrets.sh` only chowns when run as root. Expected result: `secrets-entrypoint.sh` exits with "FEHLT oder nicht lesbar" and Keycloak restart-loops. | `scripts/create-secrets.sh` lines 37-41; `keycloak/secrets-entrypoint.sh` line 17; Docker UID mapping | Fix in section 6.2, verify in Phase 3. Do not `chmod 0444` as a shortcut. |
| B6 | `docker-cleanup.sh --remove-all` deletes data. It removes every container, then runs `docker volume prune -f`, which deletes the unused named volumes `postgres-data`, `keycloak-data` and `pg-certs`. This happens regardless of whether the stack is up. `--stop` and `--remove` stop or remove every container on the host (outage). | `C:\dev\test\docker-cleanup.sh`, function `remove_all` | Never copy it to the VPS and never run it there. Take a backup before any maintenance. |
| B7 | The hardening runbook tests the wrong host. Steps 5-7 of `anweisung_nginx_hardening_10-27-2026.md` use `vw-baev.de`, the AWS-hosted portal domain. The results would be false, not a pass. | `C:\dev\Vorbereitung vps IONOS\anweisung_nginx_hardening_10-27-2026.md` | Use `kc.gateway-vw.de` with `--resolve` (done in this runbook). |

---

## 2. Expected exposure (what the tests must prove)

```text
                          Internet
   Portals (AWS Lambda, changing egress IPs)     Admins (<MGMT_IP> only)
          |  TCP 8443, IPv4 + IPv6                  |  TCP 8443, SNI <ADMIN_HOST>
          v                                         v
+---------- IONOS VPS: IONOS firewall + host firewall (deny, allow 8443) ----------+
|                                                                                  |
|  rootlesskit listener :8443   (userland-proxy off, client IP preserved)          |
|        |                                                                         |
|        v                                                                         |
|  [proxy] nginx 172.30.0.10:443     <- the only published container               |
|     kc.gateway-vw.de : exact realm locations, limit_req 10 r/s burst 30          |
|                        no /admin, /health, /metrics, /realms/master              |
|     <ADMIN_HOST>     : allow MGMT_CIDR, deny all                                 |
|        |                                                                         |
|        +--------------------------+                                               |
|        v                          v                                               |
|  [keycloak-1] 172.30.0.4    [keycloak-2] 172.30.0.3    :8080 internal only       |
|     :9000 health and metrics, never proxied                                      |
|        +--------------------------+  JDBC sslmode=verify-full                     |
|                                   v                                               |
|                       [postgres] :5432  (no host port, hostssl only)            |
|                                                                                  |
+----------------------------------------------------------------------------------+
SSH :22 from <MGMT_IP> only. All other inbound traffic dropped.
```

Expected reachable from the internet: TCP 8443 only.
Expected reachable from `<MGMT_IP>`: TCP 22 and the admin host on 8443.
Expected reachable from nowhere: 80, 443, 5432, 8080, 9000.

---

## 3. Verification phases

Run in order. Each phase states what it proves, the commands, and the expected result.

### Phase 0: Source of truth (resolves B0, B1, H4, M1)

Proves the VPS runs exactly the reviewed code.

```bash
# On the VPS
cd <PROJECT_DIR>
find . -type f -print0 | sort -z | xargs -0 sha256sum > ~/manifest-vps.txt

# On your PC (Git Bash), in the reviewed folder
cd /c/dev/test/KeycloakV2
find . -type f -print0 | sort -z | xargs -0 sha256sum > /c/Temp/opencode/manifest-local.txt
# copy ~/manifest-vps.txt to /c/Temp/opencode/manifest-vps.txt, then:
diff /c/Temp/opencode/manifest-local.txt /c/Temp/opencode/manifest-vps.txt
```

Expected differences only: `.env.prod`, `secrets/*`, `infra/nginx/certs/*`, `infra/pg/certs/*`, and `infra/nginx/generated/tenants.conf` if it was regenerated on the VPS. Anything else: stop and investigate.

Must be absent or limited on the VPS:

```bash
test ! -e shared && echo "OK: shared/ absent" || echo "FAIL: shared/ present (7 test users with plaintext passwords)"
find "$HOME" -name 'docker-cleanup.sh' 2>/dev/null | grep . && echo "FAIL: docker-cleanup.sh present" || echo "OK: no docker-cleanup.sh"
test ! -e infra/nginx/certs/_ca && echo "OK: no local CA key" || echo "FAIL: local CA private key on VPS (not needed with public certificates)"
ls infra/nginx/certs/         # production hosts only; no mock-*, admin.example.de, idv.example.de
ls -a | grep -E '^\.env'      # only .env.prod and .env.prod.example
```

### Phase 1: Host and rootless daemon

Proves: non-root operator, a rootless daemon that survives reboot, hardened SSH, correct clock, automatic updates.

```bash
whoami && id -u                                        # operator is NOT root
grep "^$(whoami):" /etc/subuid /etc/subgid             # 65536 entries each; note the start value S
rootlesskit --version                                  # 3.0 or newer (source-IP propagation)
docker info | grep -iE 'rootless|Server Version'       # 'rootless' must appear
systemctl --user is-enabled docker && systemctl --user is-active docker
loginctl show-user "$(whoami)" -p Linger               # Linger=yes: daemon survives logout and reboot
timedatectl show -p NTPSynchronized --value            # yes: TOTP and token expiry depend on the clock
sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '
systemctl is-enabled unattended-upgrades               # enabled
```

Expected: `permitrootlogin no`, `passwordauthentication no`, `Linger=yes`, `NTPSynchronized=yes`.

### Phase 2: Exposure from the internet (resolves B3)

Proves: only 8443 is reachable, over IPv4 and IPv6.

On the VPS:

```bash
sudo ufw status verbose        # default deny incoming; 8443/tcp allowed; 22 limited to <MGMT_IP>
                               # no ufw? use: sudo nft list ruleset
ss -tlnp                       # listeners: 8443 (rootlesskit) and 22 (sshd) only
```

IONOS control panel: the firewall policy attached to the VPS network interface allows TCP 8443 (IPv4 and IPv6) and TCP 22 from `<MGMT_IP>` only, with default drop.

From your PC:

```bash
nmap -Pn -n -p- --open -T4 <VPS_IPv4>      # expect 8443 open; 22 only if your address is <MGMT_IP>
nmap -Pn -n -6 -p- --open <VPS_IPv6>       # same result over IPv6
curl -m 10 -sS http://<VPS_IPv4>/          # expect refused or timeout (no HTTP anywhere)
```

Windows alternative: `Test-NetConnection <VPS_IPv4> -Port 8443`.

Expected: only 8443 open. 443 must not answer at all. A refusal on 443 proves that the host is alive, which is why B3 asks for DROP.

### Phase 3: Secrets and environment (resolves B1, B5, H3)

Proves: no secret values in files or config, correct file modes, and Keycloak can read its own secrets.

```bash
# .env.prod: secret keys must be absent or empty (names only)
grep -E '^(KC_DB_PASSWORD|KC_ADMIN_PASS|KC_ADMIN_CLIENT_SECRET|KC_SETUP_CLIENT_SECRET|R_OPS_TOKEN)=.+' .env.prod \
  && echo "FAIL: secret values in .env.prod" || echo "OK"

# Required non-secret values
grep -E '^(KC_ENV|KC_PUBLIC_HOSTNAME|KC_ADMIN_HOSTNAME|MGMT_CIDR|KC_PUBLIC_PORT|KC_PROXY_TRUSTED_ADDRESSES|KC_DB_SSLMODE|KC_ENABLE_MOCK_TENANTS|PORTAL_REGISTRATION_MODE)=' .env.prod
chmod 600 .env.prod

# Secret files: directory 700, files 400
stat -c '%a %U:%G %n' secrets secrets/*

# Container view: the decisive B5 test (postgres must be healthy for 'run')
dc run --rm --entrypoint id keycloak-1
dc run --rm --entrypoint sh keycloak-1 -c 'ls -ln /run/secrets; for f in /run/secrets/*; do test -r "$f" && echo "readable: $f" || echo "NOT readable: $f"; done'

# Config and running containers contain no secret values
dc config | grep -E '[0-9a-f]{64}' && echo "FAIL: secret-like value in config" || echo "OK"
docker inspect $(dc ps -q) --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -iE '(PASS|SECRET)=.+' \
  && echo "FAIL: secret in container env" || echo "OK"
```

Expected values:

- `KC_ENV=prod`, `KC_PUBLIC_HOSTNAME=kc.gateway-vw.de`, `KC_PUBLIC_PORT=8443`, `KC_PROXY_TRUSTED_ADDRESSES=172.30.0.10/32`, `KC_DB_SSLMODE=verify-full`.
- `MGMT_CIDR=<MGMT_IP>/32`. Never `0.0.0.0/0`. The local test file's comment mentions that value.
- `KC_ENABLE_MOCK_TENANTS` absent or `0`.
- `PORTAL_REGISTRATION_MODE` must not be `impersonation` at go-live (H1).
- Secrets: directory `700`, files `400`.
- `id` reports `uid=1000(keycloak)`. Every secret shows owner `1000` and is readable. Owner `0` or "NOT readable" means B5.

### Phase 4: Certificates and DNS (resolves B2, B3)

Proves: publicly trusted certificates for the right names, keys match their certificates, DB CA chain is valid.

```bash
ls infra/nginx/certs/                                   # kc.gateway-vw.de and <ADMIN_HOST> present
for h in kc.gateway-vw.de <ADMIN_HOST>; do
  openssl x509 -in infra/nginx/certs/$h/fullchain.pem -noout -subject -issuer -enddate -ext subjectAltName
  diff <(openssl x509 -in infra/nginx/certs/$h/fullchain.pem -noout -pubkey) \
       <(openssl pkey -in infra/nginx/certs/$h/privkey.pem -pubout) >/dev/null \
    && echo "key matches certificate: $h" || echo "FAIL: key mismatch: $h"
done
openssl verify -CAfile keycloak/certs/pg-ca.crt infra/pg/certs/postgres.crt       # expect: OK
openssl x509 -in infra/pg/certs/postgres.crt -noout -ext subjectAltName -enddate   # SAN must contain DNS:postgres
```

From your PC:

```bash
dig +short kc.gateway-vw.de A                          # expect <VPS_IPv4>
echo | openssl s_client -connect <VPS_IPv4>:8443 -servername kc.gateway-vw.de \
  -verify_hostname kc.gateway-vw.de -verify_return_error 2>/dev/null | grep -E 'Verify return code|issuer='
```

Expected: `Verify return code: 0 (ok)`; the issuer is a public CA, not `CN=kc.gateway-vw.de`; `notAfter` more than 30 days away.

Renewal (automation not yet proven, see security-measures.md): run the ACME client's dry run, then `dc exec proxy nginx -s reload`, then repeat the external check.

### Phase 5: Containers and compose (resolves H6, H9, M3, L1, L4)

Proves: the running stack matches the design. One published port, healthy services, restart policy, hardening baseline.

```bash
dc config --quiet && echo "compose config OK"
dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}'
docker ps --format '{{.Names}}\t{{.Ports}}'
docker inspect $(dc ps -q) --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} privileged={{.HostConfig.Privileged}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} secopt={{.HostConfig.SecurityOpt}} log={{.HostConfig.LogConfig.Type}}{{.HostConfig.LogConfig.Config}} mem={{.HostConfig.Memory}}'
docker images --digests | grep -E 'keycloak|postgres|nginx|node'
```

Expected:

- Only `proxy` shows a host port: `0.0.0.0:8443->443/tcp` (plus `[::]` if IPv6 is bound).
- `keycloak-1`, `keycloak-2` and `postgres` show `healthy`.
- `keycloak-setup` and `keycloak-bootstrap` are not running (profile jobs).
- `restart=unless-stopped` for proxy, keycloak-1, keycloak-2, postgres.
- `privileged=false`.
- `log=json-file` with `max-size` and `max-file` set (H6). The compose file sets neither today.
- Keycloak memory limit 2 GiB.
- Digests are listed (M6). Floating tags are not reproducible.

### Phase 6: nginx (resolves B4, M4)

Proves: valid configuration, only 443 listening, no version leak, and the real client address reaches nginx.

```bash
dc exec proxy nginx -t                                           # syntax is ok / test is successful
dc exec proxy nginx -T 2>/dev/null | grep -nE '^\s*listen '      # only 443; no 'listen 80'
dc exec proxy nginx -T 2>/dev/null | grep -n 'server_tokens'     # server_tokens off
dc exec proxy ls /etc/nginx/conf.d/                              # admin.conf; and the image's default.conf? (M4)

# Source-address test: one request from your PC with spoofed forwarding headers
curl -s -o /dev/null $R -H 'X-Forwarded-For: 203.0.113.9' -H 'Forwarded: for=203.0.113.9' \
  "$U/realms/vw-baev/.well-known/openid-configuration"
dc logs --tail 5 proxy
```

Expected: `syntax is ok`; only `listen 443`; the first column of the log shows your public IP. Not `172.x`, not `10.x`, and not the spoofed `203.0.113.9`. A 10.x or 172.x address means B4 is still open.

### Phase 7: Keycloak functional (resolves H5)

Proves: services healthy, nodes clustered, DB connection encrypted, OIDC discovery correct for every active production realm.

```bash
for c in $(dc ps -q keycloak-1 keycloak-2 postgres); do docker inspect -f '{{.Name}} {{.State.Health.Status}}' "$c"; done
dc logs keycloak-1 keycloak-2 2>&1 | grep -iE 'cluster view|ISPN000094' | tail -4   # both nodes in one view
                                                                                  # (if empty, search for 'view' or 'jgroups'; wording varies by version)
dc logs keycloak-1 keycloak-2 2>&1 | grep -iE '\bERROR\b|unknown option' | tail -5   # expect nothing relevant
dc exec postgres psql -U keycloak -d keycloak -tAc \
  "SELECT a.usename, s.ssl, s.version FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename='keycloak';"
dc exec postgres psql -U keycloak -d keycloak -tAc \
  "SELECT rolname, rolsuper FROM pg_roles WHERE rolname='keycloak';"                # rolsuper=f is the goal (H5)
```

OIDC discovery from your PC, for every active production realm (`tenants.json`, stage `prod`, not paused):

```bash
for realm in vw-baev apothekerversorgung-berlin apvn vw-ltkmv vw-ltkt architektenversorgung-berlin; do
  curl -fsS $R "$U/realms/$realm/.well-known/openid-configuration" -o "disc-$realm.json" \
    && echo "$realm -> $(jq -r .issuer "disc-$realm.json")" || echo "FAIL: $realm"
  echo "  internal or plain URLs found: $(grep -cE 'http://|172\.30\.|:8080|:9000|localhost' "disc-$realm.json")"
done
```

Expected per realm: issuer `https://kc.gateway-vw.de:8443/realms/<realm>`, and a count of 0.

### Phase 8: Negative and security tests (from your PC)

Proves: everything not intended is blocked. Each line states the expected code.

```bash
code $R $U/admin/                                                       # expect 404
code $R $U/realms/master/.well-known/openid-configuration               # expect 404
code $R $U/health/ready                                                 # expect 404 (management port 9000 is not proxied)
code $R $U/metrics                                                      # expect 404
code $R $U/realms/vwaek/.well-known/openid-configuration                # paused tenant: expect 404
code $R "$U/realms/vw-baev/..%2Fmaster/.well-known/openid-configuration"  # expect 404 (path traversal)
code $R $U/realms/vw-baev/account/                                      # expect 404 (H2: catch-all passes it today)
code $R -X POST -H 'Content-Type: application/json' -d 'not-json' \
  $U/realms/vw-baev/clients-registrations/openid-connect                # expect 404 (H2). A 400 or 401 would mean Keycloak was reached.
```

Admin host, from outside and from `<MGMT_IP>`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --resolve <ADMIN_HOST>:8443:<VPS_IPv4> \
  https://<ADMIN_HOST>:8443/admin/master/console/
# expect 403 from any address other than <MGMT_IP>; from <MGMT_IP> expect 200 or 302
```

Unknown SNI (must not return a certificate):

```bash
echo | openssl s_client -connect <VPS_IPv4>:8443 -servername evil.example 2>&1 | grep -iE 'alert|no peer certificate|handshake failure'
```

Host header spoofing (the issuer must not change):

```bash
curl -s $R -H 'Host: evil.example' "$U/realms/vw-baev/.well-known/openid-configuration" -w '\nHTTP %{http_code}\n' \
  | grep -E '"issuer"|"token_endpoint"|HTTP'
# expect issuer and token_endpoint on kc.gateway-vw.de:8443; a 4xx status is also acceptable
```

Rate limit:

```bash
seq 1 60 | xargs -P 60 -I{} curl -s -o /dev/null -w '%{http_code}\n' $R "$U/realms/vw-baev/.well-known/openid-configuration" | sort | uniq -c
# expect a mix of 200 and 429 (429 = limit_req working)
```

Headers:

```bash
curl -s -o /dev/null -D - $R "$U/realms/vw-baev/.well-known/openid-configuration" | grep -iE '^(strict-transport-security|server|x-powered-by):'
# expect HSTS present; no Server version; no X-Powered-By
```

Brute-force settings are verified in the admin console, not by attack: `bruteForceProtected=true`, `failureFactor=10`, `maxFailureWaitSeconds=900`.

### Phase 9: Logs contain no tokens or codes (resolves H8)

Proves: query strings with codes, state or session values never reach the logs (architecture section 7.3).

```bash
C="canary$(date +%s)"
for i in $(seq 1 60); do
  curl -s -o /dev/null $R "$U/realms/vw-baev/protocol/openid-connect/auth?code=$C&state=$C&session_code=$C" &
done
wait
sleep 5
dc logs --since 10m proxy keycloak-1 keycloak-2 2>&1 | grep -c "$C"                                  # expect 0
dc logs --since 10m proxy keycloak-1 keycloak-2 2>&1 | grep -ciE 'bearer |client_secret=|password='  # expect 0
```

The 60 parallel requests also trigger the rate limit, so the nginx error-log path is covered as well.

If the first count is above 0:

- nginx error log: "limiting requests" messages carry the request line. Set `limit_req_log_level info;` in the generated server blocks and re-test.
- Keycloak access log (`KC_HTTP_ACCESS_LOG_ENABLED=true`): it logs requests. Use an `http-access-log-pattern` that omits the query, or disable the access log. Check the placeholder names in the 26.7.5 documentation first.

### Phase 10: Resilience

10a. Single Keycloak node failure (no outage expected). Run from your PC:

```bash
dc stop keycloak-1      # on the VPS
for i in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' $R "$U/realms/vw-baev/.well-known/openid-configuration"; sleep 1; done; echo
dc start keycloak-1     # on the VPS
dc logs --since 5m keycloak-1 keycloak-2 2>&1 | grep -iE 'cluster view|ISPN000094' | tail -2
```

Expected: all 200 (at most one 502 right after the stop). The cluster view shows two members again.

10b. Reboot (maintenance window, after a backup from Phase 11):

```bash
sudo reboot
# after the VPS is back, on the VPS:
loginctl show-user "$(whoami)" -p Linger && systemctl --user is-active docker
dc ps
```

Expected: all services healthy within about five minutes, with no manual step. If the stack stays down, linger is off or the user service is not enabled.

10c. Certificate reload after renewal: `dc exec proxy nginx -s reload`, then repeat the Phase 4 external check.

### Phase 11: Backup and restore (not yet proven; required before real users)

Proves: a backup exists, restores, and is stored off the host.

```bash
D="backup-$(date +%F).dump"
dc exec -T postgres pg_dump -U keycloak -d keycloak -Fc > "$D"
ls -lh "$D"
# Encrypt with age or gpg before it leaves the VPS, then copy the encrypted file to off-host storage.
dc exec -T postgres createdb -U keycloak restore_test
dc exec -T postgres pg_restore -U keycloak -d restore_test < "$D"
dc exec postgres psql -U keycloak -d restore_test -tAc \
  "select 'realms', count(*) from realm union all select 'users', count(*) from user_entity;"
dc exec postgres psql -U keycloak -d keycloak -tAc \
  "select 'realms', count(*) from realm union all select 'users', count(*) from user_entity;"
dc exec postgres dropdb -U keycloak restore_test
```

Expected: the restore succeeds and the counts match the live database. Back up `secrets/`, the certificates and `.env.prod` separately, also encrypted. This restore test is a sanity check on the same server. A real disaster-recovery test restores onto another host.

---

## 4. Go-live gates (not setup checks, but they block real users)

| Gate | Check | Source |
|---|---|---|
| G1 Impersonation removed | `portalImpersonation` absent in all active prod tenants; `impersonation` role not assigned to `portal-admin`; `PORTAL_REGISTRATION_MODE` not `impersonation` | architecture C2 and section 7 |
| G2 Realm allowlist | `account`, `clients-registrations`, `broker`, `device`, `ext` return 404 (Phase 8) | architecture section 7.3 |
| G3 Bootstrap admin retired | Named admin with MFA verified; `admin_password` removed from compose secret lists; `KC_BOOTSTRAP_ADMIN_USERNAME` removed; file deleted | `scripts/retire-bootstrap-admin.sh` |
| G4 Passkey flows | Tests S0-S11 from architecture section 7.4 in Chrome, Firefox, Safari and iOS | architecture section 7.4 |
| G5 RP ID decision | Shared RP ID `gateway-vw.de` accepted or narrowed before the first passkey is registered (changing it later invalidates all passkeys) | architecture H1 |
| G6 Clients | One client per portal, bound to `browser-passkey`, exact redirect URIs, PKCE S256, direct grants off | architecture H2, M1 |
| G7 Rate limits | Separate, higher limit for the token endpoint from the Lambda egress addresses; load-tested | architecture H3 |
| G8 Backups | Phase 11 passes; backup stored off-host; restore time recorded | security-measures.md |
| G9 Monitoring | External uptime check on the discovery URL; certificate-expiry alert; disk-space alert; admin-event alerts | security-measures.md |
| G10 Host hardening | SSH key-only (Phase 1); fail2ban or equivalent; unattended upgrades; provider snapshot before every change | security-measures.md |
| G11 Images | Digests pinned; image scan (Trivy or Docker Scout) with no unaccepted critical CVEs | security-measures.md |

---

## 5. Findings register

| ID | Sev | Finding | Fix | Verified in |
|---|---|---|---|---|
| B0-B7 | Blocker | See section 1 | See section 1 and section 6 | Phases 0-7 |
| H1 | High | `PORTAL_REGISTRATION_MODE=impersonation` is the default in `.env.prod.example`. Six active prod tenants have `portalImpersonation: true` in `tenants.json`. | Architecture section 7 decision | G1 |
| H2 | High | Realm locations use the catch-all `^~ /realms/<realm>/`, which exposes `account`, `clients-registrations`, `broker`, `device` and `ext`. | Allowlist: `.well-known`, `protocol/openid-connect/{auth,token,certs,userinfo,logout}`, `login-actions/`, `resources/` | Phase 8 |
| H3 | High | `admin_password` is still in the `keycloak-base` secret list, and `KC_BOOTSTRAP_ADMIN_USERNAME` is still set. Keycloak creates a bootstrap admin from these when no admin exists. | Retire after the named admin with MFA is verified (G3) | Phase 3, G3 |
| H4 | High | `shared/users.json`: 7 users with plaintext passwords. Not in `.gitignore`. Sits inside the deploy tree. | Remove from the VPS copy. Add `shared/` to `.gitignore` or move it out of the repo. | Phase 0 |
| H5 | High | DB role `keycloak` is a superuser, because the `postgres` image's `POSTGRES_USER` creates a superuser. A Keycloak compromise becomes a database superuser compromise. | Non-superuser owner role for the application; superuser only for administration | Phase 7 (`pg_roles`) |
| H6 | High | No log rotation. The `json-file` driver has no `max-size` or `max-file`. Log growth can fill the disk and stop the stack. | `logging:` with `max-size: 10m` and `max-file: 5` on every service, or set it in `daemon.json` | Phase 5 |
| H7 | High | Backups and restore are not evidenced. | Phase 11 and G8 | Phase 11 |
| H8 | High | Query strings in logs are not yet tested. | Phase 9 and its fixes | Phase 9 |
| M1 | Medium | A parallel, older stack exists in `C:\dev\test\` (different `Dockerfile`, `realm-template.mjs`, `tenants.json`, `nginx.conf`, `generate-nginx.mjs`, `docker-compose.yml`). | One source of truth (`KeycloakV2`). Archive the parent copy. | Phase 0 |
| M2 | Medium | `generated/tenants.conf` was generated on 2026-10-28. Regenerate and diff on every change to `tenants.json`. | Run `node infra/nginx/generate-nginx.mjs --keycloak-only` in the deploy step | Phase 6 |
| M3 | Medium | No container hardening: no `no-new-privileges`, no `cap_drop`, no `pids_limit`; no memory limit on proxy or postgres. | Add per service; re-test after each change | Phase 5 |
| M4 | Medium | The image's default `conf.d/default.conf` is loaded by `include /etc/nginx/conf.d/*.conf` and may add an HTTP listener. It is not published, but it violates the "no HTTP" rule. | Check `nginx -T` for `listen 80`. Remove the file in a derived image or mount an empty conf.d. | Phase 6 |
| M5 | Medium | The header strip list in `kc-proxy.conf` lacks `baggage`, `b3`, `x-b3-*`, `uber-trace-id` and `x-ot-span-context` (Keycloak header-filtering guide). | Add them | Code review |
| M6 | Medium | Image tags float: `postgres:17-alpine`, `nginx:1.27-alpine`, `node:24-alpine`. The Keycloak base is pinned by tag only. | Pin `@sha256:` digests and re-pin on a schedule | Phase 5 |
| M7 | Medium | Scripts referenced in code or docs do not exist: `scripts/gen-local-certs.sh`, `scripts/setup-local-prod.sh`, `scripts/check-local-prod.sh`, `scripts/reset-demo-state.mjs`. The hardening runbook lives outside the repo. | Restore or remove the references. Move runbooks into the repo. | Phase 0 |
| M8 | Medium | Plain HTTP between nginx and Keycloak on the bridge network. Keycloak's guide recommends re-encrypt for production. | Accept and document (private network, no other tenant containers), or add TLS re-encrypt | Architecture decision |
| M9 | Medium | No host monitoring or alerting (uptime, certificate expiry, disk). | G9 | security-measures.md |
| L1 | Low | `stop_grace_period: 45s` is below `KC_SHUTDOWN_DELAY` (16 s) plus `KC_SHUTDOWN_TIMEOUT` (30 s) = 46 s. Docker sends SIGKILL first and cuts the graceful shutdown short. | `stop_grace_period: 60s` | Phase 5 |
| L2 | Low | `keycloak/setup-realms.mjs` line 27 has a hard-coded fallback secret `dev-portal-admin-secret`. The prod guard at line 555 prevents its use, but the fallback should not ship. | Remove the fallback; keep the guard | Code review |
| L3 | Low | `R_OPS_TOKEN` has a value in two `.env` copies (`C:\dev\test\.env.prod`, `Vorbereitung vps IONOS\.env - Kopie.prod`). No code uses it. | Delete the copies. Rotate if the token was ever valid. | Phase 3 |
| L4 | Low | The nginx `proxy` service has no healthcheck. | Add one (for example, a TLS probe against 127.0.0.1:443) | Phase 5 |

---

## 6. Fix snippets

### 6.1 B4: keep the client IP under rootless Docker

Maintenance window. The daemon restart stops containers briefly; their restart policies bring them back.

```bash
mkdir -p ~/.config/docker
# If daemon.json already exists, merge the key instead of overwriting the file.
cat > ~/.config/docker/daemon.json <<'EOF'
{
  "userland-proxy": false
}
EOF
sudo tee /etc/modules-load.d/docker.conf >/dev/null <<'EOF'
br_netfilter
EOF
sudo modprobe br_netfilter
systemctl --user restart docker
```

Requires RootlessKit 3.0 or newer (`rootlesskit --version`). Then re-run Phase 6 (source-address test).

### 6.2 B5: secret ownership under rootless Docker

```bash
S=$(awk -F: -v u="$(whoami)" '$1==u{print $2; exit}' /etc/subuid)
KC_HOST_UID=$((S + 999))                      # host UID that equals container UID 1000
echo "container uid 1000 = host uid $KC_HOST_UID"
sudo chown "$KC_HOST_UID:$KC_HOST_UID" secrets/*
chmod 0400 secrets/*
```

Keep `secrets/` itself owned by the operator with mode `700`. Do not make secrets world-readable. Patch `scripts/create-secrets.sh` so rootless runs compute `KC_UID` this way. Today it defaults to `1000` on the host, which is wrong under rootless mapping. Then re-run Phase 3 (`ls -ln` must show `1000`).

---

## 7. Rollback

- Repo changes: restore the previous files from your backup. Regenerate with `node infra/nginx/generate-nginx.mjs --keycloak-only`, then `docker compose --env-file .env.prod up -d --force-recreate` and `nginx -t`.
- `daemon.json`: remove the `userland-proxy` key (or the file) and run `systemctl --user restart docker` in a maintenance window.
- Realm `frontendUrl`: re-run `setup-realms` with the old URL (rollback step 4 of the hardening runbook).
- Never roll back by restoring an old `.env` with secrets. Rotate instead.
- Take a provider snapshot before every change from section 6.

---

## 8. Evidence to hand back

Requested by the hardening runbook, plus the phase outputs:

1. `dc exec proxy nginx -t` output
2. `dc ps -a` output
3. Issuer lines from the Phase 7 discovery loop
4. `nmap` output from Phase 2 (IPv4 and IPv6)
5. Phase 8 status-code table
6. Phase 9 canary count (expected `0`)
7. Phase 11 restore counts

---

## 9. Target state after the fixes

Section 2 is the target state against which Phases 2-9 are measured. Every item in section 1 must be closed, and every Phase 0-8 check must pass, before the first real user session.
