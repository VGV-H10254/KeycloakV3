# Security Measures Considered

## Verdict

The project has considered a solid baseline for network isolation, Keycloak hardening, TLS, secret handling, tenant isolation, and least privilege.

Several operational controls are documented but must still be implemented and verified on the IONOS VPS before production.

## Network and exposure

- Nginx is the only public entry point.
- Rootless Docker uses host port `8443` mapped to Nginx container port `443`.
- Keycloak ports `8080` and `9000` are not published.
- PostgreSQL port `5432` is not published.
- Services communicate over the private Docker network `172.30.0.0/24`.
- Nginx has the fixed address `172.30.0.10`.
- Keycloak trusts forwarded headers only from `172.30.0.10/32`.
- The administration interface uses a separate hostname.
- Admin access is restricted with `MGMT_CIDR`, intended to be `87.128.200.94/32`.
- Unknown TLS/SNI hostnames are rejected.
- Public HTTP is not exposed.
- Direct external access to Keycloak and PostgreSQL is prevented.
- Host firewall restrictions for SSH, monitoring, and administration are expected.

## Nginx and HTTP security

- Forwarding headers are overwritten rather than appended.
- `$remote_addr` is used instead of `$proxy_add_x_forwarded_for`.
- Client-supplied forwarding headers are removed.
- Keycloak accepts proxy headers only from the trusted Nginx address.
- Tenant routing uses explicit virtual hosts.
- Exact realm locations prevent cross-tenant realm access.
- `/realms/master` is not exposed through tenant hosts.
- Admin paths are not exposed through tenant hosts.
- Health and metrics endpoints are not publicly routed.
- Unknown paths return `404` in Keycloak-only mode.
- Request body size is limited.
- Connection and proxy timeouts are bounded.
- Keycloak realm requests are rate-limited to `10r/s` with a burst of `30`.
- `server_tokens` is disabled.
- Sensitive forwarding and tracing headers are removed.
- Query strings are excluded from Nginx access logs to avoid logging OIDC parameters.

## TLS and transport security

- Public access is HTTPS-only.
- TLS 1.2 and TLS 1.3 are allowed.
- Weak CBC and RSA key-transport ciphers are excluded.
- ECDHE forward secrecy is used.
- AEAD cipher suites are used.
- TLS session tickets are disabled.
- HSTS is enabled per virtual host.
- PostgreSQL TLS is enabled.
- PostgreSQL certificates are validated using `verify-full` and a CA certificate.
- PostgreSQL uses SCRAM-SHA-256 password encryption.
- Keycloak embedded cluster mTLS is enabled.
- Internal backend HTTP is limited to the private Docker network.

## Secret management

- Secrets are mounted as Docker secrets under `/run/secrets`.
- Secrets are not passed as normal environment variables.
- Secret files and private keys are excluded from Git.
- The secret directory uses mode `0700`.
- Secret files use mode `0400`.
- Secrets are generated with `openssl rand -hex 32`.
- Secret values are not printed to the console.
- Database, bootstrap-admin, setup-client, and portal-admin secrets are separate.
- Secret rotation warns that the database password must also be changed in PostgreSQL.
- Bootstrap credentials are intended to be disabled/deleted after initial setup.
- The bootstrap password file is intended to be removed after setup.

## Keycloak realm hardening

Production realms configure:

- `sslRequired: external`.
- Password length of at least 12 characters.
- Passwords that cannot contain the username.
- Password history of three previous passwords.
- Brute-force protection.
- Multiple-step brute-force strategy.
- Failure threshold of 10.
- Maximum failure wait of 900 seconds.
- Five-minute access-token lifetime.
- Fifteen-minute SSO idle timeout.
- Ten-hour maximum SSO lifetime.
- Refresh-token revocation.
- Zero refresh-token reuse.
- RS256 as the default signature algorithm.
- Admin event logging.
- Detailed admin event logging.
- User event logging.
- Seven-day event retention.
- Password/direct-access grants disabled for production clients.

## OIDC client security

- Production redirect URIs are exact and do not use wildcards.
- Production web origins are exact portal origins.
- PKCE with S256 is configured.
- Direct access grants are disabled.
- Implicit flow is disabled for the setup client.
- `portal-admin` is a confidential service-account client.
- Browser clients do not receive client secrets.
- Explicit logout redirect URLs are configured.

## Passkey and WebAuthn security

- WebAuthn/passkey authentication is enabled.
- Discoverable credentials are required.
- Resident keys are required.
- User verification is required.
- Passwordless policies are configured.
- Each tenant has an explicit WebAuthn RP ID.
- Realm frontend URLs and RP IDs are aligned.
- Passkey registration is an explicit required action.
- Recovery-code support is considered.
- Mock tenants use separate realms and do not pollute production passkeys.

## Authorisation and least privilege

### Setup client

- Confidential client.
- Service-account authentication.
- Browser flow disabled.
- Direct access grants disabled.
- Client-credentials flow used for normal provisioning.
- Only required realm-management permissions are assigned.

### Portal administration client

`portal-admin` is configured with only the required permissions:

- `manage-users`
- `view-users`
- `query-users`

The following unnecessary permissions were explicitly excluded:

- `view-clients`
- `manage-clients`
- `view-events`
- `manage-events`
- `view-realm`

The high-privilege `impersonation` role remains only for the passkey-registration workflow and is an open security concern.

## Tenant isolation

- One Keycloak realm is used per tenant.
- Tenant hostnames and realms are explicitly mapped.
- Tenant RP IDs are explicitly mapped.
- Nginx configuration is generated from the tenant registry.
- Exact realm locations prevent cross-tenant access.
- The master realm is not exposed through tenant hosts.
- Mock tenants use separate hosts and realms.
- The tenant registry is the intended single source of truth.

## Container and deployment security

- Rootless Docker is supported.
- Certificates are mounted read-only.
- Setup configuration is mounted read-only.
- Keycloak has a 2 GB memory limit.
- PostgreSQL and Keycloak health checks are configured.
- Services restart automatically with `unless-stopped`.
- Graceful Keycloak shutdown is configured.
- Keycloak uses an optimised image build.
- Keycloak image version `26.7.5` is pinned.
- Bootstrap and setup jobs use explicit Compose profiles.
- Production does not mount development test users.
- Nginx configuration is generated to reduce configuration drift.

## Logging and observability

- JSON console logging is enabled.
- ECS-compatible log format is used.
- Keycloak access logging is enabled.
- Admin events are logged.
- User events are logged.
- Nginx access logging is enabled.
- OIDC query parameters are excluded from Nginx logs.
- Keycloak events have bounded retention.

## Availability controls

- Two Keycloak containers are configured.
- PostgreSQL health checks are configured.
- Keycloak readiness checks are configured.
- Automatic service restarts are configured.
- Graceful shutdown is configured.
- Nginx upstream keepalive is configured.
- Request and connection timeouts are bounded.
- Resource limits are configured.
- Configuration uses fail-fast environment variables.

The two Keycloak nodes and PostgreSQL still run on the same VPS. The VPS therefore remains a single point of failure.

## Controls not yet proven or not visible in the repository

- IONOS firewall rules.
- Host firewall configuration.
- SSH hardening and key-only enforcement.
- Automated encrypted backups.
- Restore testing.
- Vulnerability scanning.
- Container image signature verification.
- Dependency update process.
- Central SIEM or security alerting.
- DDoS or WAF protection.
- Explicit MFA configuration for Keycloak administrators.
- VPN or private management network.
- Automated secret rotation.
- Automated certificate renewal.
- Incident-response procedures.
- Formal penetration testing.
- Disaster-recovery architecture.

## Important security risks

1. AWS Lambda clients have dynamic IP addresses, so source-IP allowlisting cannot reliably secure portal-to-Keycloak traffic. Use OIDC client authentication, exact redirect URIs, PKCE, TLS, and authorization.
2. `impersonation` is a high-privilege role and should be removed if passkey registration can use a normal authenticated user session.
3. Two Keycloak nodes on one VPS do not provide protection against VPS failure.
4. Backup and restore evidence is currently absent.
5. Admin IP allowlisting is operationally fragile and should ideally be replaced or supplemented by a VPN/private management network.
6. Security must be verified on the VPS using effective Docker exposure, firewall checks, Nginx syntax checks, certificate checks, OIDC discovery checks, and external port scanning.
