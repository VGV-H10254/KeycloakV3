# Certificate Renewal and Recovery Playbook

## Scope

This playbook covers the Nginx certificates for `gateway-vw.de` and `kc.gateway-vw.de`.

The Compose bind mount is:

```yaml
- ./infra/nginx/certs:/etc/nginx/certs:ro
```

Renewal normally requires updating host files and reloading Nginx. A Docker restart is normally not required.

## Expected files

```text
infra/nginx/certs/gateway-vw.de/fullchain.pem
infra/nginx/certs/gateway-vw.de/privkey.pem
infra/nginx/certs/kc.gateway-vw.de/fullchain.pem
infra/nginx/certs/kc.gateway-vw.de/privkey.pem
```

Filenames must match the Nginx configuration exactly.

## Normal renewal procedure

Run as the rootless Docker user:

```bash
cd ~/KeycloakV2
backup="/tmp/nginx-certs-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp -a infra/nginx/certs/gateway-vw.de "$backup/"
cp -a infra/nginx/certs/kc.gateway-vw.de "$backup/"
```

The certificate client then copies the renewed files into the directories above. Prefer temporary files followed by an atomic rename.

Verify visibility and validate Nginx:

```bash
docker exec keycloak-prod-proxy-1 ls -l /etc/nginx/certs/gateway-vw.de
docker exec keycloak-prod-proxy-1 ls -l /etc/nginx/certs/kc.gateway-vw.de
docker exec keycloak-prod-proxy-1 nginx -t
```

Only after `nginx -t` succeeds:

```bash
docker exec keycloak-prod-proxy-1 nginx -s reload
```

## Security rules

- Do not delete the old certificate before the new one passes validation.
- Do not put certificates in the Docker image.
- Do not commit certificates or private keys to Git.
- Do not log private-key contents.
- Keep private-key permissions restrictive.
- Copy final files into the bind-mounted directory; avoid symlinks outside it.
- Never reload Nginx after a failed `nginx -t`.

## Certificate file not found

```bash
find infra/nginx/certs -maxdepth 2 -type f -print
docker exec keycloak-prod-proxy-1 nginx -T 2>&1 | grep -nE 'ssl_certificate|ssl_certificate_key|server_name'
docker inspect keycloak-prod-proxy-1 --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

The mount must map the host `infra/nginx/certs` directory to `/etc/nginx/certs`.

## Permission denied

```bash
docker exec keycloak-prod-proxy-1 id nginx
docker exec keycloak-prod-proxy-1 ls -l /etc/nginx/certs/gateway-vw.de
docker exec keycloak-prod-proxy-1 ls -l /etc/nginx/certs/kc.gateway-vw.de
docker exec keycloak-prod-proxy-1 nginx -t
```

The Nginx process must be able to read the private key. Do not make private keys world-readable unless there is no safer alternative.

## Certificate and key do not match

For RSA keys:

```bash
openssl x509 -noout -modulus -in infra/nginx/certs/gateway-vw.de/fullchain.pem | openssl sha256
openssl rsa -noout -modulus -in infra/nginx/certs/gateway-vw.de/privkey.pem | openssl sha256
```

The hashes must match. Use an equivalent public-key comparison for ECDSA or Ed25519 keys.

## Reload fails

```bash
docker exec keycloak-prod-proxy-1 nginx -t
docker logs --tail 100 keycloak-prod-proxy-1
```

Common causes are wrong paths, missing intermediates in `fullchain.pem`, a mismatched key, invalid PEM formatting, invalid Nginx configuration, or key permissions.

Restore the previous files if necessary:

```bash
cp -a /tmp/nginx-certs-backup-YYYYMMDD-HHMMSS/gateway-vw.de/. infra/nginx/certs/gateway-vw.de/
cp -a /tmp/nginx-certs-backup-YYYYMMDD-HHMMSS/kc.gateway-vw.de/. infra/nginx/certs/kc.gateway-vw.de/
docker exec keycloak-prod-proxy-1 nginx -t && docker exec keycloak-prod-proxy-1 nginx -s reload
```

## Wrong certificate is served

Always test with the correct SNI. Testing only `https://127.0.0.1:8443` uses the unknown SNI name `127.0.0.1` and is intentionally rejected.

```bash
openssl s_client -connect 127.0.0.1:8443 -servername gateway-vw.de </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
curl -vk --resolve gateway-vw.de:8443:127.0.0.1 https://gateway-vw.de:8443/
docker exec keycloak-prod-proxy-1 nginx -T 2>&1 | grep -nE 'server_name|ssl_certificate'
```

## Old certificate remains active

Nginx reads certificates at startup or reload. Verify the file inside the container and reload:

```bash
docker exec keycloak-prod-proxy-1 openssl x509 -in /etc/nginx/certs/gateway-vw.de/fullchain.pem -noout -dates -fingerprint -sha256
docker exec keycloak-prod-proxy-1 nginx -t && docker exec keycloak-prod-proxy-1 nginx -s reload
```

A Docker restart should normally not be necessary.

## Symlink problem

Some ACME clients use symlinks outside the bind-mounted directory. Prefer copying final files into `infra/nginx/certs/<hostname>/`.

```bash
readlink -f infra/nginx/certs/gateway-vw.de/fullchain.pem
docker exec keycloak-prod-proxy-1 readlink -f /etc/nginx/certs/gateway-vw.de/fullchain.pem
```

## Port 8443 and the IONOS Backup Agent

The Backup Agent normally connects outbound to the IONOS service on destination port `8443`. This does not conflict with Nginx listening on VPS port `8443`.

Keep:

```yaml
ports:
  - "8443:443"
```

Verify without `sudo`:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
ss -lnt | grep ':8443'
```

A conflict exists only if another service listens inbound on the VPS itself on port `8443`.

## Renewal process cannot write files

```bash
whoami
ls -ld infra/nginx/certs
touch infra/nginx/certs/.write-test && rm infra/nginx/certs/.write-test
```

The renewal user must have controlled write access. Do not make the certificate directory world-writable.

## Automation requirements

The deployment hook should:

1. Obtain the renewed certificate.
2. Validate certificate and private key.
3. Copy both files into the correct bind-mounted directory.
4. Preserve private-key permissions.
5. Run `nginx -t`.
6. Reload Nginx only if the test succeeds.
7. Log success or failure without secrets.
8. Alert on renewal or reload failure.

DNS-01 is recommended when the service is available only on port `8443`. HTTP-01 normally requires port 80, and TLS-ALPN-01 normally requires port 443.

## Post-renewal verification

```bash
docker exec keycloak-prod-proxy-1 nginx -t
curl -sk --resolve gateway-vw.de:8443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://gateway-vw.de:8443/
curl -sk --resolve kc.gateway-vw.de:8443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://kc.gateway-vw.de:8443/
curl -fsS --resolve gateway-vw.de:8443:127.0.0.1 https://gateway-vw.de:8443/realms/vw-baev/.well-known/openid-configuration
```

Verify externally too. Local tests do not prove DNS, firewall, IPv6, or external-client reachability.

## Escalation checklist

Collect the following without exposing secrets:

```bash
date
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker exec keycloak-prod-proxy-1 nginx -t
docker logs --tail 100 keycloak-prod-proxy-1
ss -lnt | grep ':8443'
openssl s_client -connect 127.0.0.1:8443 -servername gateway-vw.de </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

Never include `privkey.pem`, Docker secret files, `.env.prod`, or client secrets in a support request.
