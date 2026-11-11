# One-time password enrollment — 2026-11-02

Reading note. This is the no-plugin fallback, not a decision to build it.

The custom Keycloak authenticator is rejected. Not every user has an email, so the built-in email action link is not the general path. What remains without a plugin is a temporary Keycloak password. The user is already signed in to the portal. The password is a second, separate sign-in, and that sign-in is to Keycloak.

A Lambda cannot register a passkey. WebAuthn runs in the browser on `https://kc.gateway-vw.de:8443`. Keycloak must set the session cookies on a response to that browser. A backend call cannot do it.

## Verdict

| Question | Answer |
|---|---|
| Signed in to the portal first? | Yes. The portal session only permits starting enrollment. It is not a Keycloak session. |
| What triggers the backend? | A button on the portal page. The browser calls the portal, not Keycloak. |
| Must the Lambda be a special private product? | No. It is a normal Lambda. It must not have a public URL. |
| Who provides `portal-admin`? | Realm setup, once per realm. Not the user, and not the button. |
| Which password is shown? | A new one-time Keycloak password. Not the portal password. |
| What does the user do with it? | Types it once into the Keycloak login form, then creates the passkey. |
| Where is that form? | `https://kc.gateway-vw.de:8443`. Not on the portal host. |
| Where does `portal-bootstrap` come from? | The same realm setup. It is the client that can show a password form. |
| Can the user avoid typing the password? | No. Not in this option. |

## Who calls what

| Actor | Calls Keycloak? | Role |
|---|---|---|
| Browser | Yes. Authorization endpoint, login form, then the passkey pages. | Submits the password and creates the passkey. |
| Portal backend | No. | Checks the portal session and invokes the Lambda. |
| Lambda | Yes, Admin API only, over a private path. | Creates the user and sets the one-time password. |
| Callback Lambda | Yes, token endpoint only. | Exchanges the authorization code. |
| Nginx on the public host | Proxies realm login paths. | Returns 404 for `/admin`. |

## Flow

```text
User is already inside the portal, for example vw-baev.de
        |
        |  clicks "Passkey einrichten"
        v
Portal backend checks the portal session
        |
        v
Normal Lambda, no public URL
        |  creates the Keycloak user and a one-time password
        v
Portal shows that password once
        |
        v
Browser opens kc.gateway-vw.de:8443
User types the password into Keycloak's own login page
        |
        v
Keycloak sets the session cookies on that response
and runs the passkey ceremony on the same host
        |
        v
Browser returns to the portal callback with code and state
        |
        v
Callback Lambda exchanges the code
Backend removes the one-time password
```

## 1. Portal session

The member has already registered and logged in on the portal. That login stays on the portal host. No Keycloak call has happened. The portal cookie is not a Keycloak cookie, and it cannot start passkey registration by itself.

## 2. The button and the Lambda

The button is on the portal page. Its request goes to the portal backend. The backend checks the portal session and only then invokes the Lambda. The Lambda has no public Function URL and no unauthenticated API route. An anonymous caller must not be able to start it.

An API Gateway route is acceptable only if it accepts a proven portal session and the browser never receives the client secret. A public URL is not.

The Lambda is an ordinary function. "Private" means who may invoke it, and how it reaches the Admin API. It is not a special Lambda product.

### What the Lambda needs

| Input | Value |
|---|---|
| Realm | Fixed for that portal, for example `vw-baev`. Not taken from the browser. |
| Username | The portal's opaque user id, the same role as `verifi_id`. No name and no email. |
| Credential | `portal-admin` client id and secret, from the Lambda's own secret store. |

`portal-admin` is created by `keycloak/realm-template.mjs` during realm setup. It is a confidential service account with `manage-users` in that one realm. The operator stores the secret for the Lambda. The user does not know it, and the portal page never receives it.

The Lambda creates the user if absent, sets a temporary password, and sets the required action `webauthn-register-passwordless`. It does not send mail. It does not receive Keycloak session cookies. It does not create the passkey.

### Private path

Do not call `https://kc.gateway-vw.de:8443/admin/...`. The public host returns 404 for `/admin`.

```text
Portal button
  -> portal backend, session checked
    -> Lambda, holding the portal-admin secret
      -> tunnel from the AWS VPC to the VPS
        -> Keycloak Admin API
```

The tunnel is the preferred path. The other documented choice is an Admin location that allows only the Lambda's fixed egress address. The browser never uses either path. The admin console stays limited to `MGMT_CIDR`.

Reaching the Admin API is still an open blocker. Choosing a normal Lambda does not remove it.

## 3. The password the portal shows

The portal shows the one-time Keycloak password that the Lambda just generated. It is not the portal password. It is shown once, inside the existing portal session. It must not be put in a URL.

The user types it into the Keycloak login form, completes the passkey prompt, and does not reuse it. After the passkey exists, the backend removes the password credential.

## 4. The Keycloak page

The same realm setup creates `portal-bootstrap`. It is a public client bound to Keycloak's normal browser flow, so it can show a password form. `portal-mock` is the wrong client for this step: that flow asks for a passkey before the user has one.

The portal button then sends the browser to:

`https://kc.gateway-vw.de:8443/realms/vw-baev/protocol/openid-connect/auth`

with `client_id=portal-bootstrap`, `response_type=code`, `scope=openid`, the registered callback as `redirect_uri`, and PKCE S256. For the test portal the callback is `https://vw-baev.de/api/auth/kc/callback`.

Keycloak shows its own themed login page on port 8443. The user types the one-time password there. Keycloak writes `KEYCLOAK_IDENTITY` and `KEYCLOAK_SESSION` on that response, then stays on `kc.gateway-vw.de:8443` for `webauthn-register-passwordless`. After the passkey exists, Keycloak redirects the browser to the portal callback.

The callback Lambda checks `state` and exchanges the code at:

`POST /realms/{realm}/protocol/openid-connect/token`

The body is `grant_type=authorization_code`, the same `redirect_uri`, the `code`, and the PKCE verifier. A confidential client's secret goes in `Authorization: Basic`, not in the browser. `portal-bootstrap` is still a public client, so this callback has no client secret to send.

Later passkey logins use the passkey client, not this password page.

## Why the user has to type the password

The browser itself has to submit the password to Keycloak. That submission is what makes Keycloak set the session cookies on the browser.

If the Lambda submitted the password, the cookies would stop at the Lambda. That is the same failure as impersonation. The portal cannot fill a form on `kc.gateway-vw.de` from `vw-baev.de`. Putting the password in the URL would expose it in logs and in `Referer`.

Avoiding the typing requires a different option. It is not a variation of this one.

## What this option does not solve

- The public host still does not expose the Admin API. The tunnel, or an address-limited Admin location, is still required.
- A password exists, even though it is short-lived. Remove it after the passkey is stored.
- `portal-bootstrap` and `portal-mock` are both present today. One client per portal is still the target. This option needs the password-capable client only for enrollment.
- The passkey RP ID is still the shared `gateway-vw.de`.
- DNS for `kc.gateway-vw.de`, external TCP 8443, and a publicly trusted certificate are separate blockers. None of them is fixed by this flow.
