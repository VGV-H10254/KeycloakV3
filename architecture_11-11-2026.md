# Change Record — Keycloak Upgrade 26.7.5 → 26.8.2 (2026-11-11)

Scope: version bump plus the mandatory fork verification (finding M2). Ships in one
deployment wave together with the nginx security headers and the realm-level passkey
toggle (`webAuthnPolicyPasswordlessPasskeysEnabled`) from the same working state.

## 1. Decision

| Item | Detail |
|---|---|
| Version | `26.7.5` → `26.8.2` (tag existence on `quay.io` verified 2026-11-11) |
| Driver | 26.7 stream is at end-of-life — `26.7.5` (2026-09-30) was its final patch; security fixes only land in the current stream (26.8.x) |
| CVEs relevant to this stack's exposure | CVE-2026-110932 — *unauthenticated* persistent disk exhaustion via theme gzip cache (affects ≤ 26.8.0; custom themes served via nginx); unauthenticated SAML-endpoint DoS (CPU/OOM via SAML 1.1 parser loops) — reachable through `/realms/<realm>/protocol/saml/…` despite OIDC-only usage; stored-XSS fix on the login page (kcSanitize bypass) |
| Bonus | `KC_FEATURES=stateless` promoted from preview (26.7) to supported (26.8) |
| Pin locations (3 — always bumped together) | Both `FROM` lines in `keycloak/Dockerfile`, `build.name` in `docker-compose.yml`, pin line in `security-measures.md` |

## 2. What changed in the repo

| File | Change |
|---|---|
| `keycloak/Dockerfile` | Both `FROM quay.io/keycloak/keycloak:26.8.2` |
| `docker-compose.yml` | `build.name: keycloak-custom:26.8.2` (shared image for `keycloak-1`/`keycloak-2`) |
| `security-measures.md` | Pin line updated to `26.8.2` |
| `keycloak/themes/portal-base/login/resources/js/webauthnRegister.js` | M2 fork ported to the 26.8.2 base (see §3) |
| `keycloak/.dockerignore` *(new, same wave)* | Build context reduced to `Dockerfile`, `themes/`, `secrets-entrypoint.sh` |

## 3. M2 verification — fork vs upstream (evidence)

**Location correction:** the upstream file lives in the **`base`** theme, not `keycloak`:
`themes/src/main/resources/theme/base/login/resources/js/webauthnRegister.js`.
Inheritance chain `portal-base → keycloak → base`; `webauthn-register.ftl` line 27 imports
`${url.resourcesPath}/js/webauthnRegister.js`, so the portal-base copy shadows the base file.
(Earlier docs described the fork source imprecisely as "theme keycloak".)

| Check | Result |
|---|---|
| Upstream delta 26.7.5 → 26.8.2 (`webauthnRegister.js`) | **One line**: unsupported-browser branch now sends the marker `"WebAuthnUnsupportedBrowser"` instead of `input.errmsg` |
| `webauthn-register.ftl` | **Unchanged** 26.7.5 → 26.8.2 |
| Server side (`WebAuthnRegister.java`) | Error-mapping refactor (~160 lines): new `mapBrowserApiErrorToMessageKey()` / `getWebAuthnErrorMessageKey()` translate browser API errors into localized message keys; line 556 maps the `"WebAuthnUnsupportedBrowser"` marker → `WEBAUTHN_ERROR_UNSUPPORTED_BROWSER` |
| `WebAuthnPasswordlessRegister.java` | Subclass of `WebAuthnRegister`, no own FTL — both required actions render `webauthn-register.ftl` |

**Fork port applied:** the marker line was adopted (plus EOF-newline hygiene). Functional
relevance: the FTL still passes `errmsg` (a localized *text*), but the 26.8.2 mapper matches
on the marker string — without the port, browsers without WebAuthn support would show the
generic `WEBAUTHN_ERROR_REGISTRATION` fallback instead of the proper message.

**Remaining deliberate fork delta** (kept, re-verify on next upgrade):
`window.prompt` fallback in `returnSuccess` (embedded browsers), `doRegister()` helper,
map-style `getExcludeCredentials`, explanatory comments. After the port, the fork differs
from upstream 26.8.2 in 47 lines across 11 hunks — all accounted for by the items above.

**Line endings:** the fork was CRLF on disk (`core.autocrlf=true`) while upstream ships LF,
so every M2 diff was full-file noise. Working tree normalized to LF and pinned via
`.gitattributes` (`text eol=lf`) — same pattern already used for the shell scripts.

## 4. A1 — provider IDs / required-action aliases

`WebAuthnPasswordlessAuthenticator`, `WebAuthnPasswordlessRegister`,
`WebAuthnRegister(Factory)` all exist at identical paths in the 26.8.2 tree.
Final validation happens at deploy time: `keycloak-setup` re-run fails loudly on any
renamed alias (idempotent reconciliation by design).

## 5. Deployment runbook (single wave, on the VPS)

```bash
# 0. Freeze the working state first (repo is git now)
git add -A && git commit -m "keycloak 26.7.5 -> 26.8.2 + headers + passkey toggle" && git tag kc-26.8.2

# 1. DB backup (26.8 schema migrations run on boot; Keycloak does not downgrade)
docker compose --env-file .env.prod exec -T postgres \
  pg_dump -U "$KC_DB_USER" "$KC_DB_NAME" > kc-backup-$(date +%F).sql

# 2. Sanity: compose accepts build.name
docker compose --env-file .env.prod config >/dev/null && echo OK

# 3. Build the single shared image, restart both nodes (brief downtime window)
docker compose --env-file .env.prod build
docker compose --env-file .env.prod up -d
docker compose --env-file .env.prod ps   # both keycloak nodes healthy/ready

# 4. nginx wave: verify + reload (new security headers)
docker compose --env-file .env.prod --profile verify run --rm nginx-verify
docker compose --env-file .env.prod exec proxy nginx -s reload

# 5. Mock gate (includes the fork port — enrollment error paths)
docker compose --env-file .env.prod --profile setup run --rm \
  -e KC_ENABLE_MOCK_TENANTS=1 -e TENANT=vw-baev-mock keycloak-setup
#    6-point checklist against https://mock-vw-baev.de:8443 (unchanged procedure)

# 6. Prod rollout (passkey toggle for all 9 tenants)
docker compose --env-file .env.prod --profile setup run --rm keycloak-setup

# 7. Housekeeping
docker image rm keycloak-prod-keycloak-1 keycloak-prod-keycloak-2   # old auto-named twins
```

Rollback: `git revert` of the bump commit → rebuild 26.7.5 → `up -d`; if schema already
migrated, restore the pg_dump into a fresh volume (forward-only migrations).

## 6. Open items (carried over)

- **H1** — narrow WebAuthn RP-ID to `kc.gateway-vw.de` before the first production passkey.
- **C2** — remove `portalImpersonation` (replace with single-use enrollment token).
- **H2** — client hygiene: stray `vw-baev` client without PKCE.
