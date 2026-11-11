#!/usr/bin/env bash
# Entfernt den Bootstrap-Admin (KC_ADMIN_USER aus .env.prod) aus dem master-Realm —
# aber NUR, wenn ein neuer Admin nachweislich funktioniert:
#   - Login mit Passwort (+ OTP, falls nötig)
#   - Rolle 'admin' im master-Realm direkt zugewiesen
#   - MFA (OTP oder WebAuthn) hinterlegt
#   - Setup-Client liefert vor und nach dem Löschen ein Token
#
# Nutzung (auf dem VPS, im Projektverzeichnis):
#   ./scripts/retire-bootstrap-admin.sh --dry-run   # nur prüfen, nichts löschen
#   ./scripts/retire-bootstrap-admin.sh             # prüfen und löschen
#
# Passwörter werden nur abgefragt, nie als Argument übergeben und nicht geloggt.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.prod"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

die() { echo "FEHLER: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE nicht gefunden (im Projektverzeichnis ausführen)."
[[ -f "./secrets/setup_client_secret" ]] || die "./secrets/setup_client_secret fehlt. Erst scripts/create-secrets.sh ausführen."

BOOT_USER=$(grep -E '^KC_ADMIN_USER=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r')
[[ -n "$BOOT_USER" ]] || die "KC_ADMIN_USER in $ENV_FILE ist leer."

read -r -p "Name des NEUEN Admins (Named Admin): " NAMED_USER
[[ -n "$NAMED_USER" ]] || die "Kein Name angegeben."
[[ "$NAMED_USER" != "$BOOT_USER" ]] || die "Der neue Admin darf nicht '$BOOT_USER' heißen."

if [[ $DRY_RUN -eq 0 ]]; then
  echo
  echo "Ziel: Benutzer '$BOOT_USER' im master-Realm wird GELÖSCHT, sobald alle Prüfungen bestehen."
  read -r -p "Zum Bestätigen exakt eingeben: DELETE $BOOT_USER  > " CONFIRM
  [[ "$CONFIRM" == "DELETE $BOOT_USER" ]] || die "Bestätigung falsch. Nichts verändert."
fi

read -r -s -p "Passwort von '$NAMED_USER': " NAMED_PASS; echo
read -r -p "OTP-Code (leer lassen, wenn der Login keinen Code verlangt): " TOTP

# Werte per stdin an den Container übergeben (nicht als Argument, nicht im Log).
# -i: stdin anhängen. -T: kein TTY (sonst Zeilenenden verfälscht). --profile setup: keycloak-setup ist im Profil.
printf '%s\n%s\n%s\n%s\n' "$NAMED_USER" "$NAMED_PASS" "$TOTP" "$BOOT_USER" | \
  docker compose --env-file "$ENV_FILE" --profile setup run --rm -i -T \
    -e DRY_RUN="$DRY_RUN" \
    -v "$PWD/scripts:/work:ro" \
    keycloak-setup node /work/retire-bootstrap-admin.mjs

# Passwort aus dem Shell-Speicher entfernen.
unset NAMED_PASS TOTP

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry-Run beendet. Zum echten Löschen ohne --dry-run erneut starten."
  exit 0
fi

cat <<EOF

Bootstrap-Admin '$BOOT_USER' ist entfernt. Die folgenden Schritte sind bewusst
MANUELL, damit nichts ohne Prüfung kaputtgeht (Reihenfolge einhalten):

  1. docker-compose.yml: 'admin_password' aus den Secret-Listen von
     keycloak-base und keycloak-bootstrap entfernen, und KC_BOOTSTRAP_ADMIN_USERNAME
     aus x-keycloak-env streichen.
  2. Erst danach die Datei löschen:  shred -u ./secrets/admin_password
  3. Keycloak-Knoten neu starten:
       docker compose --env-file .env.prod up -d keycloak-1 keycloak-2
  4. Zugang testen: neuer Admin meldet sich im Browser an.

Hinweis: Ein neuer Mandant mit portalImpersonation braucht später wieder einen
Admin-Token im 'keycloak-bootstrap'-Lauf. Dafür den neuen Admin in .env.prod
(KC_ADMIN_USER) eintragen und ein temporäres admin_password-Secret anlegen.
EOF
