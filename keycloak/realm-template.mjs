const FLOW_ALIAS = 'browser-passkey';
const WEBAUTHN_PROVIDER = 'webauthn-authenticator-passwordless';

function makeApi(kcUrl) {
  return async (method, path, token, body) => {
    const res = await fetch(`${kcUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leer */ }
    return { status: res.status, json, text };
  };
}

/**
 * Stellt den vollständigen Zielzustand für EINEN Realm her (idempotent,
 * beliebig oft ausführbar).
 *
 * @param {object} o
 * @param {string} o.realm           Realm-Name (Isolationsgrenze = Mandant)
 * @param {string} o.displayName     Realm-Anzeigename
 * @param {string} o.loginTheme      Keycloak-Login-Theme (themes/<loginTheme>)
 * @param {string} o.rpEntityName    WebAuthn-RP-Anzeigename
 * @param {string} o.publicBaseUrl   Browser-Basis-URL des Portals (Redirect-URIs)
 * @param {string} [o.keycloakBaseUrl] Basis-URL der Keycloak-Login-Seite → Realm-Attribut
 *                                  'frontendUrl' (bestimmt Issuer und Gültigkeit der RP-ID)
 * @param {string} [o.webAuthnRpId]  WebAuthn Relying-Party-ID (Domain ohne Schema/Pfad/Port)
 * @param {string} [o.stage]         'dev' | 'prod' | 'mock' — 'prod' und 'mock' schalten
 *                                  Realm-Härtung, exakte Redirect-URIs und den Verzicht
 *                                  auf Demo-User frei; nur 'dev' lockert.
 * @param {string} o.clientSecret    Secret des Service-Account-Clients portal-admin
 * @param {string} [o.lambdaClientSecret] Secret des externen Service-Account-Clients
 *                                  'lambda-admin'. Ohne Secret wird der Client NICHT
 *                                  angelegt (opt-in, damit bestehende Deployments
 *                                  unveraendert laufen).
 * @param {string[]} [o.lambdaRoles] realm-management-Rollen fuer 'lambda-admin'
 *                                  (Default: ['view-users','query-users']).
 *                                  'impersonation' ist bewusst gesperrt.
 * @param {Array}  [o.users]         Test-User (shared/users.json → list; leer = kein Seeding)
 * @param {string} [o.token]         Admin-Token (client_credentials des Setup-Clients). Ohne
 *                                  Token wird der admin-cli-Password-Grant als Rückfall genutzt
 * @param {string} [o.kcUrl]         Keycloak-Basis-URL (Default http://localhost:8082)
 * @param {string} [o.adminUser]     Admin-Benutzer (master-Realm)
 * @param {string} [o.adminPass]     Admin-Passwort
 * @param {string} [o.bootToken]     Optionaler Bootstrap-Admin-Token als Rückfall für die
 *                                  Rollenzuweisung an den portal-admin-Service-Account
 * @param {(m:string)=>void} [o.log] Logger (Default console.log)
 */
export async function ensureRealm(o) {
  const {
    realm,
    displayName,
    loginTheme,
    rpEntityName,
    publicBaseUrl,
    keycloakBaseUrl = publicBaseUrl,
    webAuthnRpId = 'localhost',
    stage = 'dev',
    clientSecret,
    lambdaClientSecret = null,
    lambdaRoles = ['view-users', 'query-users'],
    users = [],
    kcUrl = 'http://localhost:8082',
    // Keine Defaults: Zugangsdaten nur, wenn der Bootstrap-Pfad wirklich gebraucht wird.
    adminUser = null,
    adminPass = null,
    /**
     * Optionaler Bootstrap-Admin-Token (admin-cli). Wird nur als Rückfall
     * benutzt, wenn die Rollenzuweisung mit dem Setup-Client-Token scheitert
     * (Keycloak verweigert die Vergabe von 'impersonation' an Granter, die sie
     * nicht selbst besitzen — siehe Rollen-Kommentar weiter unten).
     */
    bootToken = null,
    log = (m) => console.log(m),
  } = o;

  // 'prod' und 'mock' werden gleich gehärtet (exakte Redirect-URIs, keine
  // Wildcards, Recovery-Weg, Brute-Force-Schutz). Der Mock unterscheidet sich
  // nur in Host und Realm — nicht in der Sicherheits-Härtung.
  const IS_DEV = stage === 'dev';
  const IS_PROD = !IS_DEV;
  const label = IS_PROD ? displayName : `${displayName} (Prototyp)`;
  // 'impersonation' für den Registrierungs-Pfad (siehe Rollen-Kommentar unten).
  // Standard: aktiv — der Portal etabliert damit die Session, in der die Passkey-
  // Registrierung stattfindet. Abschaltbar je Tenant, sobald der Registrierungs-Pfad
  // eine Session ohne Impersonation etabliert (AIA allein leistet das nicht — offener
  // Punkt im Readiness-Dokument).
  const portalImpersonation = o.portalImpersonation ?? true;
  const origin = (() => {
    try {
      return new URL(publicBaseUrl).origin;
    } catch {
      return publicBaseUrl;
    }
  })();

  const api = makeApi(kcUrl);
  const tag = `[${realm}]`;

  // Admin-Token: bevorzugt von außen übergeben (client_credentials des Setup-Clients,
  // ohne Passwort). Nur als Rückfallweg der eigene admin-cli-Password-Grant — der ist
  // im Produktivbetrieb nicht erwünscht (Passwort im Klartext, siehe Readiness-Doc P1).
  let token = o.token;
  if (!token) {
    if (!adminUser || !adminPass) {
      throw new Error('Kein Token und keine Bootstrap-Zugangsdaten (adminUser/adminPass) übergeben.');
    }
    const res = await fetch(`${kcUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: adminUser,
        password: adminPass,
      }),
    });
    if (!res.ok) {
      throw new Error(`Admin-Token konnte nicht geholt werden (${res.status}) — Keycloak läuft?`);
    }
    token = (await res.json()).access_token;
  }
  if (!token) throw new Error('Admin-Token konnte nicht geholt werden — Keycloak läuft?');

  const realmProbe = await api('GET', `/admin/realms/${realm}`, token);
  let r = realmProbe.status === 200 ? realmProbe.json : null;
  let realmCreated = false;
  if (!r) {
    const created = await api('POST', `/admin/realms`, token, {
      realm,
      enabled: true,
      displayName,
      registrationAllowed: false,
    });
    if (![201, 200, 204].includes(created.status)) {
      throw new Error(`Realm anlegen fehlgeschlagen: ${created.status} ${created.text}`);
    }
    const probe2 = await api('GET', `/admin/realms/${realm}`, token);
    r = probe2.status === 200 ? probe2.json : null;
    if (!r) throw new Error('Realm nach dem Anlegen nicht abrufbar');
    realmCreated = true;
  }
  log(`${tag} ${realmCreated ? 'angelegt' : 'vorhanden'}`);

  Object.assign(r, {
    displayName,
    loginTheme,
    internationalizationEnabled: true,
    supportedLocales: ['de', 'en'],
    defaultLocale: 'de',

    webAuthnPolicyRpEntityName: rpEntityName,
    webAuthnPolicyRpId: webAuthnRpId,
    webAuthnPolicySignatureAlgorithms: ['ES256', 'RS256'],
    webAuthnPolicyAttestationConveyancePreference: 'none',
    webAuthnPolicyAuthenticatorAttachment: 'not specified',
    webAuthnPolicyRequireResidentKey: true,
    webAuthnPolicyResidentKey: 'required',
    webAuthnPolicyUserVerificationRequirement: 'required',

    webAuthnPolicyPasswordlessRpEntityName: rpEntityName,
    webAuthnPolicyPasswordlessRpId: webAuthnRpId,
    webAuthnPolicyPasswordlessSignatureAlgorithms: ['ES256', 'RS256'],
    webAuthnPolicyPasswordlessAttestationConveyancePreference: 'none',
    webAuthnPolicyPasswordlessAuthenticatorAttachment: 'not specified',
    webAuthnPolicyPasswordlessRequireResidentKey: true,
    webAuthnPolicyPasswordlessResidentKey: 'required',
    webAuthnPolicyPasswordlessUserVerificationRequirement: 'required',

    // Native Passkey-Integration (Keycloak >= 26.4) in die Standard-Login-Formulare:
    // Conditional UI (Autofill auf dem Username-Feld) + 'Sign in with Passkey'-
    // Button auf Username-/Password-Seiten. Betrifft NUR die Standard-Formulare
    // (z. B. portal-bootstrap) — der eigene Flow 'browser-passkey' (portal-mock)
    // nutzt den Passwordless-Authenticator direkt und bleibt unberührt.
    // Wichtig für den Registrierungs-Pfad: nach dem Löschen des Einmal-Passworts
    // haben Nutzer NUR noch einen Passkey — mit diesem Schalter authentifizieren
    // sie sich auf den Standard-Formularen weiterhin per Passkey (KC #40717).
    // Passkey Mediation bleibt auf Default 'conditional' (unaufdringliches
    // Autofill; kein Dialog beim Seitenladen).
    webAuthnPolicyPasswordlessPasskeysEnabled: true,
  });

  // Frontend-URL des Realms (Realm-Attribut 'frontendUrl'). Sie bestimmt, unter welcher
  // URL die Login-Seite ausgeliefert wird — und damit, gegen welche Origin der Browser
  // die RP-ID prüft. Der RP-ID muss zum Host dieser URL passen.
  r.attributes = { ...(r.attributes || {}), frontendUrl: keycloakBaseUrl };

  if (IS_PROD) {
    // Prod-Härtung (siehe Readiness-Dokument, Abschnitt P1).
    Object.assign(r, {
      sslRequired: 'external',
      passwordPolicy: 'length(12) and notUsername and passwordHistory(3)',
      bruteForceProtected: true,
      bruteForceStrategy: 'MULTIPLE',
      failureFactor: 10,
      maxFailureWaitSeconds: 900,
      accessTokenLifespan: 300,
      ssoSessionIdleTimeout: 900,
      ssoSessionMaxLifespan: 36000,
      revokeRefreshToken: true,
      refreshTokenMaxReuse: 0,
      adminEventsEnabled: true,
      adminEventsDetailsEnabled: true,
      eventsEnabled: true,
      eventsExpiration: 604800,
      defaultSignatureAlgorithm: 'RS256',
      // WICHTIG: 'browserSecurityHeaders' ist seit Keycloak 26 eine Map
      // (Map<String,String>) — als String serialisiert lehnt die Admin-API
      // den Request mit 'Cannot parse the JSON' (400) ab.
      browserSecurityHeaders: {
        xFrameOptions: 'SAMEORIGIN',
        contentSecurityPolicy: "frame-src 'self'; object-src 'none';",
      },
    });
    // Password Grant auf Realm-Ebene abschalten (Default wäre 'true').
    r.attributes = { ...r.attributes, directAccessGrantsEnabled: 'false', permanentLockout: 'false' };
    if ('directAccessGrantsEnabled' in r) r.directAccessGrantsEnabled = false;
  }

  const realmUp = await api('PUT', `/admin/realms/${realm}`, token, r);
  if (![200, 204].includes(realmUp.status)) {
    throw new Error(`Realm-Update fehlgeschlagen: ${realmUp.status} ${realmUp.text}`);
  }
  log(`${tag} Branding gesetzt (loginTheme=${loginTheme}, Anzeigename="${displayName}", Standardsprache=de)`);
  log(`${tag} Frontend-URL gesetzt (frontendUrl=${keycloakBaseUrl})`);
  log(`${tag} WebAuthn-Policies gesetzt (RP-ID=${webAuthnRpId}, resident/discoverable, passwordless)`);

  // --- User-Profil ----------------------------------------------------------
  // Keycloak 26 legt ein deklaratives User-Profil an, das nur username, email,
  // firstName und lastName kennt. Unverwaltete Attribute werden dabei stillschweigend
  // verworfen — und genau dort legt das Portal die Zuordnung zum Identitäts-
  // nachweis-Anbieter ab ('verifi_id', 'idv.<provider>.subject', 'idv.<provider>.verified').
  // Ohne diese Freigabe wäre der Attribute-Pfad der User-Auflösung tot: der Portal
  // fände den User nur noch über den Usernamen und der Anbieterwechsel ginge nicht.
  //
  // 'ENABLED' behält die unverwalteten Attribute (sie erscheinen in der Admin-Konsole
  // unter der Gruppe "User metadata"). 'DISABLED' (Default) verwirft sie.
  const profileRes = await api('GET', `/admin/realms/${realm}/users/profile`, token);
  if (profileRes.status !== 200 || !profileRes.json) {
    throw new Error(
      `User-Profil nicht lesbar (HTTP ${profileRes.status}): ${profileRes.text.slice(0, 160)}`
    );
  }
  const personalAttributes = new Set(['email', 'firstName', 'lastName']);
  let profileChanged = profileRes.json.unmanagedAttributePolicy !== 'ENABLED';
  const profileAttributes = (profileRes.json.attributes || []).map((attribute) => {
    if (!personalAttributes.has(attribute.name) || !attribute.required) return attribute;
    const { required, ...optionalAttribute } = attribute;
    profileChanged = true;
    return optionalAttribute;
  });
  if (profileChanged) {
    const profilePut = await api('PUT', `/admin/realms/${realm}/users/profile`, token, {
      ...profileRes.json,
      attributes: profileAttributes,
      unmanagedAttributePolicy: 'ENABLED',
    });
    if (profilePut.status >= 400) {
      throw new Error(
        `User-Profil nicht aktualisierbar (HTTP ${profilePut.status}): ${profilePut.text.slice(0, 160)}`
      );
    }
    log(`${tag} User-Profil: email/Name optional, unverwaltete Attribute erlaubt`);
  } else {
    log(`${tag} User-Profil: email/Name optional, unverwaltete Attribute erlaubt`);
  }

  const allFlowsBefore = (await api('GET', `/admin/realms/${realm}/authentication/flows`, token)).json;
  const flowExists = Array.isArray(allFlowsBefore) && allFlowsBefore.some((f) => f.alias === FLOW_ALIAS);
  if (!flowExists) {
    const f = await api('POST', `/admin/realms/${realm}/authentication/flows`, token, {
      alias: FLOW_ALIAS,
      description: IS_PROD
        ? 'Passkey-only-Login: username-lose WebAuthn-Passkey-Prüfung, Cookie deaktiviert; Recovery über "Try another way" (Username + Recovery Code)'
        : 'Passkey-only-Login (Prototyp): username-lose WebAuthn-Passkey-Prüfung, Cookie deaktiviert',
      providerId: 'basic-flow',
      topLevel: true,
      builtIn: false,
    });
    if (![201, 200, 204].includes(f.status)) {
      throw new Error(`Flow anlegen fehlgeschlagen: ${f.status} ${f.text}`);
    }
    log(`${tag} Flow ${FLOW_ALIAS} angelegt`);
  } else {
    log(`${tag} Flow ${FLOW_ALIAS} vorhanden`);
  }

  // ── Recovery-Weg (nur Prod) ────────────────────────────────────────────────
  // Zielstruktur (FR-36..FR-39):
  //   Cookie [DISABLED]
  //   WebAuthn Passwordless Authenticator [ALTERNATIVE]
  //   recovery [ALTERNATIVE]            ← Sub-Flow (basic-flow)
  //     ├─ auth-username-form [REQUIRED]
  //     └─ auth-recovery-authn-code-form [REQUIRED]
  //
  // Warum Sub-Flow und nicht zwei flache ALTERNATIVE-Executions: Keycloak rendert bei
  // zwei flachen Alternativen nur die erste; der Code-Schritt wird nie erreicht. Erst
  // ein Sub-Flow mit REQUIREten Schritten verkettet Identifikation → Code.
  // Warum WebAuthn ALTERNATIVE: "Andere Methode versuchen" erscheint nur, wenn ein
  // alternativer Zweig existiert; mit REQUIRED ist der Recovery-Weg unerreichbar.
  // Provider-ID verifiziert über GET /admin/realms/{realm}/authentication/authenticator-providers:
  //   "recovery-code-form" existiert NICHT (→ HTTP 400), korrekt ist
  //   "auth-recovery-authn-code-form".
  const RECOVERY_FLOW = 'recovery';
  const RECOVERY_CODE_PROVIDER = 'auth-recovery-authn-code-form';
  const USERNAME_FORM_PROVIDER = 'auth-username-form';
  const FORM_FLOW_PROVIDER = 'registration-page-form';

  const listExecutions = async (alias) => {
    const res = await api('GET', `/admin/realms/${realm}/authentication/flows/${alias}/executions`, token);
    if (!Array.isArray(res.json)) {
      throw new Error(`Executions von ${alias} unerwartet: ${res.status} ${res.text}`);
    }
    return res.json;
  };

  const setRequirement = async (alias, exec, requirement, priority) => {
    const put = await api('PUT', `/admin/realms/${realm}/authentication/flows/${alias}/executions`, token, {
      id: exec.id,
      requirement,
      priority,
    });
    if (put.status >= 400) {
      throw new Error(
        `Requirement ${exec.providerId || exec.displayName} → ${requirement} fehlgeschlagen: ${put.status} ${put.text}`
      );
    }
  };

  const addExecution = async (alias, provider) => {
    const res = await api(
      'POST', `/admin/realms/${realm}/authentication/flows/${alias}/executions/execution`,
      token, { provider }
    );
    if (![200, 201, 204].includes(res.status)) {
      throw new Error(`Execution ${provider} in ${alias} fehlgeschlagen: ${res.status} ${res.text}`);
    }
    const created = (await listExecutions(alias)).find((e) => e.providerId === provider);
    if (!created) throw new Error(`Execution ${provider} nach dem Anlegen nicht gefunden`);
    return created;
  };

  // 1. Altlasten entfernen: frühere flache Recovery-Executions (falsches Modell, falsche ID).
  //    Ohne diesen Schritt bleiben konkurrierende Zweige im Flow stehen.
  const STALE_PROVIDERS = [USERNAME_FORM_PROVIDER, RECOVERY_CODE_PROVIDER, 'recovery-code-form'];
  for (const stale of (await listExecutions(FLOW_ALIAS)).filter((e) => STALE_PROVIDERS.includes(e.providerId))) {
    const del = await api('DELETE', `/admin/realms/${realm}/authentication/executions/${stale.id}`, token);
    if (del.status >= 400) {
      throw new Error(`Altlast ${stale.providerId} nicht entfernbar: ${del.status} ${del.text}`);
    }
    log(`${tag} Altlast ${stale.providerId} aus ${FLOW_ALIAS} entfernt`);
  }

  // 2. Basis: Cookie deaktiviert, Passkey als (in Prod) alternative Methode
  const ensureInFlow = async (providerId, requirement, priority) => {
    const found = (await listExecutions(FLOW_ALIAS)).find((e) => e.providerId === providerId);
    const exec = found || (await addExecution(FLOW_ALIAS, providerId));
    await setRequirement(FLOW_ALIAS, exec, requirement, priority);
    log(`${tag} flow ${providerId} → ${requirement}`);
  };

  await ensureInFlow('auth-cookie', 'DISABLED', 0);
  await ensureInFlow(WEBAUTHN_PROVIDER, IS_PROD ? 'ALTERNATIVE' : 'REQUIRED', 1);

  // 3. Recovery-Sub-Flow (idempotent) + seine zwei Schritte
  if (IS_PROD) {
    const findSubFlow = async () =>
      (await listExecutions(FLOW_ALIAS)).find(
        (e) => e.authenticationFlow === true &&
          (e.displayName === RECOVERY_FLOW || e.flowAlias === RECOVERY_FLOW || e.alias === RECOVERY_FLOW)
      );

    let sub = await findSubFlow();
    if (!sub) {
      const res = await api(
        'POST', `/admin/realms/${realm}/authentication/flows/${FLOW_ALIAS}/executions/flow`,
        token, {
          alias: RECOVERY_FLOW,
          type: 'basic-flow',
          provider: FORM_FLOW_PROVIDER,
          description: 'Recovery: Identifikation per Username, dann Einmalcode (FR-37)',
        }
      );
      if (![200, 201, 204].includes(res.status)) {
        throw new Error(`Recovery-Sub-Flow nicht anlegbar: ${res.status} ${res.text}`);
      }
      log(`${tag} Sub-Flow ${RECOVERY_FLOW} angelegt`);
      sub = await findSubFlow();
    }
    if (!sub) throw new Error(`Sub-Flow ${RECOVERY_FLOW} nach dem Anlegen nicht gefunden`);
    await setRequirement(FLOW_ALIAS, sub, 'ALTERNATIVE', 2);
    log(`${tag} flow ${RECOVERY_FLOW}[ALTERNATIVE]`);

    for (const [provider, priority] of [[USERNAME_FORM_PROVIDER, 0], [RECOVERY_CODE_PROVIDER, 1]]) {
      const found = (await listExecutions(RECOVERY_FLOW)).find((e) => e.providerId === provider);
      const exec = found || (await addExecution(RECOVERY_FLOW, provider));
      await setRequirement(RECOVERY_FLOW, exec, 'REQUIRED', priority);
      log(`${tag} flow ${RECOVERY_FLOW}/${provider} → REQUIRED`);
    }
  }

  r.browserFlow = 'browser';
  await api('PUT', `/admin/realms/${realm}`, token, r);
  const final = (await api('GET', `/admin/realms/${realm}/authentication/flows/${FLOW_ALIAS}/executions`, token)).json;
  log(`${tag} Reihenfolge: ` + final.map((e) => `${e.displayName}[${e.requirement}]`).join(' → ') + `  (Realm-Default browserFlow=browser, portal-mock → ${FLOW_ALIAS})`);

  const allFlows = (await api('GET', `/admin/realms/${realm}/authentication/flows`, token)).json;
  const flowIdByAlias = new Map(Array.isArray(allFlows) ? allFlows.map((f) => [f.alias, f.id]) : []);
  if (!flowIdByAlias.has('browser')) {
    throw new Error('Standard-Flow "browser" nicht im Realm gefunden');
  }

  const ensureClient = async (rep) => {
    const { flowBinding } = rep;
    const repJson = { ...rep };
    delete repJson.flowBinding;
    if (flowBinding) {
      const overrides = {};
      for (const [binding, alias] of Object.entries(flowBinding)) {
        const flowId = flowIdByAlias.get(alias);
        if (!flowId) throw new Error(`Flow "${alias}" für Binding "${binding}" nicht gefunden`);
        overrides[binding] = flowId;
      }
      repJson.authenticationFlowBindingOverrides = overrides;
    }
    const existing = await api('GET', `/admin/realms/${realm}/clients?clientId=${rep.clientId}`, token);
    if (existing.status === 200 && existing.json?.length) {
      const cur = existing.json[0];
      if (rep.secret !== undefined) {
        const sec = await api('GET', `/admin/realms/${realm}/clients/${cur.id}/client-secret`, token);
        if (sec.status !== 200 || sec.json?.value !== rep.secret) {
          const del = await api('DELETE', `/admin/realms/${realm}/clients/${cur.id}`, token);
          if (![200, 204].includes(del.status)) {
            throw new Error(`Client ${rep.clientId} löschen fehlgeschlagen: ${del.status} ${del.text}`);
          }
          const created = await api('POST', `/admin/realms/${realm}/clients`, token, repJson);
          if (![201, 200, 204].includes(created.status)) {
            throw new Error(`Client ${rep.clientId} neu anlegen fehlgeschlagen: ${created.status} ${created.text}`);
          }
          const got = await api('GET', `/admin/realms/${realm}/clients?clientId=${rep.clientId}`, token);
          log(`${tag} client ${rep.clientId} neu angelegt (Secret wich ab)`);
          return got.json[0];
        }
      }

      const fullRes = await api('GET', `/admin/realms/${realm}/clients/${cur.id}`, token);
      const curFull = fullRes.status === 200 ? fullRes.json : cur;
      const sameArr = (a = [], b = []) => [...a].sort().join('\n') === [...b].sort().join('\n');
      const curBindings = curFull.authenticationFlowBindingOverrides ?? {};
      const desiredBindings = repJson.authenticationFlowBindingOverrides ?? {};
      const bindingDiff = Object.keys(desiredBindings).some(
        (b) => curBindings[b] !== desiredBindings[b]
      );
      const redirectDiff =
        repJson.redirectUris !== undefined && !sameArr(curFull.redirectUris, repJson.redirectUris);

      const curAttrs = curFull.attributes ?? {};
      const desiredAttrs = repJson.attributes ?? {};
      const attrDiff = Object.keys(desiredAttrs).some((k) => curAttrs[k] !== desiredAttrs[k]);

      if (bindingDiff || redirectDiff || attrDiff) {
        const merged = { ...curFull };
        if (bindingDiff) {
          merged.authenticationFlowBindingOverrides = { ...curBindings, ...desiredBindings };
        }
        if (redirectDiff) merged.redirectUris = repJson.redirectUris;
        if (attrDiff) merged.attributes = { ...curAttrs, ...desiredAttrs };

        const upd = await api('PUT', `/admin/realms/${realm}/clients/${cur.id}`, token, merged);
        if (![200, 204].includes(upd.status)) {
          throw new Error(`Client ${rep.clientId} update fehlgeschlagen: ${upd.status} ${upd.text}`);
        }
        const changed = [
          bindingDiff ? 'Flow-Binding' : null,
          redirectDiff ? 'redirectUris' : null,
          attrDiff ? 'attributes' : null,
        ]
          .filter(Boolean)
          .join(', ');
        log(`${tag} client ${rep.clientId} nachgezogen: ${changed}`);
      }
      log(`${tag} client ${rep.clientId} vorhanden`);
      return curFull;
    }
    const created = await api('POST', `/admin/realms/${realm}/clients`, token, repJson);
    if (![201, 200, 204].includes(created.status)) {
      throw new Error(`Client ${rep.clientId} anlegen fehlgeschlagen: ${created.status} ${created.text}`);
    }
    const got = await api('GET', `/admin/realms/${realm}/clients?clientId=${rep.clientId}`, token);
    return got.json[0];
  };

  // Redirect-URIs und Origins: in Prod exakt (kein Wildcard, kein '+'), im Dev wie bisher.
  const redirectUris = IS_PROD ? [`${publicBaseUrl}/api/auth/kc/callback`] : [`${publicBaseUrl}/*`];
  const webOrigins = IS_PROD ? [origin] : ['+'];

  const portalClient = await ensureClient({
    clientId: 'portal-mock',
    name: label,
    protocol: 'openid-connect',
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    enabled: true,
    redirectUris,
    webOrigins,
    flowBinding: { browser: FLOW_ALIAS },
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': `${publicBaseUrl}/logout/verimi##${publicBaseUrl}/logout/done`,
    },
  });
  log(
    `${tag} client portal-mock redirectUris: ${portalClient.redirectUris.join(', ')} | postLogout: ${portalClient.attributes?.['post.logout.redirect.uris'] ?? '(keine)'}`
  );

  await ensureClient({
    clientId: 'portal-bootstrap',
    name: IS_PROD
      ? `${displayName} — Ersteinrichtung Passkey`
      : `${displayName} — Ersteinrichtung Passkey (Prototyp)`,
    protocol: 'openid-connect',
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    enabled: true,
    redirectUris,
    webOrigins,
    flowBinding: { browser: 'browser' },
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': `${publicBaseUrl}/logout/verimi##${publicBaseUrl}/logout/done`,
    },
  });
  log(`${tag} client portal-bootstrap vorhanden (Flow: browser/Standard)`);

  const adminClient = await ensureClient({
    clientId: 'portal-admin',
    name: IS_PROD
      ? `${displayName} — Portal-Backend (Admin-API)`
      : `${displayName} — Portal-Backend (Admin-API, Prototyp)`,
    protocol: 'openid-connect',
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    enabled: true,
    secret: clientSecret,
  });
  log(`${tag} client portal-admin Secret gesetzt (${clientSecret.length} Zeichen)`);

  const sa = await api('GET', `/admin/realms/${realm}/clients/${adminClient.id}/service-account-user`, token);
  const saUser = sa.status === 200 ? sa.json : null;
  if (!saUser?.id) throw new Error('Service-Account-User von portal-admin nicht abrufbar');
  // Least Privilege für den Portal-Service-Account ('portal-admin'):
  //   manage-users → Recovery Stufe 3 (Passkey löschen, Required Action setzen)
  //   view-users, query-users → Anzeige der Kontodaten im Portal
  //   NICHT mehr: view-clients, manage-clients, view-events, manage-events, view-realm
  //   'impersonation' bleibt vorerst AUSSCHLIESSLICH für den Registrierungs-Pfad
  //   (der Portal etabliert damit die Session, in der die Passkey-Registrierung
  //   stattfindet). AIA (kc_action=webauthn-register-passwordless) ersetzt bereits den
  //   Action-Trigger, aber nicht die authentifizierte Session eines Users ohne Credential —
  //   siehe offene Punkte 'Impersonation entfernen'.
  const wanted = ['manage-users', 'view-users', 'query-users'];
  if (portalImpersonation) wanted.push('impersonation');
  const rmClients = (await api('GET', `/admin/realms/${realm}/clients?clientId=realm-management`, token)).json;
  const rmClient = rmClients?.[0];
  if (!rmClient) throw new Error(`realm-management-Client im Realm '${realm}' nicht gefunden`);
  const roles = (await api('GET', `/admin/realms/${realm}/clients/${rmClient.id}/roles`, token)).json || [];
  const toAssign = roles.filter((x) => wanted.includes(x.name));
  const missing = wanted.filter((w) => !toAssign.some((x) => x.name === w));
  if (missing.length) {
    throw new Error(
      `realm-management kennt die benötigten Rollen nicht: ${missing.join(', ')} ` +
        `(vorhanden: ${roles.map((r) => r.name).join(', ')})`
    );
  }

  // --- Rollenzuweisung an den portal-admin-Service-Account --------------------
  //
  // Die Rollen werden DIREKT als Client-Rollen des realm-management vergeben
  // (`POST /users/{id}/role-mappings/clients/{realm-management-id}`).
  //
  // Warum das der Setup-Client darf (und warum es vorher nicht klappte):
  //   Keycloak legt im Master-Realm je Mandanten einen Admin-Client
  //   '<realm>-realm' an und gibt dem ERSTELLER des Realms darauf alle
  //   Verwaltungsrollen — mit einer einzigen Ausnahme: 'impersonation'.
  //   Der Setup-Client ist der Ersteller, hält also manage-users, view-users,
  //   query-users und manage-clients und darf damit Client-Rollen vergeben.
  //   Für 'impersonation' gilt in Keycloak die Regel: wer sie vergeben will,
  //   muss sie selbst besitzen — sonst 403.
  //
  // Deshalb wird 'impersonation' einmalig über den Master-Client '<realm>-realm'
  // nachgezogen (setup-realms.mjs → ensureRealmAdminClientRoles). Fehlt dieser
  // Grant, weicht die Zuweisung auf den Bootstrap-Admin aus; ohne Bootstrap
  // bricht sie mit einer klaren Meldung ab.
  //
  // WICHTIG: Vorher wurde die Antwort der Admin-API nie geprüft — der Fehler
  // wurde still geschluckt, das Portal bekam 403 und die Registrierung lief
  // ins Leere. Jetzt wird jeder Schritt geprüft und geworfen.
  const SA_ROLES_PATH = `/admin/realms/${realm}/users/${saUser.id}/role-mappings/clients/${rmClient.id}`;

  /** Rollen dem Service-Account zuweisen; token-Fallback auf den Bootstrap-Admin. */
  const assignRoles = async (useToken, roleList) => {
    for (const role of roleList) {
      const res = await api('POST', SA_ROLES_PATH, useToken, [{ id: role.id, name: role.name }]);
      if (res.status < 400) continue;
      if (bootToken && useToken !== bootToken) {
        // Zweiter Versuch mit dem Bootstrap-Admin (der darf alles).
        const retry = await api('POST', SA_ROLES_PATH, bootToken, [{ id: role.id, name: role.name }]);
        if (retry.status < 400) continue;
        throw new Error(
          `Rolle '${role.name}' für portal-admin nicht zuweisbar ` +
            `(Setup-Token HTTP ${res.status}, Bootstrap HTTP ${retry.status}): ${retry.text.slice(0, 160)}`
        );
      }
      throw new Error(
        `Rolle '${role.name}' für portal-admin nicht zuweisbar (HTTP ${res.status}): ${res.text.slice(0, 160)}. ` +
          `Der Setup-Client braucht die Rolle 'impersonation' auf dem Master-Client ` +
          `'${realm}-realm' — einmalig mit KC_ADMIN_USER/KC_ADMIN_PASS ausführen.`
      );
    }
  };

  await assignRoles(token, toAssign);
  log(`${tag} client portal-admin Rollen: ${toAssign.map((x) => x.name).join(', ')}`);

  // --- Externer Service-Account-Client 'lambda-admin' --------------------------
  //
  // WARUM EIN EIGENER CLIENT:
  //   'portal-admin' ist die Identitaet des Portal-Backends und haelt in Prod
  //   zusaetzlich 'impersonation' (Registrierungs-Pfad). Wuerde eine AWS Lambda
  //   dasselbe Secret benutzen, koennte ein Leak dieses Secrets jede beliebige
  //   User-Session im Realm uebernehmen. Externe Konsumenten bekommen daher ein
  //   eigenes Secret mit eigenem, minimalem Rollenset.
  //
  // OPT-IN: Ohne Secret wird der Client NICHT angelegt. So laufen bestehende
  // Deployments ohne Lambda-Anbindung unveraendert weiter.
  if (lambdaClientSecret) {
    const allowedLambdaRoles = new Set(['view-users', 'query-users', 'manage-users', 'view-realm']);
    const forbidden = lambdaRoles.filter((r) => !allowedLambdaRoles.has(r));
    if (forbidden.length) {
      throw new Error(
        `lambdaRoles enthaelt nicht erlaubte Rollen: ${forbidden.join(', ')} ` +
          `(erlaubt: ${[...allowedLambdaRoles].join(', ')}; 'impersonation' ist gesperrt)`
      );
    }

    const lambdaClient = await ensureClient({
      clientId: 'lambda-admin',
      name: `${displayName} - Externer Service-Account (Lambda)`,
      protocol: 'openid-connect',
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      enabled: true,
      secret: lambdaClientSecret,
      // Kurzlebige Tokens: ein geleaktes Access-Token ist nach 5 Minuten wertlos.
      // Lambda cached den Token bis kurz vor Ablauf (siehe lambda-admin-client.md).
      attributes: { 'access.token.lifespan': '300' },
    });

    // ensureClient gleicht publicClient/serviceAccountsEnabled nicht ab. Ein
    // versehentlich public konfigurierter Client wuerde sonst still 401 liefern.
    const lambdaChecked = (
      await api('GET', `/admin/realms/${realm}/clients/${lambdaClient.id}`, token)
    ).json;
    if (!lambdaChecked || lambdaChecked.publicClient !== false || lambdaChecked.serviceAccountsEnabled !== true) {
      throw new Error(
        `client lambda-admin falsch konfiguriert: publicClient=${lambdaChecked?.publicClient}, ` +
          `serviceAccountsEnabled=${lambdaChecked?.serviceAccountsEnabled}`
      );
    }

    const lsa = await api(
      'GET',
      `/admin/realms/${realm}/clients/${lambdaClient.id}/service-account-user`,
      token
    );
    const lsaUser = lsa.status === 200 ? lsa.json : null;
    if (!lsaUser?.id) throw new Error('Service-Account-User von lambda-admin nicht abrufbar');

    const lRoles = roles.filter((x) => lambdaRoles.includes(x.name));
    const lMissing = lambdaRoles.filter((w) => !lRoles.some((x) => x.name === w));
    if (lMissing.length) {
      throw new Error(`realm-management kennt die lambda-Rollen nicht: ${lMissing.join(', ')}`);
    }

    const lambdaRolesPath =
      `/admin/realms/${realm}/users/${lsaUser.id}/role-mappings/clients/${rmClient.id}`;
    const assigned = (await api('GET', lambdaRolesPath, token)).json || [];
    const assignedNames = new Set(assigned.map((r) => r.name));
    const lToAssign = lRoles.filter((r) => !assignedNames.has(r.name));
    for (const role of lToAssign) {
      const res = await api('POST', lambdaRolesPath, token, [{ id: role.id, name: role.name }]);
      if (res.status >= 400) {
        throw new Error(
          `Rolle '${role.name}' fuer lambda-admin nicht zuweisbar (HTTP ${res.status}): ` +
            res.text.slice(0, 160)
        );
      }
    }
    log(
      `${tag} client lambda-admin Rollen: ${lambdaRoles.join(', ')}` +
        (lToAssign.length ? ' (neu zugewiesen)' : '')
    );
  } else {
    log(`${tag} client lambda-admin uebersprungen (kein Secret) - externe Service-Accounts aus`);
  }

  const reqActions = (await api('GET', `/admin/realms/${realm}/authentication/required-actions`, token)).json;
  const reg = reqActions.find((a) => a.alias === 'webauthn-register-passwordless');
  if (!reg) throw new Error('Required-Action webauthn-register-passwordless nicht gefunden');
  if (!reg.enabled) {
    await api('PUT', `/admin/realms/${realm}/authentication/required-actions/${reg.alias}`, token, { ...reg, enabled: true });
    log(`${tag} required-action webauthn-register-passwordless aktiviert`);
  } else {
    log(`${tag} required-action webauthn-register-passwordless bereits aktiv`);
  }

  if (IS_PROD) {
    // Recovery Stufe 2: Recovery Authentication Codes (12 Einmalcodes, Keycloak >= 26.3).
    // Der Alias ist je Keycloak-Version unterschiedlich geschrieben → wir suchen nach
    // Alias-/Namensmuster und aktivieren die Action zusätzlich als Default Action, damit
    // sie bei der Registrierung automatisch eingerichtet wird.
    const recovery = reqActions.find(
      (a) => /recovery/i.test(a.alias || '') || /recovery/i.test(a.name || '')
    );
    if (!recovery) {
      log(
        `${tag} WARNUNG: Required-Action für Recovery Codes nicht gefunden — ` +
          `Recovery-Stufe 2 nicht aktiv (Keycloak < 26.3?)`
      );
    } else if (!recovery.enabled || !recovery.defaultAction) {
      await api(
        'PUT',
        `/admin/realms/${realm}/authentication/required-actions/${recovery.alias}`,
        token,
        { ...recovery, enabled: true, defaultAction: true }
      );
      log(`${tag} required-action ${recovery.alias} aktiviert (Default: ja) — Recovery-Codes`);
    } else {
      log(`${tag} required-action ${recovery.alias} bereits aktiv (Default: ja)`);
    }
  }

  if (!users.length) {
    log(
      `${tag} keine Demo-User angelegt (Prod-Realm — Nutzer entstehen über Identitätsnachweis/Onboarding)`
    );
  }
  for (const u of users) {
    const existing = await api('GET', `/admin/realms/${realm}/users?username=${encodeURIComponent(u.verifi_id)}&exact=true`, token);
    if (existing.status === 200 && existing.json?.length) {
      const cur = existing.json[0];
      const hasPersonalData = cur.firstName != null || cur.lastName != null || cur.email != null;
      if (hasPersonalData || !cur.attributes?.verifi_id?.includes(u.verifi_id)) {
        await api('PUT', `/admin/realms/${realm}/users/${cur.id}`, token, {
          ...cur,
          firstName: null,
          lastName: null,
          email: null,
          attributes: { ...(cur.attributes || {}), verifi_id: [u.verifi_id] },
        });
        log(`${tag} user ${u.username} synchronisiert (nur verifi_id)`);
      } else {
        log(`${tag} user ${u.username} vorhanden`);
      }
      continue;
    }
    await api('POST', `/admin/realms/${realm}/users`, token, {
      username: u.verifi_id,
      enabled: true,
      attributes: { verifi_id: [u.verifi_id] },
    });
    log(`${tag} user ${u.username} angelegt (verifi_id=${u.verifi_id})`);
  }

  log(`${tag} Setup abgeschlossen. Account/Passkeys: ${kcUrl}/realms/${realm}/account`);
}
