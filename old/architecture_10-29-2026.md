# Architecture verification — 2026-10-29

## 1. Ingress (design)

```text
Internet ──TCP 8443──► VPS host ──► Nginx container :443 ──► Keycloak :8080 (keycloak-1, keycloak-2)
                                                         └──► PostgreSQL :5432 (internal only)
```

- `KC_PUBLIC_PORT=8443`. Rootless Docker cannot publish ports below 1024.
- Public URLs: `https://<host>:8443`. Port 443 exists only inside the container.
- Public exposure: TCP 8443 only. Keycloak 8080/9000 and PostgreSQL 5432 are not published.
- Admin console: restricted to `MGMT_CIDR`.

## 2. Verification results (2026-10-29, read-only)

| Check | Result | Evidence |
|---|---|---|
| Public DNS `kc.gateway-vw.de` | FAIL: NXDOMAIN | DNS-over-HTTPS, status 3 |
| TCP 8443 from outside network | FAIL: timeout | curl exit 28; Windows `TcpTestSucceeded: False` |
| TCP 443, same IP | Connection refused, fast | curl exit 7: host answers, 443 is not served |
| Local OIDC discovery via Nginx | PASS | HTTP 200, issuer `https://kc.gateway-vw.de:8443/realms/vw-baev` |
| Public certificate | FAIL: self-signed | `issuer: CN=kc.gateway-vw.de` |
| Admin API via tenant host | Not routed | `generated/tenants.conf`: `location / { return 404; }` |
| Keycloak framed by portal | Blocked by design | `X-Frame-Options: SAMEORIGIN` |
| WebAuthn JS | Forked copy of Keycloak 26.7.5 | `keycloak/themes/portal-base/login/resources/js/webauthnRegister.js` |

Interpretation: 443 answers and 8443 is dropped. Most likely a firewall rule allows 443 but not 8443.

## 3. Findings (passkey and Lambda flow)

| ID | Severity | Finding | Action |
|---|---|---|---|
| C1 | Blocker (design) | Registration needs Admin API calls from Lambda. Tenant host returns 404 for `/admin/*`; admin host allows only `MGMT_CIDR`. | Preferred: WireGuard/IPsec tunnel from AWS VPC to VPS, Admin REST only via tunnel. Alternative: separate admin-REST location allowing only the Lambda NAT EIP. Never expose the admin console. |
| C2 | Critical | `portalImpersonation: true` for 6 of 9 prod tenants. `portal-admin` can impersonate any user of the realm. | Remove impersonation. Replace with single-use enrollment: Keycloak e-mail action token for `webauthn-register-passwordless` (verify on 26.7.5), or a signed one-time token via custom authenticator. |
| H1 | High | Shared RP ID `gateway-vw.de` plus username-less passkeys (`allowCredentials: []`). Usernames of other tenants can appear in the passkey picker on shared devices. | Username-first login with `allowCredentials` for portal flows, or per-tenant RP IDs. Narrow RP ID to `kc.gateway-vw.de` before go-live. Changing RP ID later invalidates all passkeys. |
| H2 | High | Three public portal clients per realm: `portal-mock` (redirect `/api/auth/kc/callback`, PKCE S256, passkey-only flow), `portal-bootstrap` (PKCE S256, default browser flow with password form), and `vw-baev` (redirect `https://vw-baev.de`, `/eid-callback-idp`, no PKCE attribute, default browser flow with password, applied with `OVERWRITE`). | One client per portal, bound to `browser-passkey`, exact redirect URI, `pkce.code.challenge.method=S256`. Remove the others. |
| H3 | High | `limit_req` 10 r/s per source IP on all realm routes, including token endpoint. Lambda token exchanges share few egress IPs. | Separate, higher limit for the token endpoint from the Lambda EIP. Load-test before go-live. |
| M1 | Medium | Portal clients are public, but the Lambda is server-side. | Confidential client with `client_secret_basic`. |
| M2 | Medium | `webauthnRegister.js` diverges from Keycloak 26.7.5 (prompt fallback, helper code). No security-relevant change found. | Diff on every Keycloak upgrade. |
| B1 | Blocker | DNS missing, TCP 8443 dropped, certificate self-signed. | A record. Open TCP 8443 (or L4 load balancer 443→8443). Publicly trusted certificate via DNS-01, because only 8443 is reachable. |

## 4. Corrections to earlier statements

- Public port is 8443, not 443. The earlier version of this file was wrong.
- The repo flow is not "login, then register". Self-registration is disabled (`registrationAllowed: false`, `realm-template.mjs:130`). Users are provisioned by the portal and then enrolled.
- The callback path must equal the registered redirect URI (`/api/auth/kc/callback` in the template).
- `state` must be bound to the browser with a `__Host-` cookie, not only checked against a store.
- Transaction cookie must use `SameSite=Lax`, because the callback is a cross-site top-level navigation.
- Lambda token request should use `client_secret_basic`, not `client_secret` in the body.

## 5. Target architecture (C4 container view)

```text
Person ──HTTPS──► Portal (AWS Lambda, e.g. vw-baev.de)
                    │  ▲
     302 (OIDC)     │  │  302 callback ?code&state
                    ▼  │
Browser ──────► Nginx on IONOS VPS (host TCP 8443)
  │  WebAuthn runs here (Keycloak origin)   │ realm routes only, /admin 404 on tenant host
  └────────────────────────────────► Keycloak x2 (one realm per tenant) ──► PostgreSQL (internal)
                                        ▲
Lambda ──token exchange (Basic auth, TCP 8443)┘
Lambda ──provisioning (C1: private tunnel only)──► Keycloak Admin REST
```

## 6. Open decisions

1. C1: Admin path for provisioning (tunnel or EIP allowlist).
2. C2: Enrollment without impersonation (e-mail action token or custom authenticator).
3. H1: Username-first passkey login or per-tenant RP IDs.
4. H2: One client per portal, bound to `browser-passkey`.
5. M1: Confidential or public portal clients.
6. Enrollment flow: replace impersonation (see section 7).

## 7. Passkey enrollment flow: decision (2026-10-29)

### 7.1 Verified facts (Keycloak 26.7.5 source and repo)

- Login session cookies `KEYCLOAK_IDENTITY` and `KEYCLOAK_SESSION` use `CookieScope.FEDERATION` / `FEDERATION_JS`, both `SameSite=None`. A top-level redirect from `vw-baev.de` to `kc.gateway-vw.de` carries them. A shared domain is not required.
- `SingleUseObjectProvider.putIfAbsent` is available for single-use enrollment tokens (cluster-safe per Keycloak's SPI contract).
- `portal-mock` disables the cookie authenticator (`realm-template.mjs:347`). AIA on this client cannot use an existing session.
- `portal-bootstrap` uses the default browser flow and accepts an existing session.
- Impersonation is enabled in 6 of 9 prod realms and disabled in `vwaek-hamburg`, `vw-aknrw` and `ingenieurversorgung-niedersachsen`.

### 7.2 Decision

Replace impersonation with a portal-signed enrollment token (KMS ES256, 120 s, single use). A Keycloak authenticator `enrollment-token` consumes it in flow `portal-enrollment`. The required action `webauthn-register-passwordless` stays. The Lambda no longer calls the Admin API for enrollment.

### 7.3 Project changes

- `keycloak/Dockerfile`: `COPY providers/ /opt/keycloak/providers/` before `kc.sh build` (builder stage, before line 31).
- New Java provider `enrollment-token` in `keycloak/providers/enrollment-token/`.
- `keycloak/realm-template.mjs`: flow `portal-enrollment`, client `portal-enroll` (confidential, PKCE S256). Remove the `impersonation` role assignment (line 550).
- `keycloak/tenants.json`: remove `portalImpersonation` after migration.
- `keycloak/setup-realms.mjs`: write the enrollment public key per realm into the authenticator config.
- `infra/nginx/generate-nginx.mjs`: allowlist Keycloak endpoints (`.well-known`, `protocol/openid-connect/{auth,token,certs,userinfo,logout}`, `login-actions/`, `resources/`) instead of the catch-all `/realms/<realm>/`. Deny `account`, `clients-registrations`, `broker`, `device`, `ext`.
- `docker-compose.yml:92`: check whether `KC_HTTP_ACCESS_LOG_ENABLED` logs query strings. Bearer values must never appear in URLs.
- AWS: one ECC P-256 KMS key per tenant. `kms:Sign` only for the enrollment Lambda role. Alarm on Sign calls.

### 7.4 Tests (once Keycloak is reachable)

- S0: Authorization endpoint accepts POST with `enrollment_token`, and the authenticator reads it.
- S1: `KEYCLOAK_SESSION` and `KEYCLOAK_IDENTITY` are `SameSite=None; Secure` in the browser.
- S2: Portal session cookie is `SameSite=Lax`.
- S3/S4: Replayed token and token older than 120 s are rejected.
- S5/S6: Token for a user with a passkey, or with another `client_id`, is rejected.
- S7/S8: Registration on `https://kc.gateway-vw.de:8443` succeeds in Chrome, Firefox, Safari (ITP) and iOS.
- S9: Portal logout and Keycloak logout behave as intended.
- S10: `preferred_username` in the ID token equals the stored opaque username.
- S11: The flow works in all 9 realms.

### 7.5 Why the impersonation step fails (verified 2026-10-29, Keycloak 26.7.5 source)

- `UserResource.impersonate()` (around line 377): requires feature `IMPERSONATION` (enabled by default, `Profile.java:86`), requires the `impersonation` permission (403 otherwise), rejects disabled users (400).
- It creates a server-side user session tagged with auth method `impersonate`. No authentication factor is involved.
- It calls `AuthenticationManager.createLoginCookie()` (line 862). That writes `KEYCLOAK_IDENTITY` and `KEYCLOAK_SESSION` via `DefaultCookieProvider.set()`, which calls `getHttpResponse().setCookieIfAbsent(...)`. The cookies go into the response of the current request, which is the Admin API response to the caller.
- It returns `{sameRealm, redirect}`. `redirect` is the account console URL (`Urls.accountBase`) and carries no token.

Consequence: the Lambda receives the Keycloak session cookies. The browser receives none. The redirect opens the account console without a session, so the user lands on the login page.

Failure chain for the Lambda design:
1. Lambda cannot reach the Admin API (tenant host returns 404; admin host allows only `MGMT_CIDR`).
2. `impersonation` role missing in the 3 realms with `portalImpersonation: false` (verify live). New realms need the bootstrap admin again (`docker-compose.yml:14-18`).
3. Session cookies never reach the browser. This fails even if steps 1 and 2 are fixed. It is the design blocker.
4. Passkey registration (AIA): `portal-mock` disables the cookie authenticator (`realm-template.mjs:347`), so the user is asked for a passkey first. `portal-bootstrap` accepts cookies, but only if step 3 worked.

Corrections to earlier statements:
- The redirect does not establish the browser session.
- The redirect is not a one-time bearer link. The bearer material is the `KEYCLOAK_IDENTITY` cookie in the Admin API response.
- Step 4 in the earlier table was marked OK. It is blocked by step 3.
- SameSite is not the problem. The cookies are `SameSite=None`. They never reach the browser.

Principle: Keycloak session cookies must be created in a response to the browser's own request to Keycloak. A backend call cannot do this. The admin console works with impersonation only because the admin's browser makes the API call itself.

Colleague's same-domain idea: technically the only way to make impersonation cookies reach the browser is to let the portal copy Keycloak's `Set-Cookie` headers through a response on the Keycloak host or a parent domain. That means the portal carries live Keycloak session cookies, and it works for one portal only. Not acceptable.

Final verdict on the colleague's claim: partly right. He is right that the impersonation design cannot hand the session to the browser across domains. He is wrong that a shared domain is needed for the login flow, because OIDC redirects work across domains. He is also wrong as a general fix: `kc.vw-baev.de` helps one of the nine prod portals. Sharing one parent domain across all tenants would make cookie sharing possible, but it widens the attack surface (cookie tossing from tenant subdomains, since Keycloak's cookies do not use the `__Host-` prefix). The correct fix: Keycloak creates the browser session itself (enrollment token plus authenticator, or brokering Verimi if it supports OIDC or SAML).

### 7.6 Solution options (2026-10-29)

Two separate decisions. Decision 1 is the blocker.

**Critical, time-sensitive:** Verimi announced that it will discontinue the Verimi ID Wallet at the end of 2026 (verimi.de, read 2026-10-29). The attribute `verifi_id` in the repo suggests Verimi is the IDV provider. Confirm which Verimi product is used. If it is the wallet, plan a migration now.

Decision 1: how Keycloak establishes the first factor for enrollment, so that Keycloak creates the browser session itself.
- A. Broker the IDV provider in Keycloak (OIDC or SAML). First broker login creates the user, and the required action enrolls the passkey. No Admin API, no custom code. Requires an IDV provider with OIDC or SAML login. Not confirmed for Verimi: its APIs use OIDC/OAuth, and a Keycloak plugin is listed as planned.
- B. Portal-signed enrollment token (KMS, 120 s, single use) plus Keycloak authenticator (SPI). No Admin API. Custom Java code. Recommended if A is not possible.
- C. Keycloak e-mail action token (`execute-actions-email` with `webauthn-register-passwordless`). No custom code. Verified in 26.7.5: the Admin call returns 204 and only sends the e-mail, so no cookies go to the caller. The action token adds the required action and redirects the browser, so the session is created in the browser. The token is single use, because the default `isOneTimeAction()` is `true` and the WebAuthn passwordless factory does not override it. Needs: a private Admin API path (to trigger the e-mail), an e-mail address per user (`user.getEmail()` is in the token), SMTP per realm. Risk: the mailbox becomes the root of trust for enrollment.
- D. Temporary password or OTP as first factor, set by the backend. Reintroduces a password. Fallback only.
- E. Impersonation. Ruled out (section 7.5).

Decision 2: where Keycloak lives. Independent of Decision 1; it does not solve enrollment on its own.
- F. Shared host `kc.gateway-vw.de` (current). Cross-site OIDC works. Passkey RP ID is shared by all tenants (H1).
- G. Per-tenant hostnames under `gateway-vw.de`. Per-tenant RP IDs give passkey isolation. Wildcard certificate via DNS-01. The generator already groups by host. Needs a proof of concept for Keycloak host handling.
- H. Same-origin proxy per portal domain (`https://<portal>/kc/...`). Meets the same-domain wish without copying cookies. Per-realm `frontendUrl` is already used in the repo. Needs a proof of concept. The portal operator then fronts the login and passkey ceremony (trust consolidation).

Recommendation: if the IDV provider supports OIDC or SAML login, use A with F or G. Otherwise use B. Use C only as a pilot with verified e-mail addresses and a private admin path. Use H only if the same-domain requirement is real. It does not replace A, B or C.

## 8. Lambda passkey simulation (2026-10-29)

Verdict: do not use the supplied redirect, and do not use impersonation. A Lambda cannot create a passkey. WebAuthn runs in the user's browser, on the Keycloak origin. There is no query parameter that enrolls an unknown user.

The supplied template is rejected for the enrollment action.

| Issue | Why it is wrong |
|---|---|
| `targetUrl = https://kc.gateway-vw.de:8443` | Host root is not an OIDC request. No realm, client, PKCE, or redirect URI. |
| "Which parameter creates the passkey?" | None. `kc_action=webauthn-register-passwordless` runs only after a browser session exists. `portal-mock` then asks for a passkey the user does not have (`realm-template.mjs`). |
| One public function redirects the browser | The passkey ceremony cannot run inside Lambda. The function would also be the wrong place for admin or signing credentials. |
| Impersonation, as requested | Rejected again. `impersonate()` writes `KEYCLOAK_IDENTITY` and `KEYCLOAK_SESSION` on the Admin API response to the caller (section 7.5). A later browser redirect does not carry those cookies. The public page cannot set them for `kc.gateway-vw.de`. Copying them through the portal is the rejected same-domain workaround. |
| Static `index.html` | A static file cannot hold per-request `state` or PKCE, and a URL injected into JavaScript is an open-redirect sink. |

### 8.1 Domains

- Portal session: the six owned portals, after their own registration. The three external portals (`vwaek.hamburg`, `ingenieurversorgung-niedersachsen.de`, `vw-aknrw.de`) may only redirect into this flow. They must not receive the signing key or admin credentials.
- Enrollment grant: private Lambda, IAM only, one KMS key per tenant.
- Authentication: Keycloak realm for that portal. The authenticator creates the user and the browser session, then `webauthn-register-passwordless` runs.
- Callback: portal Lambda on the exact registered redirect URI. Confidential client, `client_secret_basic`.

### 8.2 Functions

| Function | Exposure | Does | Must not |
|---|---|---|---|
| `enrollment-page` | Public HTTPS | Button, OIDC `state`, PKCE, `__Host-` cookies, form POST to the Keycloak authorization endpoint | Admin API, impersonation, KMS, client secret, bearer in the URL or in JavaScript |
| `enrollment-grant` | IAM only, not a public URL | Sign a 120 s single-use enrollment token after the simulated IDV result | Be bundled into the public page function |
| `oidc-callback` | Public path, exact redirect URI | Check `state`, exchange `code` with the confidential client | Log the code or the token response |
| Keycloak `enrollment-token` | Realm route | Create the user if absent, set required action, run WebAuthn in the browser | Trust a token from another realm or client |

`enrollment-page` may use the Node 24 HTTP server bootstrap (`AWS_LAMBDA_HTTP_ENDPOINT`). Split on the last colon, not the first, and reject a value that contains `://`. That bootstrap does not make the static HTML usable.

The public simulator is `sim/enrollment-page/`. It fails closed: `POST /impersonate` returns 403 and makes no Admin call. It does not create a passkey. Until the authenticator exists, a configured start only proves that Keycloak does not enroll an unknown user.

### 8.3 Authorization request

POST to `/realms/{realm}/protocol/openid-connect/auth`. Body, not query string.

| Field | Value | Creates the passkey? |
|---|---|---|
| `client_id` | Future `portal-enroll`. Not `portal-mock` | No |
| `redirect_uri` | Exact registered callback, for example `https://vw-baev.de/api/auth/kc/callback` | No |
| `response_type` | `code` | No |
| `scope` | `openid` | No |
| `state`, `nonce` | 256-bit random; `state` also in `__Host-` cookie | No |
| `code_challenge`, `code_challenge_method` | S256, as on `portal-mock` | No |
| `enrollment_token` | POST body, only after the authenticator is deployed | No by itself. It is the first factor the authenticator checks |
| `kc_action` | Do not send for an unknown user | No |

### 8.4 Robustness, scale, attacks

- No single active node: page and callback are stateless. Keycloak is already two nodes. Do not store the verifier only in one Lambda's memory; use the `__Host-` cookie.
- Millions of users: no database on the page function. KMS `Sign` is the later quota limit; alarm on it. Do not share the realm `limit_req` bucket with the token endpoint (H3).
- Attacks blocked by this split: admin credential in the browser, impersonation cookie theft, open redirect, token in `Referer` or access logs, replay (Keycloak single-use `jti`), cross-realm token (audience and `client_id` bound).
- Not solved here: live DNS, TCP 8443, and the trusted certificate (B1). The simulator must not be pointed at production until those pass. No wildcard redirect in production.

### 8.5 C4 container view

```text
Person
  │ HTTPS, user gesture
  ▼
[enrollment-page]  public Lambda, no secrets
  │ form POST (OIDC params, no bearer)
  ▼
Browser ──► Nginx :8443 ──► Keycloak realm
              │                │  authenticator checks enrollment token
              │                │  creates user + browser session itself
              │                └── WebAuthn on kc.gateway-vw.de
              │
              └── 302 code ──► [oidc-callback] ──Basic auth──► Keycloak token endpoint

[enrollment-grant]  private Lambda
  │ kms:Sign only, IAM invoke from the portal backend
  └── 120 s token, consumed once by Keycloak
      (not by the public page, and not by impersonation)

Rejected path: public Lambda ──Admin impersonate──► cookies stop at Lambda
```

### 8.6 Test realm

Chosen realm: `vw-baev`. Testing only. No other realm is accepted.

| Candidate | Why it was not used |
|---|---|
| `passkey-prototyp` | Stage `dev`. `docker-compose.yml` sets `TENANT_ENV=prod`, so this realm is not created. |
| `vw-baev-mock` | Created only with `KC_ENABLE_MOCK_TENANTS=1`, which prod setup rejects. |
| The other eight prod realms | One target is enough. A test page must not be retargetable across tenants. |

`vw-baev` is the reference tenant and it exists on the prod stack. The simulator is pinned to it:

- Issuer: `https://kc.gateway-vw.de:8443/realms/vw-baev`
- Client: `portal-mock` (passkey-only). Not `portal-admin`, and not the `vw-baev` client.
- Redirect: `https://vw-baev.de/api/auth/kc/callback`, already registered. Do not add the Lambda URL to this client.

Expected result: network failure until B1 is fixed, then the passkey prompt for an unknown user. No user is created. The authorization code does not return to the simulator. Impersonation stays out. Enrollment still needs the authenticator from section 7.3.
