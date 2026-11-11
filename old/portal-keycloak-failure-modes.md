# Portal–Keycloak Interaction Failure-Mode List

**Scope:** Interaction between the external portals, AWS Lambda backends, browsers, Nginx, Keycloak, PostgreSQL, and the external identity provider.

**Sources reviewed:** `README.md`, `architecture_10-29-2026.md`, `keycloak/tenants.json`, realm provisioning code, Nginx generation, and Compose configuration.

## 1. Interaction architecture

```text
User
  |
  | HTTPS to the portal
  v
External portal (AWS)
  |
  | Browser redirect: OIDC authorization request
  v
Browser
  |
  | HTTPS TCP 8443, OIDC login and WebAuthn ceremony
  v
Nginx on IONOS VPS
  |
  | Internal Docker network
  v
Keycloak cluster (two containers)
  |
  | TLS PostgreSQL connection
  v
PostgreSQL

AWS Lambda portal backend
  |
  | Token exchange and user-management calls
  v
Keycloak
```

The portal is not hosted behind this Nginx deployment. The browser accesses the portal and Keycloak separately. Lambda communicates server-to-server with Keycloak, while WebAuthn must run in the user's browser on the Keycloak origin.

## 2. Critical and blocking failure modes

| ID | Severity | Failure | Effect | Required control |
|---|---|---|---|---|
| C1 | Blocker | Public DNS for `kc.gateway-vw.de` is missing or incorrect | Browsers and Lambda cannot reach Keycloak | Create and verify the correct A/AAAA records; test from external networks |
| C2 | Blocker | TCP `8443` is blocked by the IONOS or host firewall | All external portal, browser, and Lambda traffic fails | Permit inbound TCP 8443 to Nginx; keep backend ports closed |
| C3 | Blocker | Certificate is self-signed, expired, or does not contain the requested hostname | Browsers and Lambda reject TLS | Use a publicly trusted certificate with correct SANs; test SNI for every hostname |
| C4 | Blocker | Lambda cannot reach the Keycloak Admin API | User provisioning, recovery, or enrollment fails | Prefer a private WireGuard/IPsec path; alternatively use a tightly controlled fixed Lambda egress IP |
| C5 | Blocker | Backend impersonation creates cookies in the Lambda response instead of the browser | Redirect to Keycloak does not establish the user's Keycloak session | Do not use impersonation for enrollment; use an IDP broker, single-use enrollment token, or e-mail action token |
| C6 | Critical | `portal-admin` retains `impersonation` | A compromised portal backend can impersonate users | Remove the role after replacing the enrollment flow; monitor and alert on administrative role changes |
| C7 | Critical | Shared RP ID `gateway-vw.de` is used by multiple tenants with username-less passkeys | Passkeys from another tenant may appear in the picker on shared devices | Use username-first discovery or per-tenant RP IDs; decide before production because changing RP IDs invalidates existing passkeys |
| C8 | Critical | Multiple clients represent one portal with different flows and redirect settings | The portal may use the wrong client, flow, or security policy | Use one clearly defined production client per portal and remove unused clients |
| C9 | Critical | AWS Lambda egress IPs are dynamic and Nginx rate-limits by source IP | Legitimate Lambda token requests can receive HTTP 429 | Use a separate, tested limit for token endpoints; do not rely on client IP allowlisting |

## 3. Browser and OIDC authorization failures

### 3.1 Portal redirect failures

- The portal uses a redirect URI that is not registered exactly in Keycloak.
- The registered callback path differs from the portal implementation.
- The callback uses `http` instead of `https`.
- The callback omits the portal's correct hostname.
- The portal uses a trailing slash that is not registered, or vice versa.
- The portal uses the wrong realm or client ID.
- A tenant's `publicBaseUrl` is changed without rerunning realm provisioning.
- The public Keycloak URL is changed from `:8443` to another port without updating issuer and redirect configuration.
- A portal redirect is mistakenly registered as a wildcard.
- A portal sends the callback to a different environment.

**Controls:** exact production redirect URIs, one client per portal, automated discovery tests, and an environment-specific configuration review.

### 3.2 `state` and CSRF failures

- The portal does not generate a fresh, unpredictable `state` value.
- The portal does not bind `state` to the initiating browser session.
- The portal accepts a callback with a missing or reused `state`.
- The portal stores state only server-side without binding it to the browser.
- The portal session cookie is missing, not secure, or has an incompatible SameSite policy.
- A callback is accepted after the state has expired.

**Required control:** bind state to a secure `__Host-` browser cookie and validate it once at the callback. A server-side state store alone is insufficient.

### 3.3 PKCE failures

- The portal does not create a fresh `code_verifier` for each login.
- The verifier is not bound to the browser session.
- The verifier is exposed to the browser or logged.
- The portal uses a method other than `S256`.
- Lambda performs a token exchange without the correct verifier.
- Authorization and token requests use different client IDs or redirect URIs.

**Required control:** use Authorization Code + PKCE S256 for browser flows and test interception/replay scenarios.

### 3.4 Issuer and discovery failures

- The discovery document advertises an internal Docker name.
- The issuer omits `:8443` even though the public service uses that port.
- The issuer hostname differs from the URL used by the portal.
- The browser accesses `127.0.0.1`, an IP address, or the wrong SNI name.
- The portal validates tokens against a different issuer than the token's `iss` claim.
- The portal caches stale discovery or JWKS metadata after a Keycloak change.

**Required control:** verify discovery and issuer externally for every active realm. The expected issuer is of the form:

```text
https://kc.gateway-vw.de:8443/realms/<realm>
```

## 4. Lambda-to-Keycloak failures

### 4.1 Network failures

- Security groups or the IONOS firewall block outbound or inbound traffic.
- Lambda reaches port 443 instead of 8443.
- DNS resolution from Lambda returns the wrong address.
- IPv6 is preferred but not routed correctly.
- The Lambda timeout is shorter than the Keycloak response time.
- Nginx or Keycloak is restarting during the request.
- Lambda requests the private Docker address, which is unreachable externally.
- Lambda incorrectly assumes that Keycloak Admin REST is available on a tenant host.

### 4.2 Authentication failures

- Lambda sends the client secret in the URL or logs it.
- Lambda sends the secret in a form body when `client_secret_basic` is required.
- The wrong realm is used for client-credentials authentication.
- The service-account client is disabled or its secret was rotated.
- The token expires while Lambda is processing a request.
- Lambda caches a token beyond its expiry.
- Clock skew causes a token to be rejected.

**Required control:** use a confidential client, `client_secret_basic`, short-lived access tokens, secure secret storage, and token-expiry-aware caching.

### 4.3 Admin API authorization failures

- Lambda lacks `manage-users`, `view-users`, or `query-users`.
- Lambda receives broader permissions than required.
- A role assignment silently fails during provisioning.
- The setup client is confused with the portal-admin client.
- A new realm was created without the required service-account roles.
- `portalImpersonation` differs between tenants.
- The Admin API path is publicly exposed to solve an operational problem.
- An external portal operator receives Admin API credentials accidentally.

**Required control:** fail provisioning when role assignment fails, verify effective roles, and never expose the Admin API publicly merely to support Lambda.

## 5. User provisioning and identity-provider failures

- The portal provisions a user in the wrong realm.
- The portal sends a non-unique or mutable username.
- The `verifi_id` mapping is missing or incorrect.
- Keycloak's declarative user profile rejects or drops `verifi_id` or IDP attributes.
- The same person is created twice because the lookup key changes.
- An IDP subject changes and the portal creates a second Keycloak user.
- User creation succeeds but the portal does not persist the Keycloak user ID.
- Keycloak user creation succeeds but portal provisioning times out and retries without idempotency.
- A retry creates duplicate users or overwrites the wrong user.
- A disabled or deleted user remains active in the portal.
- A user is active in one system and removed in the other.
- IDP claims are trusted without validating issuer, audience, signature, and nonce.
- The external IDP is unavailable during onboarding.
- The IDP changes product or protocol support.
- E-mail or recovery data is missing when an e-mail action-token flow is used.

**Required control:** use an immutable tenant-scoped identity key, idempotent provisioning, explicit reconciliation, and strict IDP token validation.

## 6. Passkey enrollment failures

- Lambda attempts to perform WebAuthn itself; WebAuthn requires the user's browser and authenticator.
- A `kc_action` parameter is used without an existing Keycloak browser session.
- The portal expects an Admin API redirect to establish browser cookies.
- Keycloak session cookies are returned to Lambda instead of the browser.
- The portal copies Keycloak cookies through a response, creating a cookie trust-boundary problem.
- The enrollment token is replayed.
- The enrollment token is expired.
- The token is valid for another user, tenant, or client.
- The token is accepted more than once in the two-node cluster.
- The browser is on an origin that does not match the configured RP ID.
- The RP ID is changed after users have registered passkeys.
- User verification is unavailable on the device.
- The browser blocks the ceremony because the context is not secure.
- Safari or mobile browser privacy behaviour breaks the callback or storage cookie.
- A forked WebAuthn JavaScript file diverges after a Keycloak upgrade.
- Recovery codes are not created, lost, or not tested.
- A user has a passkey but the wrong username or tenant is selected.

**Required control:** make Keycloak create the browser session itself. Prefer IDP brokering if supported; otherwise use a short-lived, signed, single-use enrollment token consumed by a Keycloak authenticator, or a verified e-mail action token.

## 7. Logout and session failures

- Portal logout clears only the portal session.
- Keycloak logout is not called or uses the wrong post-logout URI.
- Post-logout redirect URIs are too broad.
- A stale Keycloak SSO session silently logs the user back in.
- Refresh tokens remain usable after logout.
- Portal and Keycloak session idle timeouts differ unexpectedly.
- Browser cookie SameSite or Secure attributes prevent the intended logout flow.
- A logout request is accepted without a valid client ID or redirect validation.

**Required control:** test portal logout, Keycloak logout, refresh-token revocation, and re-login in every supported browser.

## 8. Nginx routing and tenant-isolation failures

- DNS points a tenant hostname to the wrong VPS.
- SNI does not match the configured `server_name`.
- The generated Nginx file is stale after a tenant change.
- The generated file is not mounted into the running container.
- A tenant realm is routed under another tenant hostname.
- A foreign realm becomes reachable because a catch-all location is reintroduced.
- `/realms/master` or Admin API paths become publicly reachable.
- A required OIDC endpoint is accidentally blocked by an overly narrow allowlist.
- An unnecessary endpoint such as account, broker, device, or client-registration is exposed.
- `Forwarded` headers are accepted from an untrusted source.
- Client-supplied `X-Forwarded-*` values influence issuer, scheme, or IP decisions.
- `Host` and SNI validation diverge.
- Nginx rate limiting treats all Lambda calls as one client.
- Nginx reloads with an invalid certificate or configuration.
- One tenant's certificate is served to another tenant.
- The external portal assumes standard port 443 while the VPS serves 8443.

**Required control:** generate configuration from the tenant registry, run `nginx -t`, test each hostname with SNI, and keep exact realm endpoint allowlists.

## 9. Browser security and cookie failures

- Portal session cookie lacks `Secure`.
- Portal session cookie uses an incompatible SameSite value.
- OIDC callback is accepted without the browser session cookie.
- State or PKCE values are stored in local storage or URLs.
- Authorization codes or tokens are logged.
- A portal allows framing or clickjacking unexpectedly.
- Keycloak CSP blocks required login resources.
- A portal CSP blocks Keycloak redirects or WebAuthn resources.
- Cross-origin requests are allowed more broadly than required.
- A parent-domain cookie is used across tenants, enabling cookie tossing by a sibling tenant.
- `__Host-` cookie requirements are not followed where applicable.

## 10. Token, API, and data-handling failures

- Access tokens are accepted without validating signature, issuer, audience, expiry, or nonce.
- The portal uses the wrong audience or accepts tokens from another realm.
- Token scopes or roles are not checked before user-management actions.
- A token is placed in a URL or query string.
- Nginx or application logs contain bearer tokens, authorization codes, or sensitive claims.
- User attributes are returned to the portal without data minimization.
- An error response reveals internal realm names, user existence, or database details.
- Token exchange is retried in a way that causes duplicate operations.
- A service account can access users from another tenant.

## 11. Configuration and provisioning drift

- `tenants.json`, generated Nginx configuration, and live Keycloak realms disagree.
- The public portal URL changes but redirect URIs are not reprovisioned.
- The Keycloak URL changes but realm frontend URLs and issuer tests are not updated.
- A paused tenant is still active in Keycloak or Nginx.
- A mock tenant is enabled in production.
- Development wildcard redirect URIs reach a production realm.
- A client secret in the tenant register is committed or reused across tenants.
- Setup runs with the wrong `TENANT_ENV`.
- A failed setup partially creates a realm or client.
- Setup is not idempotent and retries modify an existing client unexpectedly.
- A Keycloak upgrade changes role names, WebAuthn providers, cookie behaviour, or admin API representations.
- A custom WebAuthn JavaScript fork is not reviewed after an upgrade.

## 12. Availability and recovery failures

- Both Keycloak nodes fail because they share one VPS.
- PostgreSQL fails and both Keycloak nodes become unavailable.
- The Docker network or fixed IP allocation changes.
- Nginx starts before Keycloak is healthy.
- Certificate renewal succeeds but Nginx is not reloaded.
- Certificate renewal writes a broken key or incomplete chain.
- The IONOS firewall is changed and port 8443 becomes unreachable.
- Database backups are missing, encrypted incorrectly, or cannot be restored.
- Realm configuration and user/passkey data are backed up inconsistently.
- Event retention is too short for incident investigation.
- Logs are lost when containers restart.
- No alert is generated for certificate, DNS, OIDC, or provisioning failures.

## 13. External portal and ownership failures

For portals managed by other service providers:

- The provider does not implement the exact OIDC callback.
- The provider cannot configure `:8443` in its allowlist or redirect settings.
- The provider uses a fixed-URL assumption for port 443.
- The provider cannot keep client credentials in a server-side secret store.
- The provider exposes a confidential client secret to browser JavaScript.
- The provider does not support PKCE.
- The provider cannot preserve the required portal session cookie.
- DNS changes cannot be made quickly during an incident.
- Certificate or SNI validation is implemented incorrectly.
- The provider forwards user identifiers without a stable contract.
- The provider expects the Lambda IP to be allowlisted even though Lambda egress is dynamic.
- The provider cannot support the required logout and recovery flow.

External portal operators must receive only the information they need: issuer, client ID, exact redirect URI, scopes, and protocol requirements. They must not receive Keycloak Admin credentials, impersonation capability, signing keys, or database credentials.

## 14. Priority test plan

### Before any production onboarding

1. Verify public DNS for every active Keycloak hostname.
2. Verify TCP 8443 externally from an untrusted network.
3. Verify publicly trusted certificates and all SANs.
4. Verify OIDC discovery and issuer for every active realm.
5. Verify exact redirect URI and callback handling.
6. Verify state binding and PKCE interception resistance.
7. Verify Lambda token exchange using `client_secret_basic`.
8. Verify service-account roles and tenant isolation.
9. Verify that Admin API and master realm are not public.
10. Verify the actual user-provisioning path.
11. Verify passkey enrollment in Chrome, Firefox, Safari, and iOS.
12. Verify replay, expiry, wrong-user, wrong-tenant, and wrong-client enrollment-token rejection.
13. Verify portal logout and refresh-token revocation.
14. Verify Nginx rate limits using realistic Lambda concurrency.
15. Test certificate renewal, Nginx reload, and rollback.
16. Test database restore and Keycloak realm recovery.

### Production monitoring

Monitor and alert on:

- DNS resolution failures.
- TCP 8443 availability.
- Certificate expiry and certificate fingerprint changes.
- OIDC discovery failures.
- Increased token endpoint errors.
- HTTP 401, 403, 404, and 429 rates.
- Failed user provisioning.
- Failed role assignment.
- Admin and impersonation events.
- Enrollment-token replay or expiry attempts.
- Keycloak and PostgreSQL health.
- Backup and restore failures.

## 15. Current highest-priority decisions

1. Fix public DNS, firewall exposure, and trusted certificates.
2. Choose a private or tightly restricted path for any Lambda provisioning API.
3. Replace the impersonation-based enrollment design.
4. Decide whether to retain the shared RP ID or move to per-tenant RP IDs.
5. Reduce each tenant to one production OIDC client with one documented flow.
6. Adjust rate limiting for shared AWS Lambda egress.
7. Define and test the external portal integration contract.
