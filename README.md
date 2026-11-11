# KeycloakV2 — Keycloak + Postgres + nginx (Keycloak-Only)

Dieser Stack stellt nur Keycloak, Postgres und nginx bereit. Portal und
Identitätsnachweis-Anbieter (IDV) werden extern betrieben.

## Start

```bash
# tenants.conf ohne Portal-Upstreams erzeugen
node infra/nginx/generate-nginx.mjs --keycloak-only

# Starten
docker compose --env-file .env.prod up -d
```

Öffentlicher Zugang: ausschließlich HTTPS auf **Port 8443** (`KC_PUBLIC_PORT`, Standard 8443;
rootless Docker kann keine Ports unter 1024 veröffentlichen). Keycloak, PostgreSQL und das
Management-Interface sind nicht öffentlich erreichbar. Die Admin-Oberfläche ist nur für
`MGMT_CIDR` (z. B. `87.128.200.94/32`) erreichbar. Details: `anweisung_nginx_hardening_10-27-2026.md`.

## Voraussetzungen
- `.env.prod` ausgefüllt (siehe `.env.prod.example`)
- Zertifikate unter `infra/nginx/certs/<host>/`
- DB-Zertifikat unter `infra/pg/certs/`
- CA unter `keycloak/certs/pg-ca.crt`

## Kontext
- Im internen Netzwerk der Firma ist der ausgehende Port 8443 blockiert. Wenn ich also `https://kc.gateway-vw.de:8443/...` oder `https://kc-admin.gateway-vw.de:8443/...` teste, dann teste ich es auf einen smartphone bzw. einen externen Netzwerk mit der IP `80.153.9.1`.
- Eine Kopie sollte auf IONOS VPS sein (falls irgendwas nicht stimmt, dann vorher verifizieren, um keine falschen Annahmen zu treffen)
- Dieses Projekt soll auch auf (rootless) Docker auf IONOS VPS laufen.
- Da dies ein Rootless docker ist funktionieren nur Ports ab 1024 in der Compose Datei o.Ä.
- Nur nginx sollte nach außen sichtbar sein alle anderen Services (Keycloak und Postgres) sollten von außen nicht ansprechbar sein
- Es soll nur von bestimmten Webseiten (Portalen der Versorgungswerke) angesprochen werden:
    - vw-baev.de, 
    - apvn.de,
    - apothekerversorgung-berlin.de, 
    - vw-ltkmv.de, 
    - vw-ltkt.de, 
    - architektenversorgung-berlin.de, 
    - vwaek.hamburg, 
    - ingenieurversorgung-niedersachsen.de, 
    - vw-aknrw.de

- Wobei folgende Domains uns gehören:
    - vw-baev.de, 
    - apvn.de, 
    - apothekerversorgung-berlin.de, 
    - vw-ltkmv.de, 
    - vw-ltkt.de, 
    - architektenversorgung-berlin.de, 
- Und diese Domains werden von anderen Dienstleistern verwaltet (aber man könnte anfragen, ansonsten sollten auch redirects gehen wie z.B sso):
    - vwaek.hamburg
    - ingenieurversorgung-niedersachsen.de
    - vw-aknrw.de

- Die Mitglieder im oben genannten Portalen sollen - nachdem sie sich in diesen Portalen registriert und angemeldet haben - sich mit Keycloak authentifizieren können und sie sollen sich auch mit Passkey einloggen können

- Die Portale sind auf AWS gehostet und greifen auf den IONOS VPS über AWS Lambda zu (d.h. unter anderem, dass die IP von den Clients keine feste IP Adressen haben)

- on the nginx layer MGMT_CIDR is not needed. The real enforcement of who can access the admin page is the firewall

## (idealer) Ablauf

1. User meldet sich im Portal über Verimi an. 
2. Er bekommt einen Button angezeigt, ob er sich ein Passkey erstellen will
3. User drückt auf den Button
4. Im Backend wird eine Lambda Funktion getriggert, die den Passkey Erstellungsprozess anstößt
5. Im Keycloak wird ein Nutzer erstellt mit SubId und der VerimitId
6. Passkey wird für diesen User erstellt
7. Passkey wird an den User zurückgegeben
8. Prozess Ende

## Ziel
Ziel soll es sein dieses Projekt auf IONOS VPS zum laufen zu bringen und zwar so, dass es sicher ist und nicht gehackt werden kann. Vorher muss getestet werden, ob alles funktioniert. Ein erster technischer Durchstich muss noch gemacht werden. Ich habe auf der lokalen Maschine keine Root oder Admin Rechte. D.h. jeder technischer Durchstick sollte möglichst ohne Root Rechte oder ohne Hilfe von Administratoren geschehen.

