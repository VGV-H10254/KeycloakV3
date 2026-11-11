# Hardening Status — KeycloakV2 Stack

Date: 2026-11-06
Scope: nginx, Keycloak, PostgreSQL, container/host, secrets, monitoring.

Legend: ✅ Done · ⚠️ Partial · ❌ Missing · ❓ Unknown (needs VPS check)

## Network / nginx
| Item | Status | Evidence / Action |
|---|---|---|
| TLS 1.2/1.3 only + strong ciphers | ✅ Done | `infra/nginx/nginx.conf` ssl_protocols/ciphers |
| HSTS | ⚠️ Partial | `max-age=31536000` only → add `includeSubDomains; preload` in nginx.conf + admin template |
| Security headers (nosniff, frame-options, referrer-policy, permissions-policy) | ❌ Missing | Add to admin.conf.template and tenant template |
| Admin port firewall-restricted | ⚠️ Partial | nginx allow/deny commented (rootless Docker IP masquerade); enforce at IONOS firewall |
| Internal ports not published | ✅ Done | only proxy publishes 8443/8444 (verify `docker compose ps`) |
| Rate limiting | ✅ Done | `limit_req_zone` 10r/s + 429 |

## Keycloak
| Item | Status | Action |
|---|---|---|
| Admin MFA / strong password | ❓ Unknown | Admin Console → Users → admin → Credentials + Required Actions (Configure OTP) |
| Realm hardening (registration, verifyEmail, brute force) | ❓ Unknown | Check `keycloak/realm-template.mjs`; add `bruteForceProtected: true`, etc. |
| Clients (public+PKCE vs confidential) | ⚠️ Partial | portal-mock/portal-bootstrap public+PKCE ✅; `keycloak-config/*.json` still `publicClient: true` |
| Disable implicit flow | ❓ Unknown | Set `implicitFlowEnabled: false` in client configs |
| Short token lifespans / refresh rotation | ❓ Unknown | Realm → Tokens → Access Token Lifespan; enable refresh-token rotation |
| Events logging | ❓ Unknown | Realm → Events → `eventsEnabled`, `adminEventsEnabled` |

## PostgreSQL
| Item | Status | Action |
|---|---|---|
| TLS enforced | ⚠️ Partial | Certs mounted; verify `ssl=on` in pg config and `sslmode=require` in Keycloak JDBC URL |
| DB port not published | ✅ Done | not in compose ports |
| SCRAM auth | ❓ Unknown | `password_encryption = scram-sha-256` in pg config |
| Least privilege app user | ❓ Unknown | Audit grants; remove SUPERUSER |
| Encrypted off-site backups | ❓ Unknown | pg_dump → encrypted → IONOS Object Storage |

## Secrets & config
| Item | Status | Action |
|---|---|---|
| Docker secrets files | ✅ Done | `secrets:` in compose |
| `.env.prod` mode 600 | ❓ Unknown | `chmod 600 .env.prod` on VPS |
| Rotation runbook | ❌ Missing | Document in playbook style |
| Secret scanning in CI | ❌ Missing | Add gitleaks to CI |

## Container / host
| Item | Status | Action |
|---|---|---|
| Rootless Docker | ✅ Done | README states rootless |
| Image pinning | ❓ Unknown | Check compose image tags (should be digests, not `:latest`) |
| Read-only FS | ❌ Missing | Add `read_only: true` + tmpfs to compose services |
| Capability drop | ❌ Missing | `cap_drop: [ALL]` in compose |
| Unattended security updates | ❓ Unknown | Configure `unattended-upgrades` on VPS |

## Monitoring
| Item | Status | Action |
|---|---|---|
| Centralized logs + alerting | ❓ Unknown | Configure log shipping |
| Keycloak events persisted | ❓ Unknown | Enable as above |
| Backup restore test | ❌ Missing | Schedule monthly |
| Cert expiry alerting | ❓ Unknown | Add cron + alert 14 days before expiry |

## Top 5 to do next (highest impact)
1. Firewall-restrict port 8444 to `MGMT_CIDR` (IONOS security group).
2. Flip confidential clients for backend usage; keep browser clients public+PKCE; flip `vw-baev` etc. only if server-side.
3. Enable Keycloak brute-force protection + event logging + short token lifespan.
4. Add security headers (nosniff, frame-options, referrer-policy) to nginx templates.
5. Verify DB TLS (`ssl=on`, `sslmode=require` in JDBC URL) and SCRAM auth.

## Items marked ❓
Tell me which you want verified and I'll inspect the relevant files on the VPS/repo.
