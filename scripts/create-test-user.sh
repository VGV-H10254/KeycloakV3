#!/usr/bin/env bash
# scripts/create-test-user.sh
#
# Legt einen Test-User in einem REALEN (prod-)Realm an — idempotent.
# Laeuft AUF DEM VPS ohne Node: nutzt kcadm IM Keycloak-Container.
#
# Warum nicht curl von aussen?
#   - Keycloak 8080 ist NICHT auf dem Host veroeffentlicht (nur internes Netz).
#   - Der Admin-Vhost (8444) hat ein selbstsigniertes Zertifikat.
#   - ./secrets/* ist 0400 und gehoert der gemappten Container-UID (rootless).
#
# Aufruf:
#   REALM=vw-baev ./scripts/create-test-user.sh
#
# Optional per Env:
#   REALM=vw-baev            (Default)
#   VERIMI_ID=<uuid>         (Default: generiert; wird der Login-Username)
#   SUB=<uuid>               (Default: generiert)
#   PASSWORD=<pw>            (optional: setzt ein Passwort; Realm-Policy:
#                             min. 12 Zeichen, nicht = Username. NUR Testphase!)
#   DELETE=1                 (loescht den User statt anzulegen/zu aktualisieren)
#   KC_CONTAINER=<name>      (Default: automatisch ermittelt)
#   KC_ADMIN_USER=kc-admin   (Default)
#   KC_ADMIN_PASS=<pw>       (Default: Secret aus dem Container)
#
# ACHTUNG: Nur fuer die Testphase. Vor Go-Live Script und Test-User entfernen.
set -euo pipefail
cd "$(dirname "$0")/.."

REALM="${REALM:-vw-baev}"
VERIMI_ID="${VERIMI_ID:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}"
SUB="${SUB:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}"
DELETE="${DELETE:-0}"
PASSWORD="${PASSWORD:-}"
KC_ADMIN_USER="${KC_ADMIN_USER:-kc-admin}"

# --- Container ermitteln ----------------------------------------------------
KC_CONTAINER="${KC_CONTAINER:-}"
if [[ -z "$KC_CONTAINER" ]]; then
  KC_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E 'keycloak.*keycloak-1' | head -1 || true)"
fi
if [[ -z "$KC_CONTAINER" ]]; then
  echo "Fehler: Kein Keycloak-Container gefunden. KC_CONTAINER setzen." >&2
  exit 1
fi

# Passwort: Env -> Secret IM Container (Host-Datei ist 0400, meist nicht lesbar)
if [[ -z "${KC_ADMIN_PASS:-}" ]]; then
  KC_ADMIN_PASS="$(docker exec -i "$KC_CONTAINER" cat /run/secrets/admin_password)"
fi

# --- Login + Create/Update in EINEM exec ------------------------------------
# Getrennte execs verlieren das kcadm-Token (Config-Datei) => HTTP 401.
# Attribute werden als explizites JSON gesendet; der Realm hat
# unmanagedAttributePolicy=ENABLED (realm-template.mjs), daher bleiben
# verifi_id/sub erhalten.
printf '%s\n' "$KC_ADMIN_PASS" | docker exec -i \
  -e REALM="$REALM" \
  -e VERIMI_ID="$VERIMI_ID" \
  -e SUB="$SUB" \
  -e DELETE="$DELETE" \
  -e PASSWORD="$PASSWORD" \
  -e KC_ADMIN_USER="$KC_ADMIN_USER" \
  "$KC_CONTAINER" bash -c '
    set -euo pipefail
    IFS= read -r KC_ADMIN_PASS
    KCADM=/opt/keycloak/bin/kcadm.sh
    CFG=/tmp/kcadm.config
    export HOME=/tmp

    "$KCADM" config credentials --config "$CFG" --server http://localhost:8080 \
      --realm master --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASS" >/dev/null

    USER_ID="$("$KCADM" get users -r "$REALM" -q "username=$VERIMI_ID" -q exact=true \
      --config "$CFG" --fields id --format csv --noquotes | head -1 | tr -d "\r")"

    if [ "$DELETE" = "1" ]; then
      if [ -z "$USER_ID" ]; then echo "Nicht gefunden - nichts zu tun."; exit 0; fi
      "$KCADM" delete "users/$USER_ID" -r "$REALM" --config "$CFG"
      echo "Geloescht: $REALM/$USER_ID"
      exit 0
    fi

    printf "{\"username\":\"%s\",\"enabled\":true,\"attributes\":{\"verifi_id\":[\"%s\"],\"sub\":[\"%s\"]}}" \
      "$VERIMI_ID" "$VERIMI_ID" "$SUB" > /tmp/test-user.json

    if [ -z "$USER_ID" ]; then
      "$KCADM" create users -r "$REALM" --config "$CFG" -f /tmp/test-user.json
      echo "Angelegt: $REALM username=$VERIMI_ID"
    else
      "$KCADM" update "users/$USER_ID" -r "$REALM" --config "$CFG" -f /tmp/test-user.json
      echo "Aktualisiert: $REALM/$USER_ID"
    fi

    echo "--- Verifikation ---"
    "$KCADM" get users -r "$REALM" -q "username=$VERIMI_ID" -q exact=true \
      --config "$CFG" --fields username,enabled,attributes

    if [ -n "${PASSWORD:-}" ]; then
      # Realm-Policy: length(12) and notUsername and passwordHistory(3)
      "$KCADM" set-password -r "$REALM" --username "$VERIMI_ID" \
        --new-password "$PASSWORD" --config "$CFG"
      echo "Passwort gesetzt (NUR Testphase!)"
    fi
  '

echo "verifi_id (= Login-Username) = $VERIMI_ID"
echo "sub = $SUB"
