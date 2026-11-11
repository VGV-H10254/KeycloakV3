# Produktions-Image für Keycloak.
#
# Zwei Stufen: der Builder fixiert alle Optionen, die zur Build-Zeit feststehen müssen
# (KC_CACHE, KC_FEATURES …). Der Runtime-Container startet mit "start --optimized" —
# das schlägt fehl, wenn eine zur Laufzeit geänderte Option von der Build-Option abweicht.
#
# WICHTIG: Jede Option, die Keycloak zur BUILD-Zeit kennt, muss hier im Builder
# gesetzt werden — und darf zur Laufzeit NICHT abweichend gesetzt werden.
# Sonst startet der Container mit 'start --optimized' nicht:
#
#   The following build time options have values that differ from what is
#   persisted - the new values will NOT be used until another build is run
#
# Betroffen sind hier: features-disabled, feature-stateless, log-mdc-enabled.
# Sie stehen deshalb UNTEN in diesem Block und werden in docker-compose.yml
# NICHT mehr gesetzt.
FROM quay.io/keycloak/keycloak:26.8.2 AS builder

ENV KC_DB=postgres \
    KC_CACHE=ispn \
    KC_CACHE_STACK=jdbc-ping \
    KC_FEATURES=stateless \
    KC_FEATURES_DISABLED=docker \
    KC_FEATURE_STATELESS=enabled \
    KC_LOG_MDC_ENABLED=true \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true \
    KC_LOG=console

WORKDIR /opt/keycloak
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.8.2

COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY --chown=keycloak:keycloak themes/ /opt/keycloak/themes/

# Secrets-Wrapper: liest /run/secrets/* in Env-Variablen, dann exec kc.sh.
# (Keycloak kennt kein natives *_FILE für DB-/Admin-Passwort; der File-Vault gilt
# nur für bestimmte Admin-Konsolen-Felder.) Build mit BuildKit (COPY --chmod).
COPY --chmod=0755 secrets-entrypoint.sh /opt/keycloak/bin/secrets-entrypoint.sh

# Zertifikate (u. a. DB-CA) werden read-only eingebunden — nicht ins Image.
VOLUME ["/opt/keycloak/data"]

ENTRYPOINT ["/opt/keycloak/bin/secrets-entrypoint.sh"]
CMD ["start", "--optimized"]
