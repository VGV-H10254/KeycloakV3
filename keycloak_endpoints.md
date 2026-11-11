# Keycloak endpoint inventory — passkey create, login, recover

1. a user creates a passkey,
2. the user logs in to the portal with the passkey,
3. the user recovers access when the passkey is lost.

Paths are relative to one of two hosts. Every endpoint table carries a **Host** column with one of these two markers:

| Marker | Base URL | Port | Exposure | Used for |
|---|---|---|---|---|
| `kc:8443` | `https://kc.gateway-vw.de:8443` | **8443 only** | public internet | browser OIDC, `login-actions`, `/resources`, code exchange, `userinfo`, `certs`, logout |
| `kc-admin:8444` | `https://kc-admin.gateway-vw.de:8444` | **8444 only** | IONOS firewall allowlist (AWS egress) — no `MGMT_CIDR` | `client_credentials`, Admin REST, Admin Console assets |

Both vhosts terminate on the same Keycloak nodes and therefore return the **same issuer** (`https://kc.gateway-vw.de:8443/realms/{realm}`), because the issuer comes from `--hostname`, not from the request host. Never validate `iss` against `kc-admin` and never set `frontendUrl` to it.

The admin host listens on **8444**. Port 8443 on `kc-admin.gateway-vw.de` must be closed — see finding **P12**.

`{realm}` is exactly one of the nine tenant realms. No endpoint below is cross-realm.

---

## Endpoint groups at a glance

| Group | Host | Caller | Auth | Runtime? |
|---|---|---|---|---|
| Public OIDC | `kc:8443` | browser + portal backend | PKCE / client auth | yes |
| `login-actions` | `kc:8443` | browser only | Keycloak auth-session cookie | yes |
| Admin REST | `kc-admin:8444` | enrollment/recovery Lambda | Bearer (service account) | yes |
| Setup REST | `kc-admin:8444` | `setup-realms.mjs` / operator | Bearer (setup client) | no, one-time |
| Broker (optional) | `kc:8443` + `kc-admin:8444` | browser + setup | OIDC/SAML | only if Verimi is brokered |

---

## Public OIDC endpoints

These are the only endpoints the portal backend calls server-to-server, plus the browser redirects.

| ID | Method | Host | Path | Caller | Purpose | Auth | Notes |
|---|---|---|---|---|---|---|---|
| O1 | `GET` | `kc:8443` | `/realms/{realm}/.well-known/openid-configuration` | portal backend | discovery: issuer, endpoints, algorithms | none | cache 1 h; issuer must be `https://kc.gateway-vw.de:8443/realms/{realm}` |
| O2 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/certs` | portal backend | JWKS to verify ID/access token | none | cache by `kid`; refresh on unknown `kid` |
| O3 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/auth` | **browser** | start Authorization Code flow | none (public client + PKCE) | never call from Lambda; POST is preferred for enrollment so secrets stay out of the URL |
| O4 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token` | portal backend | code exchange, refresh | Basic client auth or PKCE | see bodies below; never from browser. `client_credentials` uses the same path but **`kc-admin:8444`** (= A1) |
| O5 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/userinfo` | portal backend | `sub`, `preferred_username`, attributes | Bearer | optional if the ID token already carries the claims |
| O6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/logout` | **browser** | RP-initiated logout | session / `id_token_hint` | `post_logout_redirect_uri` must match `post.logout.redirect.uris` |
| O7 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/introspect` | portal backend | optional opaque/refresh-token validation | client auth | not needed for JWT access tokens |
| O8 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/revoke` | portal backend | optional refresh-token revocation on logout | client auth | recommended if refresh tokens are stored |
| O9 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/login-status-iframe.html` | browser | optional silent-SSO / session check | none | only if the portal uses `check-session`; the only legitimate iframe use |
| O10 | `GET` | `kc:8443` | `/realms/{realm}` | portal backend | optional realm metadata / legacy public key | none | prefer O1 + O2 |

### 4.1 Authorization request (`O3`)

| Parameter | Value | Why |
|---|---|---|
| `client_id` | `portal-mock` (login), `portal-bootstrap` (E1 enrollment), `portal-enroll` (E2) | one client per purpose until H2 is resolved |
| `redirect_uri` | exact `https://<portal>/api/auth/kc/callback` | no wildcard, no `+` |
| `response_type` | `code` | never implicit |
| `scope` | `openid` | add `profile` only if needed |
| `state` | 256-bit random | also stored in a `__Host-` cookie and compared at the callback |
| `nonce` | 256-bit random | validated in the ID token |
| `code_challenge` / `code_challenge_method` | S256 | PKCE mandatory |
| `kc_action` | `webauthn-register-passwordless` or `CONFIGURE_RECOVERY_AUTHN_CODES` | AIA only: recovery, add-another-passkey, regenerate codes. First enrollment does **not** need it: the required action is already set on the user and runs automatically after login. |
| `enrollment_token` | E2 only, POST body | never in a URL or in JavaScript |

### 4.2 Token request (`O4`)

| Grant | Host | Body | Client auth |
|---|---|---|---|
| `authorization_code` | `kc:8443` | `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier` | Basic (confidential) or none (public + PKCE) |
| `refresh_token` | `kc:8443` | `grant_type`, `refresh_token`, `client_id` | Basic (confidential) |
| `client_credentials` | `kc-admin:8444` | `grant_type=client_credentials` | Basic `portal-admin:<secret>` |

The token response must never be logged. Do not put the `code` or tokens in a URL. The portal should validate the ID token signature with O2, then check `iss`, `aud`, `nonce`, `exp`, and `azp`.

---
## Public OIDC endpoints

| ID | Method | Host | Path | Caller | Purpose | Auth | Notes |
|---|---|---|---|---|---|---|---|
| O1 | `GET` | `kc:8443` | `/realms/{realm}/.well-known/openid-configuration` | portal backend | discovery: issuer, endpoints, algorithms | none | cache 1 h; issuer must be `https://kc.gateway-vw.de:8443/realms/{realm}` |
| O2 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/certs` | portal backend | JWKS to verify ID/access token | none | cache by `kid`; refresh on unknown `kid` |
| O3 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/auth` | **browser** | start Authorization Code flow | none (public client + PKCE) | never call from Lambda; POST is preferred for enrollment so secrets stay out of the URL |
| O4 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token` | portal backend | code exchange, refresh | Basic client auth or PKCE | see bodies below; never from browser. `client_credentials` uses the same path but **`kc-admin:8444`** (= A1) |
| O5 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/userinfo` | portal backend | `sub`, `preferred_username`, attributes | Bearer | optional if the ID token already carries the claims |
| O6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/logout` | **browser** | RP-initiated logout | session / `id_token_hint` | `post_logout_redirect_uri` must match `post.logout.redirect.uris` |
| O7 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/introspect` | portal backend | optional opaque/refresh-token validation | client auth | not needed for JWT access tokens |
| O8 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/revoke` | portal backend | optional refresh-token revocation on logout | client auth | recommended if refresh tokens are stored |
| O9 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/login-status-iframe.html` | browser | optional silent-SSO / session check | none | only if the portal uses `check-session`; the only legitimate iframe use |
| O10 | `GET` | `kc:8443` | `/realms/{realm}` | portal backend | optional realm metadata / legacy public key | none | prefer O1 + O2 |

## `login-actions` endpoints (browser only)

The browser reaches these through HTML forms generated by Keycloak. The portal must **not** construct or call them. The URL is `url.loginAction` in the theme.

| ID | Method | Host | Path | Purpose | Form fields (relevant) |
|---|---|---|---|---|---|
| L1 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?session_code=...&execution=...&client_id=...&tab_id=...` | render the current authenticator page (username, password, passkey, recovery code) | — |
| L2 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?...` | submit username, password, WebAuthn assertion, recovery code, or `tryAnotherWay=on` | `username`, `password`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, `credentialId`, `recoveryCodeInput`, `tryAnotherWay` |
| L3 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/required-action?execution=...&client_id=...&tab_id=...` | render a required action: passkey registration, recovery-codes setup | — |
| L4 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/required-action?...` | submit attestation or recovery-code confirmation | `clientDataJSON`, `attestationObject`, `publicKeyCredentialId`, `transports`, `authenticatorAttachment`, `authenticatorLabel`, `error`, `generatedRecoveryAuthnCodes`, `generatedAt`, `userLabel`, `cancel-aia` |
| L5 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/reset-credentials?client_id=...&tab_id=...` | optional forgot-password e-mail flow | `username` |
| L6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/action-token?key=...` | optional e-mail action link | token in `key` |
| L7 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/registration?client_id=...&tab_id=...` | self-registration; **disabled** in prod | — |
| L8 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/restart?client_id=...&tab_id=...` | optional "restart login" | — |
| L9 | `GET` | `kc:8443` | `/resources/{version}/...` | theme JS/CSS, including `webauthnRegister.js` and `webauthnAuthenticate.js` | — |

## Admin REST endpoints (private path only)

Base: **`https://kc-admin.gateway-vw.de:8444`** — port **8444**, not 8443.  
Only the enrollment/recovery Lambda (and the setup runner) calls these. The public tenant host `kc:8443` returns 404 for `/admin/*`, and `kc-admin:8443` must not answer at all (P12).

| ID | Method | Host | Path | Purpose | Required role |
|---|---|---|---|---|---|
| A1 | `POST` | `kc-admin:8444` | `/realms/{realm}/protocol/openid-connect/token` (`client_credentials`) | get admin access token | client `portal-admin` secret |
| A2 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users?username={verifi_id}&exact=true` | find user by opaque username | `query-users` |
| A3 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | read user, attributes, `requiredActions` | `view-users` |
| A4 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users` | create user (`username`, `enabled`, `attributes.verifi_id`, `requiredActions`) | `manage-users` |
| A5 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | set `requiredActions` and attributes | `manage-users` |
| A6 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials` | list credential `id`, `type`, `userLabel`, `createdDate` | `view-users` |
| A7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials/{credentialId}` | delete lost passkey, old recovery codes, or temporary password | `manage-users` |
| A8 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/reset-password` | set one-time password (E1) | `manage-users` |
| A9 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/execute-actions-email` | optional e-mail action link | `manage-users` + SMTP |
| A10 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/logout` | invalidate all Keycloak sessions of the user | `manage-users` |
| A11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/sessions` | optional session inspection | `view-users` |
| A12 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/sessions/{sessionId}` | optional targeted session kill | `manage-users` |
| A13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/logout-all` | optional realm-wide session kill | `manage-users` |
| A14 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/admin-events` | audit of admin actions | `view-events` |
| A15 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/events` | user events (`LOGIN`, `REMOVE_CREDENTIAL`, `UPDATE_CREDENTIAL`) | `view-events` |
| A16 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | offboarding; removes credentials | `manage-users` |

### 5.1 What L2/L4 actually do

| User action | Page rendered by | POST target |
|---|---|---|
| Enter username (recovery path) | L1 (`auth-username-form`) | L2 |
| Click "Try another way" | L1 (`template.ftl`) | L2 with `tryAnotherWay=on` |
| Enter recovery code | L1 (`auth-recovery-authn-code-form`) | L2 with `recoveryCodeInput` |
| Touch passkey / security key to **log in** | L1 (`webauthn-authenticate.ftl`) | L2 with assertion fields |
| Touch passkey / security key to **register** | L3 (`webauthn-register.ftl`) | L4 with attestation fields |
| Confirm printed recovery codes | L3 (`login-recovery-authn-code-config.ftl`) | L4 with `generatedRecoveryAuthnCodes` + `generatedAt` |
| Cancel an AIA | L3 | L4 with `cancel-aia=true` |

**Correction for tutorials and older docs:** `POST /realms/{realm}/login-actions/webauthn-register` and `/login-actions/webauthn-authenticate` are not part of the Keycloak 26.x route set. The FTL files submit to `${url.loginAction}`. Do not add these paths to nginx and do not call them from a Lambda.

### 5.2 Cookies and origin

- The passkey ceremony must run on `https://kc.gateway-vw.de:8443`; the RP ID must be a registrable suffix of that host.
- `KEYCLOAK_IDENTITY` and `KEYCLOAK_SESSION` are always `Secure`. Their `SameSite` value comes from the `spi-cookie-samesite` setting, **not** from the realm. The flows above are top-level 302 navigations, which work with `Lax`; `None` is only needed if the Keycloak page is embedded in an iframe. Verify the effective value in staging (§17 S19): if the cookie is dropped, the browser lands on the login page again with a fresh `session_code` and the flow silently restarts.
- Bootstrap the login page as a **top-level navigation**, never in an iframe. Embedding it forces `SameSite=None`, weakens CSRF defences, and breaks WebAuthn on some browsers.
- The portal's own transaction cookie must be `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax` (the callback is a cross-site top-level navigation).
- Do not proxy `login-actions` through the portal origin. That changes the WebAuthn origin and breaks RP ID/cookie semantics.

---

## 6. Admin REST endpoints (private path only)

Base: **`https://kc-admin.gateway-vw.de:8444`** — port **8444**, not 8443.  
Only the enrollment/recovery Lambda (and the setup runner) calls these. The public tenant host `kc:8443` returns 404 for `/admin/*`, and `kc-admin:8443` must not answer at all (P12).

| ID | Method | Host | Path | Purpose | Required role |
|---|---|---|---|---|---|
| A1 | `POST` | `kc-admin:8444` | `/realms/{realm}/protocol/openid-connect/token` (`client_credentials`) | get admin access token | client `portal-admin` secret |
| A2 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users?username={verifi_id}&exact=true` | find user by opaque username | `query-users` |
| A3 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | read user, attributes, `requiredActions` | `view-users` |
| A4 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users` | create user (`username`, `enabled`, `attributes.verifi_id`, `requiredActions`) | `manage-users` |
| A5 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | set `requiredActions` and attributes | `manage-users` |
| A6 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials` | list credential `id`, `type`, `userLabel`, `createdDate` | `view-users` |
| A7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials/{credentialId}` | delete lost passkey, old recovery codes, or temporary password | `manage-users` |
| A8 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/reset-password` | set one-time password (E1) | `manage-users` |
| A9 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/execute-actions-email` | optional e-mail action link | `manage-users` + SMTP |
| A10 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/logout` | invalidate all Keycloak sessions of the user | `manage-users` |
| A11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/sessions` | optional session inspection | `view-users` |
| A12 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/sessions/{sessionId}` | optional targeted session kill | `manage-users` |
| A13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/logout-all` | optional realm-wide session kill | `manage-users` |
| A14 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/admin-events` | audit of admin actions | `view-events` |
| A15 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/events` | user events (`LOGIN`, `REMOVE_CREDENTIAL`, `UPDATE_CREDENTIAL`) | `view-events` |
| A16 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | offboarding; removes credentials | `manage-users` |

### 6.1 Response and error expectations

| Endpoint | Success | Important errors |
|---|---|---|
| `A1` | `200` + `access_token`, `token_type=Bearer`, `expires_in` | `401` bad secret; `400` client not service-account enabled |
| `A2` | `200` + array (0 or 1 item with `exact=true`) | `403` missing `query-users` |
| `A4` | `201` + `Location` header; body may be empty | `409` duplicate username; `400` profile validation |
| `A5` | `204` | `400` unknown required action; `404` user |
| `A6` | `200` + array | `403` missing `view-users` |
| `A7` | `204` | `404` credential/user |
| `A8` | `204` | `400` password policy; `404` user |
| `A10` | `204` | `404` user |

### 6.2 Required-action set is replaced, not merged

`PUT /admin/realms/{realm}/users/{id}` with a `requiredActions` array **removes** any required action not in the array (Keycloak `UserResource.updateUserFromRep`, `isUpdateExistingUser=true`). Therefore every update must send the complete set:

```json
{
  "requiredActions": [
    "webauthn-register-passwordless",
    "CONFIGURE_RECOVERY_AUTHN_CODES"
  ]
}
```

`POST /admin/realms/{realm}/users` applies **only** the `requiredActions` sent in the body. Do not rely on `defaultAction: true` on `CONFIGURE_RECOVERY_AUTHN_CODES` to fill it in for REST-created users; send both actions explicitly on create and on every update, then assert them with A3 (test S12). This is finding **P1**.

---
## Public OIDC endpoints

| ID | Method | Host | Path | Caller | Purpose | Auth | Notes |
|---|---|---|---|---|---|---|---|
| O1 | `GET` | `kc:8443` | `/realms/{realm}/.well-known/openid-configuration` | portal backend | discovery: issuer, endpoints, algorithms | none | cache 1 h; issuer must be `https://kc.gateway-vw.de:8443/realms/{realm}` |
| O2 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/certs` | portal backend | JWKS to verify ID/access token | none | cache by `kid`; refresh on unknown `kid` |
| O3 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/auth` | **browser** | start Authorization Code flow | none (public client + PKCE) | never call from Lambda; POST is preferred for enrollment so secrets stay out of the URL |
| O4 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token` | portal backend | code exchange, refresh | Basic client auth or PKCE | see bodies below; never from browser. `client_credentials` uses the same path but **`kc-admin:8444`** (= A1) |
| O5 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/userinfo` | portal backend | `sub`, `preferred_username`, attributes | Bearer | optional if the ID token already carries the claims |
| O6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/logout` | **browser** | RP-initiated logout | session / `id_token_hint` | `post_logout_redirect_uri` must match `post.logout.redirect.uris` |
| O7 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/introspect` | portal backend | optional opaque/refresh-token validation | client auth | not needed for JWT access tokens |
| O8 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/revoke` | portal backend | optional refresh-token revocation on logout | client auth | recommended if refresh tokens are stored |
| O9 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/login-status-iframe.html` | browser | optional silent-SSO / session check | none | only if the portal uses `check-session`; the only legitimate iframe use |
| O10 | `GET` | `kc:8443` | `/realms/{realm}` | portal backend | optional realm metadata / legacy public key | none | prefer O1 + O2 |

## `login-actions` endpoints (browser only)

The browser reaches these through HTML forms generated by Keycloak. The portal must **not** construct or call them. The URL is `url.loginAction` in the theme.

| ID | Method | Host | Path | Purpose | Form fields (relevant) |
|---|---|---|---|---|---|
| L1 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?session_code=...&execution=...&client_id=...&tab_id=...` | render the current authenticator page (username, password, passkey, recovery code) | — |
| L2 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?...` | submit username, password, WebAuthn assertion, recovery code, or `tryAnotherWay=on` | `username`, `password`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, `credentialId`, `recoveryCodeInput`, `tryAnotherWay` |
| L3 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/required-action?execution=...&client_id=...&tab_id=...` | render a required action: passkey registration, recovery-codes setup | — |
| L4 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/required-action?...` | submit attestation or recovery-code confirmation | `clientDataJSON`, `attestationObject`, `publicKeyCredentialId`, `transports`, `authenticatorAttachment`, `authenticatorLabel`, `error`, `generatedRecoveryAuthnCodes`, `generatedAt`, `userLabel`, `cancel-aia` |
| L5 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/reset-credentials?client_id=...&tab_id=...` | optional forgot-password e-mail flow | `username` |
| L6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/action-token?key=...` | optional e-mail action link | token in `key` |
| L7 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/registration?client_id=...&tab_id=...` | self-registration; **disabled** in prod | — |
| L8 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/restart?client_id=...&tab_id=...` | optional "restart login" | — |
| L9 | `GET` | `kc:8443` | `/resources/{version}/...` | theme JS/CSS, including `webauthnRegister.js` and `webauthnAuthenticate.js` | — |

## Admin REST endpoints (private path only)

Base: **`https://kc-admin.gateway-vw.de:8444`** — port **8444**, not 8443.  
Only the enrollment/recovery Lambda (and the setup runner) calls these. The public tenant host `kc:8443` returns 404 for `/admin/*`, and `kc-admin:8443` must not answer at all (P12).

| ID | Method | Host | Path | Purpose | Required role |
|---|---|---|---|---|---|
| A1 | `POST` | `kc-admin:8444` | `/realms/{realm}/protocol/openid-connect/token` (`client_credentials`) | get admin access token | client `portal-admin` secret |
| A2 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users?username={verifi_id}&exact=true` | find user by opaque username | `query-users` |
| A3 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | read user, attributes, `requiredActions` | `view-users` |
| A4 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users` | create user (`username`, `enabled`, `attributes.verifi_id`, `requiredActions`) | `manage-users` |
| A5 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | set `requiredActions` and attributes | `manage-users` |
| A6 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials` | list credential `id`, `type`, `userLabel`, `createdDate` | `view-users` |
| A7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials/{credentialId}` | delete lost passkey, old recovery codes, or temporary password | `manage-users` |
| A8 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/reset-password` | set one-time password (E1) | `manage-users` |
| A9 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/execute-actions-email` | optional e-mail action link | `manage-users` + SMTP |
| A10 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/logout` | invalidate all Keycloak sessions of the user | `manage-users` |
| A11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/sessions` | optional session inspection | `view-users` |
| A12 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/sessions/{sessionId}` | optional targeted session kill | `manage-users` |
| A13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/logout-all` | optional realm-wide session kill | `manage-users` |
| A14 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/admin-events` | audit of admin actions | `view-events` |
| A15 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/events` | user events (`LOGIN`, `REMOVE_CREDENTIAL`, `UPDATE_CREDENTIAL`) | `view-events` |
| A16 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | offboarding; removes credentials | `manage-users` |

## 7. Setup-time endpoints (prerequisites, not runtime)

These are already used by `keycloak/realm-template.mjs`. They must be reachable from the setup runner via **`kc-admin:8444`** before any runtime flow works. The `portal-admin` client for the runtime Lambda is created here; the Lambda then uses A1 on the same host and port.

| ID | Method | Host | Path | Purpose |
|---|---|---|---|---|
| S1 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}` | read/update `frontendUrl`, WebAuthn policy, flows |
| S2 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows` | create `browser-passkey` and `recovery` sub-flow |
| S3 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | list/add executions |
| S4 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | set `REQUIRED` / `ALTERNATIVE`, priority |
| S5 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/flow` | create the `recovery` sub-flow |
| S6 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/execution` | add `auth-username-form`, `auth-recovery-authn-code-form` |
| S7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/executions/{id}` | remove stale executions |
| S8 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/authenticator-providers` | verify provider IDs |
| S9 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/required-actions[/{alias}]` | enable `webauthn-register-passwordless`, `CONFIGURE_RECOVERY_AUTHN_CODES` |
| S10 | `GET` / `POST` / `PUT` / `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/clients...` | create `portal-mock`, `portal-bootstrap`, `portal-admin`, `portal-enroll` |
| S11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/client-secret` | read/rotate `portal-admin` secret |
| S12 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/service-account-user` | resolve the service-account user |
| S13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/role-mappings/clients/{realm-management-id}` | grant `manage-users`, `view-users`, `query-users`; **no `impersonation`** |
| S14 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/profile` | allow unmanaged attributes (`verifi_id`, `idv.*`) |

### 7.1 Realm/client prerequisites that make the runtime endpoints work

| Prerequisite | Value |
|---|---|
| `frontendUrl` | `https://kc.gateway-vw.de:8443` (issuer and `url.loginAction` depend on it). **Never** `kc-admin`. |
| `--hostname` (server) | `https://kc.gateway-vw.de:8443` — fixes `iss` for every token, also for calls made through the admin vhost |
| `--hostname-admin` (server) | `https://kc-admin.gateway-vw.de:8444` — Admin Console and its static resources; does **not** restrict the Admin REST API, that is the firewall + nginx job |
| `--hostname-strict` | `true` (`--hostname` is a full URL, so this is implied); do not enable `hostname-backchannel-dynamic` |
| `webAuthnPolicyPasswordlessRpId` | `gateway-vw.de` today; narrow to `kc.gateway-vw.de` before go-live (H1) — changing later invalidates all passkeys |
| `webAuthnPolicyPasswordlessResidentKey` | `required` |
| `webAuthnPolicyPasswordlessUserVerificationRequirement` | `required` |
| `webAuthnPolicyPasswordlessSignatureAlgorithms` | `ES256`, `RS256` |
| `browser-passkey` flow | `auth-cookie` DISABLED; `webauthn-authenticator-passwordless` ALTERNATIVE (prod); `recovery` sub-flow ALTERNATIVE |
| `recovery` sub-flow | `auth-username-form` REQUIRED → `auth-recovery-authn-code-form` REQUIRED |
| Required actions | `webauthn-register-passwordless` enabled; `CONFIGURE_RECOVERY_AUTHN_CODES` enabled and default |
| Clients | `portal-mock` (passkey flow), `portal-bootstrap` (default browser flow), `portal-admin` (confidential, service account) |
| Redirect URIs | exact `https://<portal>/api/auth/kc/callback`; no wildcards |
| `post.logout.redirect.uris` | `https://<portal>/logout/verimi##https://<portal>/logout/done` |
| PKCE | `pkce.code.challenge.method=S256` on every browser client |
| Admin vhost routes | only `/admin/` and `/realms/{realm}/protocol/openid-connect/token`; everything else `404` |
| Admin vhost TLS | certificate for `kc-admin.gateway-vw.de`; router TCP forward for **8444** only |

---
## Public OIDC endpoints

| ID | Method | Host | Path | Caller | Purpose | Auth | Notes |
|---|---|---|---|---|---|---|---|
| O1 | `GET` | `kc:8443` | `/realms/{realm}/.well-known/openid-configuration` | portal backend | discovery: issuer, endpoints, algorithms | none | cache 1 h; issuer must be `https://kc.gateway-vw.de:8443/realms/{realm}` |
| O2 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/certs` | portal backend | JWKS to verify ID/access token | none | cache by `kid`; refresh on unknown `kid` |
| O3 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/auth` | **browser** | start Authorization Code flow | none (public client + PKCE) | never call from Lambda; POST is preferred for enrollment so secrets stay out of the URL |
| O4 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token` | portal backend | code exchange, refresh | Basic client auth or PKCE | see bodies below; never from browser. `client_credentials` uses the same path but **`kc-admin:8444`** (= A1) |
| O5 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/userinfo` | portal backend | `sub`, `preferred_username`, attributes | Bearer | optional if the ID token already carries the claims |
| O6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/logout` | **browser** | RP-initiated logout | session / `id_token_hint` | `post_logout_redirect_uri` must match `post.logout.redirect.uris` |
| O7 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/introspect` | portal backend | optional opaque/refresh-token validation | client auth | not needed for JWT access tokens |
| O8 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/revoke` | portal backend | optional refresh-token revocation on logout | client auth | recommended if refresh tokens are stored |
| O9 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/login-status-iframe.html` | browser | optional silent-SSO / session check | none | only if the portal uses `check-session`; the only legitimate iframe use |
| O10 | `GET` | `kc:8443` | `/realms/{realm}` | portal backend | optional realm metadata / legacy public key | none | prefer O1 + O2 |

## `login-actions` endpoints (browser only)

The browser reaches these through HTML forms generated by Keycloak. The portal must **not** construct or call them. The URL is `url.loginAction` in the theme.

| ID | Method | Host | Path | Purpose | Form fields (relevant) |
|---|---|---|---|---|---|
| L1 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?session_code=...&execution=...&client_id=...&tab_id=...` | render the current authenticator page (username, password, passkey, recovery code) | — |
| L2 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?...` | submit username, password, WebAuthn assertion, recovery code, or `tryAnotherWay=on` | `username`, `password`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, `credentialId`, `recoveryCodeInput`, `tryAnotherWay` |
| L3 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/required-action?execution=...&client_id=...&tab_id=...` | render a required action: passkey registration, recovery-codes setup | — |
| L4 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/required-action?...` | submit attestation or recovery-code confirmation | `clientDataJSON`, `attestationObject`, `publicKeyCredentialId`, `transports`, `authenticatorAttachment`, `authenticatorLabel`, `error`, `generatedRecoveryAuthnCodes`, `generatedAt`, `userLabel`, `cancel-aia` |
| L5 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/reset-credentials?client_id=...&tab_id=...` | optional forgot-password e-mail flow | `username` |
| L6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/action-token?key=...` | optional e-mail action link | token in `key` |
| L7 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/registration?client_id=...&tab_id=...` | self-registration; **disabled** in prod | — |
| L8 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/restart?client_id=...&tab_id=...` | optional "restart login" | — |
| L9 | `GET` | `kc:8443` | `/resources/{version}/...` | theme JS/CSS, including `webauthnRegister.js` and `webauthnAuthenticate.js` | — |

## Admin REST endpoints (private path only)

Base: **`https://kc-admin.gateway-vw.de:8444`** — port **8444**, not 8443.  
Only the enrollment/recovery Lambda (and the setup runner) calls these. The public tenant host `kc:8443` returns 404 for `/admin/*`, and `kc-admin:8443` must not answer at all (P12).

| ID | Method | Host | Path | Purpose | Required role |
|---|---|---|---|---|---|
| A1 | `POST` | `kc-admin:8444` | `/realms/{realm}/protocol/openid-connect/token` (`client_credentials`) | get admin access token | client `portal-admin` secret |
| A2 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users?username={verifi_id}&exact=true` | find user by opaque username | `query-users` |
| A3 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | read user, attributes, `requiredActions` | `view-users` |
| A4 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users` | create user (`username`, `enabled`, `attributes.verifi_id`, `requiredActions`) | `manage-users` |
| A5 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | set `requiredActions` and attributes | `manage-users` |
| A6 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials` | list credential `id`, `type`, `userLabel`, `createdDate` | `view-users` |
| A7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials/{credentialId}` | delete lost passkey, old recovery codes, or temporary password | `manage-users` |
| A8 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/reset-password` | set one-time password (E1) | `manage-users` |
| A9 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/execute-actions-email` | optional e-mail action link | `manage-users` + SMTP |
| A10 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/logout` | invalidate all Keycloak sessions of the user | `manage-users` |
| A11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/sessions` | optional session inspection | `view-users` |
| A12 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/sessions/{sessionId}` | optional targeted session kill | `manage-users` |
| A13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/logout-all` | optional realm-wide session kill | `manage-users` |
| A14 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/admin-events` | audit of admin actions | `view-events` |
| A15 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/events` | user events (`LOGIN`, `REMOVE_CREDENTIAL`, `UPDATE_CREDENTIAL`) | `view-events` |
| A16 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | offboarding; removes credentials | `manage-users` |

## 7. Setup-time endpoints (prerequisites, not runtime)

These are already used by `keycloak/realm-template.mjs`. They must be reachable from the setup runner via **`kc-admin:8444`** before any runtime flow works. The `portal-admin` client for the runtime Lambda is created here; the Lambda then uses A1 on the same host and port.

| ID | Method | Host | Path | Purpose |
|---|---|---|---|---|
| S1 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}` | read/update `frontendUrl`, WebAuthn policy, flows |
| S2 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows` | create `browser-passkey` and `recovery` sub-flow |
| S3 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | list/add executions |
| S4 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | set `REQUIRED` / `ALTERNATIVE`, priority |
| S5 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/flow` | create the `recovery` sub-flow |
| S6 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/execution` | add `auth-username-form`, `auth-recovery-authn-code-form` |
| S7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/executions/{id}` | remove stale executions |
| S8 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/authenticator-providers` | verify provider IDs |
| S9 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/required-actions[/{alias}]` | enable `webauthn-register-passwordless`, `CONFIGURE_RECOVERY_AUTHN_CODES` |
| S10 | `GET` / `POST` / `PUT` / `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/clients...` | create `portal-mock`, `portal-bootstrap`, `portal-admin`, `portal-enroll` |
| S11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/client-secret` | read/rotate `portal-admin` secret |
| S12 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/service-account-user` | resolve the service-account user |
| S13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/role-mappings/clients/{realm-management-id}` | grant `manage-users`, `view-users`, `query-users`; **no `impersonation`** |
| S14 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/profile` | allow unmanaged attributes (`verifi_id`, `idv.*`) |

## 8. Optional: brokering the IDV (Decision 1, Option A)

Only if Verimi (or the replacement IDV) supports OIDC or SAML login. This removes the Lambda user-creation path.

| ID | Method | Host | Path | Purpose |
|---|---|---|---|---|
| B1 | `GET` | `kc:8443` | `/realms/{realm}/broker/{alias}/login` | browser starts IDV login |
| B2 | `GET` / `POST` | `kc:8443` | `/realms/{realm}/broker/{alias}/endpoint` | IDV callback to Keycloak |
| B3 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/first-broker-login` | first login: link or create user |
| B4 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/post-broker-login` | post-broker step |
| B5 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/identity-provider/instances...` | setup only |

The IDV redirect URI registered at Verimi is `https://kc.gateway-vw.de:8443/realms/{realm}/broker/{alias}/endpoint` — never the admin host; Verimi's servers are not on the firewall allowlist.

With Option A, the first broker login creates the user, then `webauthn-register-passwordless` + `CONFIGURE_RECOVERY_AUTHN_CODES` run as required actions. The Admin REST endpoints A2–A9 are then only needed for recovery, not for enrollment.

---
## Public OIDC endpoints

| ID | Method | Host | Path | Caller | Purpose | Auth | Notes |
|---|---|---|---|---|---|---|---|
| O1 | `GET` | `kc:8443` | `/realms/{realm}/.well-known/openid-configuration` | portal backend | discovery: issuer, endpoints, algorithms | none | cache 1 h; issuer must be `https://kc.gateway-vw.de:8443/realms/{realm}` |
| O2 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/certs` | portal backend | JWKS to verify ID/access token | none | cache by `kid`; refresh on unknown `kid` |
| O3 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/auth` | **browser** | start Authorization Code flow | none (public client + PKCE) | never call from Lambda; POST is preferred for enrollment so secrets stay out of the URL |
| O4 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token` | portal backend | code exchange, refresh | Basic client auth or PKCE | see bodies below; never from browser. `client_credentials` uses the same path but **`kc-admin:8444`** (= A1) |
| O5 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/userinfo` | portal backend | `sub`, `preferred_username`, attributes | Bearer | optional if the ID token already carries the claims |
| O6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/logout` | **browser** | RP-initiated logout | session / `id_token_hint` | `post_logout_redirect_uri` must match `post.logout.redirect.uris` |
| O7 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/introspect` | portal backend | optional opaque/refresh-token validation | client auth | not needed for JWT access tokens |
| O8 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/revoke` | portal backend | optional refresh-token revocation on logout | client auth | recommended if refresh tokens are stored |
| O9 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/login-status-iframe.html` | browser | optional silent-SSO / session check | none | only if the portal uses `check-session`; the only legitimate iframe use |
| O10 | `GET` | `kc:8443` | `/realms/{realm}` | portal backend | optional realm metadata / legacy public key | none | prefer O1 + O2 |

## `login-actions` endpoints (browser only)

The browser reaches these through HTML forms generated by Keycloak. The portal must **not** construct or call them. The URL is `url.loginAction` in the theme.

| ID | Method | Host | Path | Purpose | Form fields (relevant) |
|---|---|---|---|---|---|
| L1 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?session_code=...&execution=...&client_id=...&tab_id=...` | render the current authenticator page (username, password, passkey, recovery code) | — |
| L2 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?...` | submit username, password, WebAuthn assertion, recovery code, or `tryAnotherWay=on` | `username`, `password`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, `credentialId`, `recoveryCodeInput`, `tryAnotherWay` |
| L3 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/required-action?execution=...&client_id=...&tab_id=...` | render a required action: passkey registration, recovery-codes setup | — |
| L4 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/required-action?...` | submit attestation or recovery-code confirmation | `clientDataJSON`, `attestationObject`, `publicKeyCredentialId`, `transports`, `authenticatorAttachment`, `authenticatorLabel`, `error`, `generatedRecoveryAuthnCodes`, `generatedAt`, `userLabel`, `cancel-aia` |
| L5 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/reset-credentials?client_id=...&tab_id=...` | optional forgot-password e-mail flow | `username` |
| L6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/action-token?key=...` | optional e-mail action link | token in `key` |
| L7 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/registration?client_id=...&tab_id=...` | self-registration; **disabled** in prod | — |
| L8 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/restart?client_id=...&tab_id=...` | optional "restart login" | — |
| L9 | `GET` | `kc:8443` | `/resources/{version}/...` | theme JS/CSS, including `webauthnRegister.js` and `webauthnAuthenticate.js` | — |

## Admin REST endpoints (private path only)

Base: **`https://kc-admin.gateway-vw.de:8444`** — port **8444**, not 8443.  
Only the enrollment/recovery Lambda (and the setup runner) calls these. The public tenant host `kc:8443` returns 404 for `/admin/*`, and `kc-admin:8443` must not answer at all (P12).

| ID | Method | Host | Path | Purpose | Required role |
|---|---|---|---|---|---|
| A1 | `POST` | `kc-admin:8444` | `/realms/{realm}/protocol/openid-connect/token` (`client_credentials`) | get admin access token | client `portal-admin` secret |
| A2 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users?username={verifi_id}&exact=true` | find user by opaque username | `query-users` |
| A3 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | read user, attributes, `requiredActions` | `view-users` |
| A4 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users` | create user (`username`, `enabled`, `attributes.verifi_id`, `requiredActions`) | `manage-users` |
| A5 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | set `requiredActions` and attributes | `manage-users` |
| A6 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials` | list credential `id`, `type`, `userLabel`, `createdDate` | `view-users` |
| A7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials/{credentialId}` | delete lost passkey, old recovery codes, or temporary password | `manage-users` |
| A8 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/reset-password` | set one-time password (E1) | `manage-users` |
| A9 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/execute-actions-email` | optional e-mail action link | `manage-users` + SMTP |
| A10 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/logout` | invalidate all Keycloak sessions of the user | `manage-users` |
| A11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/sessions` | optional session inspection | `view-users` |
| A12 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/sessions/{sessionId}` | optional targeted session kill | `manage-users` |
| A13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/logout-all` | optional realm-wide session kill | `manage-users` |
| A14 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/admin-events` | audit of admin actions | `view-events` |
| A15 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/events` | user events (`LOGIN`, `REMOVE_CREDENTIAL`, `UPDATE_CREDENTIAL`) | `view-events` |
| A16 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | offboarding; removes credentials | `manage-users` |

## 7. Setup-time endpoints (prerequisites, not runtime)

These are already used by `keycloak/realm-template.mjs`. They must be reachable from the setup runner via **`kc-admin:8444`** before any runtime flow works. The `portal-admin` client for the runtime Lambda is created here; the Lambda then uses A1 on the same host and port.

| ID | Method | Host | Path | Purpose |
|---|---|---|---|---|
| S1 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}` | read/update `frontendUrl`, WebAuthn policy, flows |
| S2 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows` | create `browser-passkey` and `recovery` sub-flow |
| S3 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | list/add executions |
| S4 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | set `REQUIRED` / `ALTERNATIVE`, priority |
| S5 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/flow` | create the `recovery` sub-flow |
| S6 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/execution` | add `auth-username-form`, `auth-recovery-authn-code-form` |
| S7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/executions/{id}` | remove stale executions |
| S8 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/authenticator-providers` | verify provider IDs |
| S9 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/required-actions[/{alias}]` | enable `webauthn-register-passwordless`, `CONFIGURE_RECOVERY_AUTHN_CODES` |
| S10 | `GET` / `POST` / `PUT` / `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/clients...` | create `portal-mock`, `portal-bootstrap`, `portal-admin`, `portal-enroll` |
| S11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/client-secret` | read/rotate `portal-admin` secret |
| S12 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/service-account-user` | resolve the service-account user |
| S13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/role-mappings/clients/{realm-management-id}` | grant `manage-users`, `view-users`, `query-users`; **no `impersonation`** |
| S14 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/profile` | allow unmanaged attributes (`verifi_id`, `idv.*`) |

### 7.1 Realm/client prerequisites that make the runtime endpoints work

| Prerequisite | Value |
|---|---|
| `frontendUrl` | `https://kc.gateway-vw.de:8443` (issuer and `url.loginAction` depend on it). **Never** `kc-admin`. |
| `--hostname` (server) | `https://kc.gateway-vw.de:8443` — fixes `iss` for every token, also for calls made through the admin vhost |
| `--hostname-admin` (server) | `https://kc-admin.gateway-vw.de:8444` — Admin Console and its static resources; does **not** restrict the Admin REST API, that is the firewall + nginx job |
| `--hostname-strict` | `true` (`--hostname` is a full URL, so this is implied); do not enable `hostname-backchannel-dynamic` |
| `webAuthnPolicyPasswordlessRpId` | `gateway-vw.de` today; narrow to `kc.gateway-vw.de` before go-live (H1) — changing later invalidates all passkeys |
| `webAuthnPolicyPasswordlessResidentKey` | `required` |
| `webAuthnPolicyPasswordlessUserVerificationRequirement` | `required` |
| `webAuthnPolicyPasswordlessSignatureAlgorithms` | `ES256`, `RS256` |
| `browser-passkey` flow | `auth-cookie` DISABLED; `webauthn-authenticator-passwordless` ALTERNATIVE (prod); `recovery` sub-flow ALTERNATIVE |
| `recovery` sub-flow | `auth-username-form` REQUIRED → `auth-recovery-authn-code-form` REQUIRED |
| Required actions | `webauthn-register-passwordless` enabled; `CONFIGURE_RECOVERY_AUTHN_CODES` enabled and default |
| Clients | `portal-mock` (passkey flow), `portal-bootstrap` (default browser flow), `portal-admin` (confidential, service account) |
| Redirect URIs | exact `https://<portal>/api/auth/kc/callback`; no wildcards |
| `post.logout.redirect.uris` | `https://<portal>/logout/verimi##https://<portal>/logout/done` |
| PKCE | `pkce.code.challenge.method=S256` on every browser client |
| Admin vhost routes | only `/admin/` and `/realms/{realm}/protocol/openid-connect/token`; everything else `404` |
| Admin vhost TLS | certificate for `kc-admin.gateway-vw.de`; router TCP forward for **8444** only |

---
## Public OIDC endpoints

| ID | Method | Host | Path | Caller | Purpose | Auth | Notes |
|---|---|---|---|---|---|---|---|
| O1 | `GET` | `kc:8443` | `/realms/{realm}/.well-known/openid-configuration` | portal backend | discovery: issuer, endpoints, algorithms | none | cache 1 h; issuer must be `https://kc.gateway-vw.de:8443/realms/{realm}` |
| O2 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/certs` | portal backend | JWKS to verify ID/access token | none | cache by `kid`; refresh on unknown `kid` |
| O3 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/auth` | **browser** | start Authorization Code flow | none (public client + PKCE) | never call from Lambda; POST is preferred for enrollment so secrets stay out of the URL |
| O4 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token` | portal backend | code exchange, refresh | Basic client auth or PKCE | see bodies below; never from browser. `client_credentials` uses the same path but **`kc-admin:8444`** (= A1) |
| O5 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/userinfo` | portal backend | `sub`, `preferred_username`, attributes | Bearer | optional if the ID token already carries the claims |
| O6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/logout` | **browser** | RP-initiated logout | session / `id_token_hint` | `post_logout_redirect_uri` must match `post.logout.redirect.uris` |
| O7 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/introspect` | portal backend | optional opaque/refresh-token validation | client auth | not needed for JWT access tokens |
| O8 | `POST` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/token/revoke` | portal backend | optional refresh-token revocation on logout | client auth | recommended if refresh tokens are stored |
| O9 | `GET` | `kc:8443` | `/realms/{realm}/protocol/openid-connect/login-status-iframe.html` | browser | optional silent-SSO / session check | none | only if the portal uses `check-session`; the only legitimate iframe use |
| O10 | `GET` | `kc:8443` | `/realms/{realm}` | portal backend | optional realm metadata / legacy public key | none | prefer O1 + O2 |

## `login-actions` endpoints (browser only)

The browser reaches these through HTML forms generated by Keycloak. The portal must **not** construct or call them. The URL is `url.loginAction` in the theme.

| ID | Method | Host | Path | Purpose | Form fields (relevant) |
|---|---|---|---|---|---|
| L1 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?session_code=...&execution=...&client_id=...&tab_id=...` | render the current authenticator page (username, password, passkey, recovery code) | — |
| L2 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/authenticate?...` | submit username, password, WebAuthn assertion, recovery code, or `tryAnotherWay=on` | `username`, `password`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, `credentialId`, `recoveryCodeInput`, `tryAnotherWay` |
| L3 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/required-action?execution=...&client_id=...&tab_id=...` | render a required action: passkey registration, recovery-codes setup | — |
| L4 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/required-action?...` | submit attestation or recovery-code confirmation | `clientDataJSON`, `attestationObject`, `publicKeyCredentialId`, `transports`, `authenticatorAttachment`, `authenticatorLabel`, `error`, `generatedRecoveryAuthnCodes`, `generatedAt`, `userLabel`, `cancel-aia` |
| L5 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/reset-credentials?client_id=...&tab_id=...` | optional forgot-password e-mail flow | `username` |
| L6 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/action-token?key=...` | optional e-mail action link | token in `key` |
| L7 | `GET` or `POST` | `kc:8443` | `/realms/{realm}/login-actions/registration?client_id=...&tab_id=...` | self-registration; **disabled** in prod | — |
| L8 | `GET` | `kc:8443` | `/realms/{realm}/login-actions/restart?client_id=...&tab_id=...` | optional "restart login" | — |
| L9 | `GET` | `kc:8443` | `/resources/{version}/...` | theme JS/CSS, including `webauthnRegister.js` and `webauthnAuthenticate.js` | — |

## Admin REST endpoints (private path only)

Base: **`https://kc-admin.gateway-vw.de:8444`** — port **8444**, not 8443.  
Only the enrollment/recovery Lambda (and the setup runner) calls these. The public tenant host `kc:8443` returns 404 for `/admin/*`, and `kc-admin:8443` must not answer at all (P12).

| ID | Method | Host | Path | Purpose | Required role |
|---|---|---|---|---|---|
| A1 | `POST` | `kc-admin:8444` | `/realms/{realm}/protocol/openid-connect/token` (`client_credentials`) | get admin access token | client `portal-admin` secret |
| A2 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users?username={verifi_id}&exact=true` | find user by opaque username | `query-users` |
| A3 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | read user, attributes, `requiredActions` | `view-users` |
| A4 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users` | create user (`username`, `enabled`, `attributes.verifi_id`, `requiredActions`) | `manage-users` |
| A5 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | set `requiredActions` and attributes | `manage-users` |
| A6 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials` | list credential `id`, `type`, `userLabel`, `createdDate` | `view-users` |
| A7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/credentials/{credentialId}` | delete lost passkey, old recovery codes, or temporary password | `manage-users` |
| A8 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/reset-password` | set one-time password (E1) | `manage-users` |
| A9 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/execute-actions-email` | optional e-mail action link | `manage-users` + SMTP |
| A10 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/logout` | invalidate all Keycloak sessions of the user | `manage-users` |
| A11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/sessions` | optional session inspection | `view-users` |
| A12 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/sessions/{sessionId}` | optional targeted session kill | `manage-users` |
| A13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/logout-all` | optional realm-wide session kill | `manage-users` |
| A14 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/admin-events` | audit of admin actions | `view-events` |
| A15 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/events` | user events (`LOGIN`, `REMOVE_CREDENTIAL`, `UPDATE_CREDENTIAL`) | `view-events` |
| A16 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}` | offboarding; removes credentials | `manage-users` |

## 7. Setup-time endpoints (prerequisites, not runtime)

These are already used by `keycloak/realm-template.mjs`. They must be reachable from the setup runner via **`kc-admin:8444`** before any runtime flow works. The `portal-admin` client for the runtime Lambda is created here; the Lambda then uses A1 on the same host and port.

| ID | Method | Host | Path | Purpose |
|---|---|---|---|---|
| S1 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}` | read/update `frontendUrl`, WebAuthn policy, flows |
| S2 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows` | create `browser-passkey` and `recovery` sub-flow |
| S3 | `GET` / `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | list/add executions |
| S4 | `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions` | set `REQUIRED` / `ALTERNATIVE`, priority |
| S5 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/flow` | create the `recovery` sub-flow |
| S6 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/flows/{alias}/executions/execution` | add `auth-username-form`, `auth-recovery-authn-code-form` |
| S7 | `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/executions/{id}` | remove stale executions |
| S8 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/authenticator-providers` | verify provider IDs |
| S9 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/authentication/required-actions[/{alias}]` | enable `webauthn-register-passwordless`, `CONFIGURE_RECOVERY_AUTHN_CODES` |
| S10 | `GET` / `POST` / `PUT` / `DELETE` | `kc-admin:8444` | `/admin/realms/{realm}/clients...` | create `portal-mock`, `portal-bootstrap`, `portal-admin`, `portal-enroll` |
| S11 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/client-secret` | read/rotate `portal-admin` secret |
| S12 | `GET` | `kc-admin:8444` | `/admin/realms/{realm}/clients/{id}/service-account-user` | resolve the service-account user |
| S13 | `POST` | `kc-admin:8444` | `/admin/realms/{realm}/users/{id}/role-mappings/clients/{realm-management-id}` | grant `manage-users`, `view-users`, `query-users`; **no `impersonation`** |
| S14 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/users/profile` | allow unmanaged attributes (`verifi_id`, `idv.*`) |

## 8. Optional: brokering the IDV (Decision 1, Option A)

Only if Verimi (or the replacement IDV) supports OIDC or SAML login. This removes the Lambda user-creation path.

| ID | Method | Host | Path | Purpose |
|---|---|---|---|---|
| B1 | `GET` | `kc:8443` | `/realms/{realm}/broker/{alias}/login` | browser starts IDV login |
| B2 | `GET` / `POST` | `kc:8443` | `/realms/{realm}/broker/{alias}/endpoint` | IDV callback to Keycloak |
| B3 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/first-broker-login` | first login: link or create user |
| B4 | `POST` | `kc:8443` | `/realms/{realm}/login-actions/post-broker-login` | post-broker step |
| B5 | `GET` / `PUT` | `kc-admin:8444` | `/admin/realms/{realm}/identity-provider/instances...` | setup only |

The IDV redirect URI registered at Verimi is `https://kc.gateway-vw.de:8443/realms/{realm}/broker/{alias}/endpoint` — never the admin host; Verimi's servers are not on the firewall allowlist.

With Option A, the first broker login creates the user, then `webauthn-register-passwordless` + `CONFIGURE_RECOVERY_AUTHN_CODES` run as required actions. The Admin REST endpoints A2–A9 are then only needed for recovery, not for enrollment.

## 9. Endpoints that must not be exposed or used

| Path / feature | Reason |
|---|---|
| `/admin/*` on `kc:8443` | admin API must be private; public host returns 404 |
| `/admin/*` on `kc-admin:8443` | this vhost must not exist at all; only 8444 is configured (P12) |
| `/realms/{realm}/account/*` | self-service console; currently denied by the allowlist. It is **not** a recovery path: a user without a passkey cannot log in to reach it |
| `/realms/{realm}/clients-registrations/*` | dynamic client registration; not used |
| `/realms/{realm}/broker/*` | only if Option A is chosen |
| `/realms/{realm}/device/*` | device authorization grant; not used |
| `/realms/{realm}/ext/*` | extensions; not used |
| `/realms/{realm}/protocol/openid-connect/registrations` | self-registration; `registrationAllowed:false` |
| `grant_type=password` | direct access grants disabled; never re-enable |
| `POST /admin/realms/{realm}/users/{id}/impersonation` | design blocker (C5); remove the `impersonation` role |
| `POST /login-actions/webauthn-register`, `/webauthn-authenticate` | do not exist in Keycloak 26.x |
| `/realms/master/*` | master realm must never be reachable through tenant hosts |

### 9.1 Vhost allowlists (planned)

`kc:8443` — allow only:

```text
/realms/{realm}/.well-known/
/realms/{realm}/protocol/openid-connect/auth
/realms/{realm}/protocol/openid-connect/token
/realms/{realm}/protocol/openid-connect/certs
/realms/{realm}/protocol/openid-connect/userinfo
/realms/{realm}/protocol/openid-connect/logout
/realms/{realm}/login-actions/
/resources/
```

Deny `account`, `clients-registrations`, `broker` (unless Option A), `device`, `ext`, `protocol/openid-connect/token/introspect`, `protocol/openid-connect/token/revoke` (unless used), and anything under `/admin/`.

`kc-admin:8444` — allow only:

```text
/admin/realms/{realm}/
/realms/{realm}/protocol/openid-connect/token
```

Deny everything else, including `/admin/realms/master/`, all browser flows (`/protocol/openid-connect/auth`, `/login-actions/`, `/resources/`), and the Admin Console HTML (`/admin/`, `/admin/master/console/`) if the console is not needed in production. The port is forwarded on the router **only** to this vhost; the source filter is an IONOS firewall rule (AWS egress), not `MGMT_CIDR`.

---

## 10. Task 1 — user creates a passkey

### 10.1 Prerequisites

| Check | Endpoint | Pass condition |
|---|---|---|
| User exists or can be created | A2, A4 | one user with `username = verifi_id` |
| User has no usable passkey (or policy allows another) | A6 | decide: `alreadyEnrolled` vs "add another passkey" |
| Required actions are set | A5, A3 | `webauthn-register-passwordless` and `CONFIGURE_RECOVERY_AUTHN_CODES` present |
| Client/flow/RP ID are correct | S1, S10 | `portal-bootstrap`/`portal-enroll`; `browser-passkey`; RP ID matches origin |
| Admin path works | A1 on `kc-admin:8444` | `200` from `client_credentials` |

### 10.2 Sequence (variant E1, one-time password)

| Step | Actor | Host | Call | Result |
|---|---|---|---|---|
| 1 | Browser → portal | — | portal-specific "Passkey einrichten" | portal session checked |
| 2 | Portal → Lambda | — | IAM invoke `{action:"enroll", verifiId}` | no public URL |
| 3 | Lambda → Keycloak | `kc-admin:8444` | `POST /realms/{realm}/protocol/openid-connect/token` (`client_credentials`) | admin token |
| 4 | Lambda → Keycloak | `kc-admin:8444` | `GET /admin/.../users?username={verifi_id}&exact=true` | user or empty |
| 5 | Lambda → Keycloak | `kc-admin:8444` | `POST /admin/.../users` (if absent) | `201`; user id from `Location` |
| 6 | Lambda → Keycloak | `kc-admin:8444` | `GET /admin/.../users/{id}/credentials` | `webauthn-passwordless` / `recovery-authn-codes` state |
| 7 | Lambda → Keycloak | `kc-admin:8444` | `PUT /admin/.../users/{id}` with **both** required actions | `204` |
| 8 | Lambda → Keycloak | `kc-admin:8444` | `PUT /admin/.../users/{id}/reset-password` (`temporary:false`, 20 random chars) | `204` |
| 9 | Portal → browser | — | show the one-time password once | never in a URL, never logged |
| 10 | Browser → Keycloak | `kc:8443` | `GET /realms/{realm}/protocol/openid-connect/auth` (`portal-bootstrap`, PKCE, state, nonce, exact callback) | login page |
| 11 | Browser → Keycloak | `kc:8443` | `POST /realms/{realm}/login-actions/authenticate` (username + one-time password) | session cookies set on the browser response |
| 12 | Browser → Keycloak | `kc:8443` | `GET /realms/{realm}/login-actions/required-action` (passkey registration page) | challenge embedded in the page |
| 13 | Browser → Keycloak | `kc:8443` | `POST /realms/{realm}/login-actions/required-action` (attestation) | passkey stored |
| 14 | Browser → Keycloak | `kc:8443` | `GET` then `POST /realms/{realm}/login-actions/required-action` (recovery-codes setup) | 12 codes stored |
| 15 | Keycloak → browser | `kc:8443` | `302 https://<portal>/api/auth/kc/callback?code=...&state=...` | callback |
| 16 | Portal backend → Keycloak | `kc:8443` | `POST /realms/{realm}/protocol/openid-connect/token` (`authorization_code`, `code_verifier`) | ID/access/refresh token |
| 17 | Portal backend → Keycloak | `kc:8443` | `GET /realms/{realm}/protocol/openid-connect/userinfo` | `sub`, `preferred_username` |
| 18 | Portal → Lambda | — | IAM invoke `{action:"complete", verifiId}` | cleanup |
| 19 | Lambda → Keycloak | `kc-admin:8444` | `GET .../credentials`; `DELETE .../credentials/{passwordId}` | password gone; passkey + recovery codes remain |
| 20 | Portal backend | — | create the portal session; audit | done |

### 10.3 Variant E2 (KMS-signed enrollment token)

Differences from E1:

| Step | E1 | E2 |
|---|---|---|
| User creation | Lambda Admin REST | custom `enrollment-token` authenticator creates the user |
| First factor | one-time password (`A8`) | KMS-signed 120 s single-use token in the `enrollment_token` POST body |
| Client | `portal-bootstrap` | `portal-enroll` (confidential, PKCE S256) |
| Admin API | required, `kc-admin:8444` | **not required** for enrollment (only for recovery/cleanup, still `kc-admin:8444`) |
| Password cleanup | required (`A7`) | none |
| Keycloak changes | none | Java SPI `enrollment-token` in `keycloak/providers/` |

E2 is the better long-term design because it removes the password and the Admin API from the enrollment path. It still needs `login-actions/authenticate` (or `required-action`) on `kc:8443` for the browser session and the WebAuthn ceremony.

### 10.4 Failure modes

| Failure | Symptom | Fix |
|---|---|---|
| Required actions set to only `webauthn-register-passwordless` | recovery codes never offered; task 3 fails | send both actions (P1) |
| `frontendUrl` wrong | `iss` mismatch; `url.loginAction` points to the wrong host | set `frontendUrl`; re-run discovery test |
| Lambda uses `:8443` or the public host for `/admin` | `404` from nginx (correct) or, worse, a working public admin path | hardcode `kc-admin:8444`; assert S13/S14 |
| Admin host reachable only from an IP that is not the Lambda egress | `connect timeout` on A1, everything else fine | static AWS egress (NAT EIP) + IONOS firewall rule; health check |
| RP ID not an effective domain of the origin | browser rejects `navigator.credentials.create` | align `webAuthnPolicyPasswordlessRpId` |
| Password left after abandon | valid one-time password remains | E2, or cleanup job (P4) |
| Lambda calls `login-actions` | cookies stop at Lambda | never do it (V3) |
| `POST /users` body expected to return the user | no `id` in body | parse `Location` or re-query with A2 |

---

## 11. Task 2 — login with the passkey

### 11.1 Prerequisites

| Check | Endpoint | Pass condition |
|---|---|---|
| User has a passkey | A6 (admin) | at least one `webauthn-passwordless` credential |
| `portal-mock` bound to `browser-passkey` | S10 / S1 | client `authenticationFlowBindingOverrides.browser` points to the flow |
| WebAuthn authenticator is reachable | S9 | enabled; `auth-cookie` DISABLED (deliberate: no silent SSO) |
| RP ID matches the origin | S1 | `gateway-vw.de` or `kc.gateway-vw.de` |
| Portal callback is exact | S10 | registered redirect URI equals the implementation |

### 11.2 Sequence

| Step | Actor | Host | Call | Result |
|---|---|---|---|---|
| 1 | Browser → Keycloak | `kc:8443` | `GET /realms/{realm}/protocol/openid-connect/auth` (`portal-mock`, PKCE, state, nonce) | passkey page |
| 2 | Browser | — | `navigator.credentials.get()` with the embedded challenge | assertion (private key never leaves the authenticator) |
| 3 | Browser → Keycloak | `kc:8443` | `POST /realms/{realm}/login-actions/authenticate` with `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, credential id | signature verified; session cookies set |
| 4 | Keycloak → browser | `kc:8443` | `302 https://<portal>/api/auth/kc/callback?code=...&state=...` | callback |
| 5 | Portal backend → Keycloak | `kc:8443` | `POST /realms/{realm}/protocol/openid-connect/token` (`authorization_code` + `code_verifier`) | tokens |
| 6 | Portal backend → Keycloak | `kc:8443` | `GET /realms/{realm}/protocol/openid-connect/userinfo` (or verify JWT with `certs`) | `sub`, `preferred_username` |
| 7 | Portal backend | — | validate `iss`, `aud`, `nonce`, `exp`; create portal session | done |
| 8 | Browser → Keycloak (logout) | `kc:8443` | `GET /realms/{realm}/protocol/openid-connect/logout?id_token_hint=...&post_logout_redirect_uri=...` | Keycloak session ended; portal clears its cookie |
| 9 | Portal backend (optional) | `kc:8443` | `POST /realms/{realm}/protocol/openid-connect/token/revoke` | refresh token revoked |

### 11.3 Username-first vs username-less

| Mode | `allowCredentials` | Endpoints | Trade-off |
|---|---|---|---|
| Username-less (current) | empty | same | fastest, but on a shared device the picker can show credentials from other tenants (H1) |
| Username-first (recommended) | list of the user's credential ids | same (extra username step on L1/L2) | no cross-tenant picker; one extra page |

The endpoint set does not change. Only the flow configuration and the browser options change. Decide before go-live, because changing the RP ID later invalidates all passkeys.

### 11.4 Failure modes

| Failure | Symptom | Fix |
|---|---|---|
| `auth-cookie` enabled | user is logged in without a passkey | keep DISABLED in `browser-passkey` |
| Wrong client (`portal-bootstrap`) | password form instead of passkey | use `portal-mock` / target `portal-login` |
| `state` not bound to the browser | login CSRF | `__Host-` cookie, one-time compare |
| PKCE verifier lost | `invalid_grant` at token endpoint | store the verifier in a `__Host-` cookie, not in Lambda memory |
| JWKS cached forever | signature failures after key rotation | cache by `kid`; refresh on miss |
| Lambda token exchange rate-limited | `429` from nginx | separate token-endpoint limit (H3) |

---

## 12. Task 3 — recover a lost passkey

### 12.1 What "recover" can and cannot mean

| Option | Recoverable? | Why |
|---|---|---|
| Private key from the authenticator | **No** | non-exportable by design |
| Synced passkey (iCloud Keychain, Google Password Manager) | platform-dependent | outside Keycloak; if sync works, the user logs in normally |
| Second passkey (backup security key) | yes | register two passkeys at enrollment; log in with the backup |
| Recovery codes | yes, self-service | proves possession of the printed codes; then register a new passkey |
| Portal-initiated reset | yes, assisted | portal session is the root of trust; Lambda deletes the dead credential and re-enrolls |
| Account Console | no | requires a Keycloak session; a user without a passkey cannot reach it |

**Design recommendation:** register **two** passkeys (e.g., phone + security key) and recovery codes at enrollment. That reduces the recovery path to "use the backup", which is the least risky.

### 12.2 Path A — recovery codes (self-service, no Admin API)

Prerequisite: `CONFIGURE_RECOVERY_AUTHN_CODES` ran at enrollment; the user still has the printed codes and the Kennung.

| Step | Actor | Host | Call | Result |
|---|---|---|---|---|
| 1 | Browser → Keycloak | `kc:8443` | `GET /realms/{realm}/protocol/openid-connect/auth` (`portal-mock`, PKCE, state, nonce) | passkey page |
| 2 | Browser → Keycloak | `kc:8443` | `POST /realms/{realm}/login-actions/authenticate` with `tryAnotherWay=on` | alternatives list |
| 3 | Browser → Keycloak | `kc:8443` | `POST /realms/{realm}/login-actions/authenticate` with `username={verifi_id}` | recovery-code page |
| 4 | Browser → Keycloak | `kc:8443` | `POST /realms/{realm}/login-actions/authenticate` with `recoveryCodeInput` | session created; code consumed |
| 5 | Browser → Keycloak | `kc:8443` | `GET` then `POST /realms/{realm}/login-actions/required-action` (`webauthn-register-passwordless`) | new passkey stored |
| 6 | Browser → Keycloak | `kc:8443` | second `/auth` with `kc_action=CONFIGURE_RECOVERY_AUTHN_CODES`, then `GET`/`POST /login-actions/required-action` | new recovery-code sheet; the old sheet is invalidated |
| 7 | Keycloak → browser | `kc:8443` | `302 callback?code&state` | callback |
| 8 | Portal backend → Keycloak | `kc:8443` | `POST /token` + `GET /userinfo` | portal session |
| 9 | Portal backend | `kc-admin:8444` | optionally call Lambda to delete the old credential | clean credential list |

Steps 5–6 need no Admin API, but only step 5 is automatic: `webauthn-register-passwordless` is still set on the user from enrollment. Step 6 is **not** auto-triggered (`RecoveryAuthnCodesAction.evaluateTriggers` is empty); it needs the second `/auth` with `kc_action`, or — if the Admin API is reachable on `kc-admin:8444` — `PUT /admin/.../users/{id}` (A5) with both actions before step 1, which makes step 6 unnecessary.

**Important:** step 6 is optional. After one code is consumed, the remaining eleven codes stay valid, so a user who still has the sheet does not need a new one. Regenerate only when the sheet is lost or suspected compromised — regeneration invalidates the rest of the old sheet.

**Important:** `kc_action` accepts **one** action per authorization request (`AuthorizationEndpoint.performActionOnParameters` splits only on `:` for the action parameter). Two AIA steps therefore mean two `/auth` redirects, or — better — set both as required actions via A5 so both run in the same login.

**Important:** regenerating codes **overwrites** the existing `recovery-authn-codes` credential (`CredentialHelper.createRecoveryCodesCredential` → `credentialManager.updateCredential`). The old sheet stops working at that moment. Never regenerate before the user has authenticated; print/download the new sheet before the redirect.

**Important:** the AIA skip only exists as an explicit action parameter, e.g. `kc_action=webauthn-register-passwordless:skip_if_exists` (`WebAuthnRegister.requiredActionChallenge`, inherited by `WebAuthnPasswordlessRegister`). Without it, registration always runs, even if a passkey already exists — which is exactly what recovery needs.

**Important:** "Try another way" is rendered only when the WebAuthn authenticator is `ALTERNATIVE` and a second branch exists. The current prod flow does this; the dev flow (`REQUIRED`) does not. Test in prod configuration.

**Important:** The old passkey stays in Keycloak after Path A. To remove the dead credential, use Path B step 6 or the Account Console (denied). Decide the policy (§18 question 4).

### 12.3 Path B — portal-initiated re-enrollment (no recovery codes)

Prerequisite: the user can still authenticate to the **portal** (Verimi), but has lost the passkey and the recovery codes. This path uses the Admin API.

| Step | Actor | Host | Call | Result |
|---|---|---|---|---|
| 1 | Browser → portal | — | step-up re-authentication (Verimi) | fresh portal session; **mandatory** |
| 2 | Portal → Lambda | — | IAM invoke `{action:"recover", verifiId, credentialIds?}` | no public URL |
| 3 | Lambda → Keycloak | `kc-admin:8444` | `POST /token` (`client_credentials`) | admin token |
| 4 | Lambda → Keycloak | `kc-admin:8444` | `GET /admin/.../users?username=...&exact=true` | user id |
| 5 | Lambda → Keycloak | `kc-admin:8444` | `GET /admin/.../users/{id}/credentials` | choose the dead `webauthn-passwordless` id(s) |
| 6 | Lambda → Keycloak | `kc-admin:8444` | `DELETE /admin/.../users/{id}/credentials/{credentialId}` | dead passkey removed |
| 7 | Lambda → Keycloak | `kc-admin:8444` | optional `DELETE` the `recovery-authn-codes` credential | lost code sheet invalidated |
| 8 | Lambda → Keycloak | `kc-admin:8444` | `PUT /admin/.../users/{id}` with **both** required actions | `204` |
| 9 | Lambda → Keycloak | `kc-admin:8444` | `PUT /admin/.../users/{id}/reset-password` (E1) **or** KMS token (E2, no call) | first factor provisioned |
| 10 | Lambda → Keycloak | `kc-admin:8444` | `POST /admin/.../users/{id}/logout` | all old sessions invalidated |
| 11 | Browser → Keycloak | `kc:8443` | `GET /auth` (`portal-bootstrap` for E1, `portal-enroll` for E2; PKCE; state; nonce) | login/registration page |
| 12 | Browser → Keycloak | `kc:8443` | `POST /login-actions/authenticate` (E1 password) or authenticator token (E2) | session |
| 13 | Browser → Keycloak | `kc:8443` | `GET`/`POST /login-actions/required-action` (passkey + recovery codes) | new credentials |
| 14 | Keycloak → browser | `kc:8443` | `302 callback?code&state` | callback |
| 15 | Portal backend → Keycloak | `kc:8443` | `POST /token` + `GET /userinfo` | portal session |
| 16 | Portal → Lambda | `kc-admin:8444` | `complete`: `GET credentials`; `DELETE` the password (E1); verify passkey + codes | cleanup |
| 17 | Portal backend | — | notify the user (e-mail/SMS if available), audit, close the ticket | done |

**Why step 1 is mandatory:** the portal session becomes the recovery root of trust. Without a fresh step-up, a stolen portal session is enough to replace the victim's passkey and take over the account. Add a cooling-off period (e.g., 15 minutes) and a notification before the new passkey becomes usable, if the business allows it.

### 12.4 Path C — Account Console (not a recovery path)

| Host | Endpoint | Purpose | Verdict |
|---|---|---|---|
| `kc:8443` | `GET /realms/{realm}/account/` | account SPA | denied by nginx |
| `kc:8443` | `GET /realms/{realm}/account/credentials` | list credentials | requires a Keycloak session |
| `kc:8443` | `DELETE /realms/{realm}/account/credentials/{credentialId}` | delete a credential | requires a Keycloak session |
| `kc:8443` | `GET /auth?kc_action=webauthn-register-passwordless` | add a passkey | requires a Keycloak session |

A user who lost the only passkey cannot log in to the Account Console. It is useful for **managing** credentials after login, not for recovery. Keep `/account` denied.

### 12.5 Recovery failure modes

| Failure | Symptom | Fix |
|---|---|---|
| Recovery codes were never enrolled | no "recovery" branch; Path A impossible | P1: include `CONFIGURE_RECOVERY_AUTHN_CODES` in the Lambda's required actions |
| `alreadyEnrolled` short-circuit | Lambda refuses to re-enroll a user with an old credential | P2: add a `recover` action that deletes first |
| Old sessions survive | lost device still has a valid session | P3: `POST /users/{id}/logout` after credential deletion |
| Portal session alone can reset | account takeover via stolen portal cookie | step-up + notification + cooling-off |
| One-time password never cleaned | valid password remains | P4: cleanup job or E2 |
| User lost the Kennung too | recovery-code login impossible | Path B; the portal must display the Kennung at enrollment |
| Wrong code entered repeatedly | lockout or no feedback | test rate limit/lockout; add nginx limit; monitor |
| Admin API called on `:8443` | `404` (public host) or connection to a vhost that must not exist | hardcode `kc-admin:8444`; test S13/S22 |
| AWS egress IP changed | `connect timeout` on `:8444` only; login unaffected | static NAT EIP + IONOS firewall update runbook; health check from the Lambda VPC |
| Admin API down | recovery impossible (login still works) | firewall/health check; runbook; break-glass admin on 8444 |

---

## 13. Security controls per endpoint group

| Group | Main threats | Controls |
|---|---|---|
| `O1`–`O10` | issuer confusion, JWKS poisoning, token replay, open redirect | pin issuer; verify `iss`/`aud`/`nonce`/`exp`; cache JWKS by `kid`; exact redirect URIs; PKCE S256; `state` in `__Host-` cookie; no tokens in URLs |
| `L1`–`L9` | CSRF, session fixation, XSS in theme, clickjacking, phishing | Keycloak-generated `session_code`/`execution`; auth-session cookie; `frame-ancestors 'none'` + `X-Frame-Options: DENY` on `login-actions`; no third-party JS; diff the two theme overrides (`login-recovery-authn-code-config.ftl`, `webauthnRegister.js`) on every upgrade — the FTL depends on `recoveryAuthnCodesConfigBean.*` and on the base `webauthn-register.ftl` |
| `A1`–`A16` | admin token theft, privilege abuse, mass user changes | `kc-admin:8444` only; IONOS firewall source allowlist (AWS egress) + no public `/admin`; dedicated `portal-admin` secret; short token TTL; least privilege (`manage-users`, `view-users`, `query-users` only); no `impersonation`; FGAP v2 where possible; alert on `DELETE_CREDENTIAL`, `RESET_PASSWORD`, `UPDATE_CREDENTIAL`, role changes |
| Recovery code login | brute force, code theft, username enumeration | 12 single-use high-entropy codes; hashed at rest; realm brute-force + nginx `limit_req`; generic errors; notify on use; show remaining codes |
| Passkey login | phishing, credential mismatch, shared device | WebAuthn origin binding; exact RP ID; user verification required; username-first or per-tenant RP ID; no password fallback on the passkey client |
| Admin API path | exposure, SSRF, lateral movement | separate vhost + port (8444); no `8443` listener on `kc-admin`; route allowlist `/admin/` + tenant token endpoint; IONOS firewall stateful allowlist; static AWS egress; no Admin Console on the public host |

**Why port separation is a real control, not just tidiness:** the admin vhost runs on a different port with a different certificate and a different nginx `server` block. That lets you (a) firewall only 8444, (b) keep `/admin` absent from the public vhost, and (c) drop or rate-limit admin traffic independently. If 8443 on `kc-admin` still answers, the firewall rule for 8444 is bypassable and the separation is cosmetic (**P12**).

### 13.1 Logging rules

- Nginx: log `$uri`, not `$request` (no query string). The current `security-measures.md` already claims query strings are excluded; verify it.
- Keycloak: `KC_HTTP_ACCESS_LOG_ENABLED` must not log query strings or `Authorization`. The `code`, `state`, `enrollment_token`, password, and bearer token must never appear in logs.
- Audit events: `LOGIN`, `LOGIN_ERROR`, `UPDATE_CREDENTIAL`, `REMOVE_CREDENTIAL`, `UPDATE_PASSWORD`, `RESET_PASSWORD`, `CUSTOM_REQUIRED_ACTION`, `EXECUTE_ACTIONS`, `USER_SESSION_DELETED`; admin events for A4–A10.
- Alert on: recovery-code login, credential deletion, password reset, `portal-admin` token issuance, `impersonation` role changes.

---

## 14. Robustness and scale

| Concern | Design |
|---|---|
| No single point in the browser flow | Keycloak x2 + Infinispan session replication; nginx is the only ingress, so add an L4 LB or DNS failover for the VPS |
| No single point in the backend | Lambdas are stateless; the `code_verifier` and `state` live in `__Host-` cookies, not in one Lambda's memory |
| Admin path outage | login still works; enrollment/recovery degrade. Health-check `kc-admin:8444` from inside the Lambda VPC; document a break-glass admin |
| Static egress dependency | The firewall allowlist is keyed to AWS egress IPs. A NAT Gateway change or a new VPC without a fixed EIP silently kills enrollment and recovery. Pin the egress (NAT EIP), monitor from the same subnet, and treat egress changes as a release event |
| Two vhosts, one Keycloak | Same nodes, same DB, same `iss`. Only the proxy layer differs, so a Keycloak upgrade cannot introduce a host/port split; but nginx config drift between the two vhosts can. Generate both from one template and diff them in CI |
| Token endpoint hot path | separate `limit_req` zone; connection pooling/keep-alive in Lambda; cache discovery/JWKS; do not call discovery per request |
| Millions of users | enrollment/recovery are rare; login scales with Keycloak nodes + DB. Size PostgreSQL for session writes; use PgBouncer; monitor p95 |
| KMS quota (E2) | one key per tenant; `kms:Sign` only for the enrollment Lambda; alarm on Sign rate; cache nothing |
| Clock skew | NTP on Keycloak and Lambdas; 300 s access-token TTL; small leeway |
| Retries | retry only idempotent GETs; code exchange is single-use — retry only on connection errors before a response; use PKCE |
| DB failover | managed PostgreSQL with automatic failover; Keycloak requires a single writer |
| Data growth | credential rows are small; clean dead passkeys on recovery; event retention 7 days |

---

## 15. C4 views

### 15.1 System context

```text
+---------------------------+          +---------------------------+
| Member                    |          | IDV / Verimi (external)   |
| browser + platform        |          | portal login / identity   |
| authenticator             |          |                           |
+------------+--------------+          +-------------+-------------+
             |                                       ^
             | HTTPS :8443                           | OIDC/SAML (optional)
             v                                       |
+---------------------------+   OIDC    +-------------+-------------+
| Portal (AWS)              |---------->| Keycloak (IONOS VPS)      |
| web + Lambda              |<----------| one realm per tenant      |
+------+--------------+-----+  callback +------+------+-------------+
       |              |                       |      |
       | IAM invoke   | admin REST            | SQL  | sessions
       v              | kc-admin:8444         v      v
+------+-----+        |                   +---+--+  +--------+
| Enroll /   |--------+                   | PG   |  | cache  |
| Recovery   |                            |      |  |        |
| Lambda     |   +------------------------+------+  +--------+
+------+-----+   | IONOS firewall: allow AWS egress -> TCP 8444 only
       |         v
       |   nginx kc-admin:8444 ---> Keycloak nodes (same iss as kc:8443)
       | KMS sign (E2)
       v
+------+-----+
| AWS KMS    |
| per tenant |
+------------+
```

### 15.2 Container view

```text
+-------------------+       1. 302 /auth          +---------------------------+
| Browser           |----------------------------->| nginx kc:8443 (public)    |
| WebAuthn API      |<-----------------------------| - realm allowlist         |
+---------+---------+       6. 302 code&state     | - /admin -> 404           |
          |                                       +-------------+-------------+
          | 2. GET/POST login-actions/*                         |
          |    (same origin, Keycloak cookies)                  | proxy :8080
          v                                                     v
+-------------------+                           +---------------------------+
| Keycloak login UI |                           | Keycloak node 1 / node 2  |
| theme portal-base |                           | - auth flows              |
+-------------------+                           | - WebAuthn verification   |
                                                | - session cookies         |
                                                +------+-------------+------+
                                                       |             |
                                                       | JDBC        | Infinispan
                                                       v             v
                                                +------+------+  +---+---+
                                                | PostgreSQL  |  | cache |
                                                +-------------+  +-------+

Portal backend (AWS Lambda)
  | 3. POST /token (code + PKCE / client secret)     -> kc:8443
  | 4. GET /userinfo, /certs                         -> kc:8443
  v
nginx kc:8443

Enroll/Recovery Lambda (no public URL)
  | 5. POST /token (client_credentials)              -> kc-admin:8444
  | 6. /admin/realms/...                            -> kc-admin:8444
  v
nginx kc-admin:8444  (IONOS firewall: AWS egress only, TCP 8444 only)
  | proxy :8080
  v
Keycloak node 1 / node 2   (iss stays https://kc.gateway-vw.de:8443)
```

### 15.3 Dynamic view — enrollment (E1)

```text
Browser            Portal            Lambda            Keycloak
  |                  |                 |      kc-admin:8444 |
  | click enroll     |                 |                  |
  |----------------->|                 |                  |
  |                  | IAM invoke      |                  |
  |                  |---------------->|                  |
  |                  |                 | client_credentials|
  |                  |                 |----------------->|
  |                  |                 | GET user?username|
  |                  |                 |----------------->|
  |                  |                 | POST/PUT user    |
  |                  |                 |----------------->|
  |                  |                 | PUT reset-password
  |                  |                 |----------------->|
  |                  | one-time pw     |                  |
  |<-----------------|                 |                  |
  | 302 /auth (portal-bootstrap, PKCE, state)   kc:8443   |
  |------------------------------------------------------->|
  | GET/POST /login-actions/authenticate (username + pw)   |
  |------------------------------------------------------->|
  | GET/POST /login-actions/required-action (passkey)      |
  |------------------------------------------------------->|
  | GET/POST /login-actions/required-action (recovery)     |
  |------------------------------------------------------->|
  | 302 callback?code&state                                |
  |<-------------------------------------------------------|
  | POST /token (code + verifier)                          |
  |------------------------------------------------------->|
  | GET /userinfo                                          |
  |------------------------------------------------------->|
  | IAM invoke complete -> GET/DELETE credentials  kc-admin:8444
  |                  |---------------->|----------------->|
```

### 15.4 Dynamic view — login and recovery

```text
LOGIN  (all calls kc:8443)
  Browser -> GET /auth (portal-mock, PKCE, state, nonce)
          -> GET /login-actions/authenticate (passkey page)
          -> navigator.credentials.get()
          -> POST /login-actions/authenticate (assertion)
          -> 302 callback -> POST /token -> GET /userinfo

RECOVERY A (codes, kc:8443 only)
  Browser -> GET /auth (portal-mock, PKCE, state, nonce)
          -> POST /login-actions/authenticate (tryAnotherWay=on)
          -> POST /login-actions/authenticate (username=Kennung)
          -> POST /login-actions/authenticate (recoveryCodeInput)
          -> GET/POST /login-actions/required-action (new passkey)
          -> [optional] /auth?kc_action=CONFIGURE_RECOVERY_AUTHN_CODES
          -> 302 callback -> POST /token -> GET /userinfo

RECOVERY B (no codes)
  Browser -> Portal (step-up) -> Lambda (all admin calls kc-admin:8444):
      POST /token (client_credentials)
      GET  /admin/.../users?username=...
      GET  /admin/.../users/{id}/credentials
      DELETE /admin/.../users/{id}/credentials/{deadId}
      PUT  /admin/.../users/{id} (both required actions)
      PUT  /admin/.../users/{id}/reset-password   (E1)
      POST /admin/.../users/{id}/logout
  Browser -> GET /auth (portal-bootstrap | portal-enroll)   kc:8443
          -> authenticate -> required-action -> callback
  Lambda  -> GET credentials, DELETE password (E1), verify   kc-admin:8444
```

---

## 16. Findings in the current repository

| ID | Severity | Finding | Evidence | Action |
|---|---|---|---|---|
| **P1** | **High** | The enrollment Lambda never requests `CONFIGURE_RECOVERY_AUTHN_CODES`. Users created/updated through it have only `webauthn-register-passwordless`, so Path A recovery does not exist. | `sim/enrollment-lambda/index.js:124,141`; `UserResource.updateUserFromRep` removes missing actions; `POST /users` does not apply realm defaults | Send both actions in `POST` and every `PUT`; verify with `GET /users/{id}` (test S12) |
| **P2** | **High** | `enroll()` returns `alreadyEnrolled` when any `webauthn-passwordless` credential exists. Recovery would be refused because the dead credential is still there. | `sim/enrollment-lambda/index.js:85-87` | Add a `recover` action that deletes the selected credential(s) first; or a `force` flag with an explicit policy |
| **P3** | **High** | No session invalidation after deleting a credential or resetting a password. A lost device can keep a valid session. | no `POST /users/{id}/logout` in the Lambda | Call A10 after A7/A8; optionally A12 for a specific session |
| **P4** | **Medium** | The one-time password is `temporary:false` and is deleted only on the `complete` callback. If the user abandons, it stays valid. | `sim/enrollment-lambda/index.js:146-152`; `complete()` | Prefer E2; otherwise a cleanup job for `password` credentials of users with an open passkey action |
| **P5** | **High** | The recovery root of trust is the portal session, with no step-up. A stolen portal cookie can replace the victim's passkey. | `architecture_11-02-2026.md §2`; Lambda invoked after the portal session check | Require fresh Verimi authentication; notify the user; cooling-off; rate limit; audit |
| **P6** | **Blocker (known)** | The Admin API path is still not implemented (`kc-admin:8444`). Without it, E1 enrollment and Path B recovery fail. | C1 in `architecture_10-29-2026.md` | Firewall allowlist for AWS egress + admin vhost on 8444; no public `/admin`; FGAP |
| **P7** | **Medium** | Nginx still uses the catch-all `/realms/{realm}/`, exposing `account`, `broker`, `device`, `clients-registrations`, `ext`. | `infra/nginx/generate-nginx.mjs:100` | Apply the allowlist in §9.1 |
| **P8** | **Medium** | Query strings may reach access logs (`code`, `state`, `enrollment_token`). | `architecture_10-29-2026.md §7.3`; verify nginx `log_format` | Log `$uri`; redact; POST for enrollment; disable Keycloak access log or strip query |
| **P9** | **Medium** | Shared RP ID `gateway-vw.de` + username-less login leaks other tenants' usernames in the picker (H1). | `architecture_10-29-2026.md §3 H1` | Username-first, or per-tenant RP IDs **before** go-live |
| **P10** | **Low** | `impersonation` is still assigned when `portalImpersonation` is true. | `realm-template.mjs:550` | Remove after E1/E2 migration; alert on role changes |
| **P11** | **Medium** | The reverse proxy emits only HSTS — no CSP, no `frame-ancestors`. The login page can be framed (clickjacking against the passkey prompt), and the recovery-code page uses an inline `<script>`, which blocks a strict `script-src` if a CSP is added naively. | `infra/nginx/generate-nginx.mjs:131` (HSTS only); `keycloak/themes/portal-base/login/login-recovery-authn-code-config.ftl:145-185` (inline script) | Verify what Keycloak already sends, then add `frame-ancestors 'none'` + `X-Frame-Options: DENY` for `/login-actions/` and `/resources/`; move the inline script into `resources/js/` (or use a build-generated CSP hash); then add `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'` |
| **P12** | **High** | Moving the admin vhost to **8444** does not close the old **8443** listener by itself. If `kc-admin.gateway-vw.de:8443` still answers (or the router still forwards 8443 to it), the IONOS firewall rule for 8444 is bypassed and the admin API stays reachable from the internet on the old port. | server blocks are generated per vhost; the change is a port/router change, not a route change | Confirm `https://kc-admin.gateway-vw.de:8443/` fails (`connection refused`/TLS error), `:8444/admin/realms/{realm}` returns `401` without a token, and `kc:8443/admin/realms/{realm}` returns `404`. Add both to the deploy checklist (S22/S23) |

---

## 17. Test matrix

| ID | Test | Expected |
|---|---|---|
| S1 | Discovery + JWKS from outside | `200`; `issuer = https://kc.gateway-vw.de:8443/realms/{realm}` |
| S2 | Enrollment E1 end-to-end | passkey + recovery codes stored; password deleted; callback token valid |
| S3 | `GET /users/{id}` after enrollment | `webauthn-passwordless` + `recovery-authn-codes`; no `password` |
| S4 | Login with passkey | assertion accepted; `preferred_username = verifi_id` |
| S5 | Recovery code login | `tryAnotherWay` → username → code → AIA registration → token |
| S6 | Reuse a consumed recovery code | rejected |
| S7 | Wrong recovery code × 10 | rate-limited/locked; generic error; no user enumeration |
| S8 | Path B with no codes | old credential deleted; sessions invalidated; new passkey + codes; password removed |
| S9 | Old session after Path B | invalid (`POST /users/{id}/logout`) |
| S10 | `state` mismatch / replay `code` / wrong `code_verifier` | rejected |
| S11 | `redirect_uri` mismatch / wildcard | rejected at `/auth` |
| S12 | P1 check | `requiredActions` contains BOTH actions after Lambda create/update |
| S13 | Public `/admin` | `https://kc.gateway-vw.de:8443/admin/realms/{realm}` → `404` |
| S14 | `client_credentials` token | only `manage-users`, `view-users`, `query-users`; no `impersonation` |
| S15 | Nginx allowlist | `account`, `broker`, `device`, `clients-registrations`, `ext` denied |
| S16 | Logs | no `code`, `state`, `enrollment_token`, `password`, `Authorization` |
| S17 | All 9 realms | same result per realm |
| S18 | Keycloak upgrade | diff `webauthnRegister.js`; re-run S2–S5 |
| S19 | Top-level navigation portal → Keycloak → portal | `KEYCLOAK_IDENTITY`/`KEYCLOAK_SESSION` delivered and replaced; no iframe `SameSite=None` requirement |
| S20 | Regenerate recovery codes | old sheet rejected; new sheet works; exactly one `recovery-authn-codes` credential |
| S21 | Recovery with a dead passkey still present | registration runs despite the old credential (no `skip_if_exists`); old credential can be deleted afterwards |
| S22 | Response headers on `/login-actions/*` | `X-Frame-Options: DENY` / `frame-ancestors 'none'`; CSP present without `unsafe-inline`; no inline `<script>` in the served recovery page |
| S23 | Admin vhost on `:8444` | `GET /realms/{realm}/.well-known/openid-configuration` works; `GET /admin/realms/{realm}/users` → `401` without a token; `/protocol/openid-connect/auth` absent (`404`) |
| S24 | Admin host on `:8443` (P12) | `connection refused`/TLS error; no `200` for `/` |
| S25 | Firewall source filter | from a non-allowlisted IP `:8444` times out; from the Lambda subnet `401` within the same timeout budget; `iss` in admin-obtained tokens is still `https://kc.gateway-vw.de:8443/realms/{realm}` |

---

## 18. Open questions (blocking decisions)

1. **Which recovery root of trust?** Is the portal's primary login still Verimi, or will Keycloak passkey become the only portal login? If the latter, define a non-Keycloak fallback, or users with a lost passkey and lost codes are locked out.
2. **E1 or E2?** One-time password (simpler, needs Admin API + `portal-bootstrap`) or KMS enrollment token (no password, needs the Java authenticator + `portal-enroll`)? The endpoint list above covers both; the runtime set differs.
3. **One passkey or two?** If two, add an "add another passkey" AIA step and keep both `userLabel`s. This reduces recovery risk more than any other measure.
4. **Delete policy on recovery:** delete only the selected credential, or all `webauthn-passwordless` credentials? The Admin API exposes labels, so a user-driven selection is possible.
5. **Is `gateway-vw.de` or `kc.gateway-vw.de` the final RP ID?** Changing it after go-live invalidates every passkey.
6. **Is the Admin API path ready (C1)?** Required: static AWS egress (NAT EIP), IONOS firewall rule to TCP 8444, admin vhost with certificate for `kc-admin.gateway-vw.de`, and no listener on 8443 (P12). Without all four, E1 and Path B cannot ship.
7. **Are recovery codes acceptable to the business?** They are the only no-email, no-SMS path. If not, e-mail (`execute-actions-email`) or SMS must be added, and the endpoint set grows.

---

## 19. Summary

- **Two hosts, two jobs:** `kc:8443` = browser + portal backend (OIDC, `login-actions`); `kc-admin:8444` = Lambda + setup (token + Admin REST). No endpoint is served by both, and `iss` is always `https://kc.gateway-vw.de:8443/realms/{realm}`.
- **Create:** browser `auth` + `login-actions/authenticate` + `login-actions/required-action` on `kc:8443`; backend `token` + `userinfo` on `kc:8443`; Lambda `client_credentials` + five Admin REST calls on `kc-admin:8444`.
- **Login:** browser `auth` + `login-actions/authenticate`; backend `token` + `certs`/`userinfo` + `logout` — all `kc:8443`; no admin call at runtime.
- **Recover:** Path A uses only `kc:8443` endpoints (required actions, optionally one `kc_action` for code regeneration); Path B adds `GET credentials`, `DELETE credential`, `PUT user`, `reset-password` (or KMS token), and `POST users/{id}/logout` on `kc-admin:8444`.
- **The two things that will break task 3 today:** P1 (recovery codes never enrolled) and P2 (`alreadyEnrolled` blocks re-enrollment). Fix those before testing recovery.
- **The port change is only real if 8443 is closed on the admin host:** P12. A firewall rule for 8444 does not protect a listener that is still open on 8443.
