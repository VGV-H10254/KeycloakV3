#!/usr/bin/env bash
# scripts/fix-master-frontend-url.sh
#
# Setzt (oder entfernt) das Realm-Attribut 'frontendUrl' am MASTER-Realm auf die
# Admin-URL. Damit baut die Admin-Login-Seite ihren 3p-Cookie-Check-iframe gegen
# den Admin-Host (Port 8444) statt gegen den öffentlichen Tenant-Host (8443).
#
# Hintergrund: KC_HOSTNAME_ADMIN wirkt nur für die Admin-Console/-REST, NICHT für
# den Master-Realm-Login. Der Login nutzt KC_HOSTNAME (öffentlich), dessen Pfad
# /realms/master von den Tenant-Vhosts absichtlich mit 404 blockiert wird
# ("Timeout when waiting for 3rd party check iframe message").
#
# Aufruf (auf dem VPS, im Projektverzeichnis):
#   ./scripts/fix-master-frontend-url.sh
#
#   # oder URL explizit:
#   KC_ADMIN_FRONTEND_URL=https://kc-admin.gateway-vw.de:8444 \
#     ./scripts/fix-master-frontend-url.sh
#
#   # entfernen (Rückfall auf KC_HOSTNAME):
#   ./scripts/fix-master-frontend-url.sh --unset
#
# Das Passwort wird in dieser Reihenfolge gesucht: KC_ADMIN_PASS → lesbare
# KC_ADMIN_PASS_FILE → /run/secrets/admin_password IM Container. Letzteres
# funktioniert ohne sudo, obwohl die Host-Datei 0400 (Container-UID) ist.
#
# Env:
#   KC_CONTAINER          Keycloak-Container (Default: automatisch ermittelt)
#   KC_INTERNAL_URL       interne Keycloak-Basis-URL (Default: http://localhost:8080 — HTTP!)
#   KC_ADMIN_USER         Admin-Benutzer (Default: kc-admin; sonst KC_ADMIN_USER aus .env.prod)
#   KC_ADMIN_PASS_FILE    Datei mit Admin-Passwort (Default: ./secrets/admin_password)
#   KC_ADMIN_PASS         Admin-Passwort direkt (Alternative zur Datei)
#   KC_ADMIN_HOSTNAME     Admin-Host (Default: aus .env.prod)
#   KC_ADMIN_PORT         Admin-Port (Default: aus .env.prod, sonst 8444)
#
# Idempotent: kann beliebig oft laufen.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

UNSET=0
[[ "${1:-}" == "--unset" ]] && UNSET=1

# --- .env.prod (nur lesend) -------------------------------------------------
ENV_FILE="${ENV_FILE:-.env.prod}"
env_get() { # env_get KEY -> Wert oder leer
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -1 | sed 's/[[:space:]]*$//'
}

KC_ADMIN_USER="${KC_ADMIN_USER:-$(env_get KC_ADMIN_USER)}"
KC_ADMIN_USER="${KC_ADMIN_USER:-kc-admin}"
KC_ADMIN_HOSTNAME="${KC_ADMIN_HOSTNAME:-$(env_get KC_ADMIN_HOSTNAME)}"
KC_ADMIN_PORT="${KC_ADMIN_PORT:-$(env_get KC_ADMIN_PORT)}"
KC_ADMIN_PORT="${KC_ADMIN_PORT:-8444}"
KC_INTERNAL_URL="${KC_INTERNAL_URL:-http://localhost:8080}"
KC_ADMIN_PASS_FILE="${KC_ADMIN_PASS_FILE:-./secrets/admin_password}"

# --- Container ermitteln ----------------------------------------------------
KC_CONTAINER="${KC_CONTAINER:-}"
if [[ -z "$KC_CONTAINER" ]]; then
  KC_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E 'keycloak.*keycloak-1' | head -1 || true)"
fi
if [[ -z "$KC_CONTAINER" ]]; then
  echo "Fehler: Kein Keycloak-Container gefunden. KC_CONTAINER setzen." >&2
  exit 1
fi

# Passwort-Auflösung: Env → Host-Datei → Secret IM Container.
# Die Host-Datei ist absichtlich 0400 und gehört der gemappten Container-UID
# (rootless Docker) — vps-prod darf sie daher meist NICHT lesen. Das Secret ist
# aber im Container als /run/secrets/admin_password gemountet und dort lesbar.
if [[ -z "${KC_ADMIN_PASS:-}" ]]; then
  if [[ -r "$KC_ADMIN_PASS_FILE" ]]; then
    KC_ADMIN_PASS="$(cat "$KC_ADMIN_PASS_FILE")"
  elif docker exec -i "$KC_CONTAINER" test -r /run/secrets/admin_password 2>/dev/null; then
    KC_ADMIN_PASS="$(docker exec -i "$KC_CONTAINER" cat /run/secrets/admin_password)"
    echo "[fix-master-frontend-url] Passwort aus Container-Secret /run/secrets/admin_password gelesen"
  else
    echo "Fehler: Passwort weder in KC_ADMIN_PASS noch lesbar in $KC_ADMIN_PASS_FILE noch als Container-Secret." >&2
    echo "Tipp: sudo verwenden oder KC_ADMIN_PASS_FILE auf eine lesbare Kopie setzen." >&2
    exit 1
  fi
fi

FRONTEND_URL="${KC_ADMIN_FRONTEND_URL:-}"
if [[ -z "$FRONTEND_URL" && $UNSET -eq 0 ]]; then
  if [[ -z "$KC_ADMIN_HOSTNAME" ]]; then
    echo "Fehler: KC_ADMIN_HOSTNAME fehlt (weder Env noch .env.prod)." >&2
    exit 1
  fi
  FRONTEND_URL="https://${KC_ADMIN_HOSTNAME}:${KC_ADMIN_PORT}"
fi

echo "[fix-master-frontend-url] Container: $KC_CONTAINER, Server: $KC_INTERNAL_URL"

# --- Admin-Login + Realm-Attribut (EIN docker exec!) ------------------------
# Wichtig: 'kcadm config credentials' legt das Token in einer Config-Datei ab.
# Bei GETRENNTEN 'docker exec'-Aufrufen ist diese Datei im Container nicht
# zuverlässig vorhanden/lesbar -> der Folgeaufruf läuft ohne Token und
# antwortet mit "HTTP 401 Unauthorized". Darum Login + Update + Verify in EINEM
# exec, mit explizitem, garantiert beschreibbarem --config-Pfad.
#
# Das Passwort wird über stdin übergeben (nicht als Argument) und erscheint
# damit nicht in der Host-Prozessliste.
printf '%s\n' "$KC_ADMIN_PASS" | docker exec -i \
  -e KC_ADMIN_USER="$KC_ADMIN_USER" \
  -e KC_INTERNAL_URL="$KC_INTERNAL_URL" \
  -e FRONTEND_URL="$FRONTEND_URL" \
  -e UNSET="$UNSET" \
  "$KC_CONTAINER" bash -c '
    set -euo pipefail
    IFS= read -r KC_ADMIN_PASS
    KCADM=/opt/keycloak/bin/kcadm.sh
    CFG=/tmp/kcadm.config
    export HOME=/tmp

    "$KCADM" config credentials --config "$CFG" \
      --server "$KC_INTERNAL_URL" --realm master \
      --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASS"

    if [ "$UNSET" = "1" ]; then
      TARGET=""
    else
      TARGET="$FRONTEND_URL"
    fi

    # Patch als explizites JSON. WICHTIG: "-s attributes.frontendUrl=..." kann
    # je nach kcadm-Variante als FLACHER Key "attributes.frontendUrl" landen;
    # Keycloak ignoriert unbekannte Felder still (HTTP 2xx, nichts gespeichert).
    # Deshalb eine echte, verschachtelte attributes-Map senden.
    printf "{\"attributes\":{\"frontendUrl\":\"%s\"}}" "$TARGET" > /tmp/realm-patch.json

    # 1) Merge-Update (kcadm-Default: GET + Merge + PUT)
    "$KCADM" update realms/master --config "$CFG" -f /tmp/realm-patch.json || true

    # 2) Falls ohne Wirkung: No-Merge-PUT (kein vorheriges GET)
    if ! "$KCADM" get realms/master --config "$CFG" | grep -q "\"frontendUrl\""; then
      echo "[fix-master-frontend-url] Merge ohne Wirkung -> No-Merge-PUT (-n)"
      "$KCADM" update realms/master --config "$CFG" -n -f /tmp/realm-patch.json || true
    fi

    # 3) Verifikation am VOLLEN Realm-Objekt (nicht nur --fields attributes)
    REALM_JSON="$("$KCADM" get realms/master --config "$CFG")"
    if ! printf "%s" "$REALM_JSON" | grep -q "\"frontendUrl\""; then
      echo "FEHLER: frontendUrl wurde NICHT persistiert (weder Merge- noch -n-PUT)." >&2
      echo "Naechster Schritt: DB-Fallback (realm_attribute) + Keycloak-Restart." >&2
      exit 1
    fi

    if [ "$UNSET" = "1" ]; then
      echo "[fix-master-frontend-url] frontendUrl geleert (Rueckfall auf KC_HOSTNAME)."
    else
      echo "[fix-master-frontend-url] frontendUrl gesetzt: $TARGET"
    fi

    printf "%s\n" "$REALM_JSON" | grep -o "\"frontendUrl\"[^,}]*"
  '

echo "[fix-master-frontend-url] fertig. Browser im Inkognito-Fenster neu laden."
