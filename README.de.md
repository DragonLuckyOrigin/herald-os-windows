# Herald OS für Windows

Eine Windows-11-Portierung von [Herald OS](https://github.com/iamlukethedev/Herald-OS) von Luke The Dev (@iamlukethedev). Herald OS ist eine agentenorientierte Desktop-Oberfläche für [Hermes Agent](https://github.com/NousResearch/hermes-agent) von Nous Research.

- **Windows-Portierung und deutsche Übersetzung:** Dragon Lucky Eagle Origin
- **Originalprojekt und Design:** Herald OS von Luke The Dev
- **Lizenz:** MIT (siehe `LICENSE`; Drittanbieter-Hinweise in `THIRD_PARTY_NOTICES.md`)
- **Preis:** kostenlos

Dies ist eine unabhängige Community-Portierung und keine offizielle Version des Herald-OS-Projekts. Luke wurde angeboten, die Portierung künftig offiziell zu pflegen. Das hängt von seiner Zustimmung ab, die noch nicht vorliegt.

## Was die App unter Windows macht

- Startet Herald OS als native Windows-11-App (x64).
- Bietet die Oberfläche auf Deutsch oder Englisch, umschaltbar in den Einstellungen.
- Verbindet sich mit einem Hermes Agent, der auf demselben PC bereits läuft. Herald startet, installiert oder verändert Hermes nie.
- Unterstützt beide Hermes-Host-Modi unter Windows:
  - den Server-Host (`hermes-host-v1`)
  - den Desktop-Host (`hermes-desktop-host-v1`)

## Voraussetzungen

- Windows 11 (x64).
- Hermes Agent für Windows (Paket `NousResearch.HermesBundled` ab 2026.6864.2132.0), installiert und laufend für denselben Windows-Benutzer.
- Eine geschützte lokale Verbindungs-Policy unter `%USERPROFILE%\DRAGON_OS\connection-policy.json`. Der Ordnername ist Teil eines festen, gemeinsam genutzten Verbindungsvertrags. Beim normalen Start liest Herald die Datei nur. Anlegen kann sie nur der ausdrückliche Enrollment-Befehl, und der überschreibt nie eine vorhandene Policy.
  - Beim Server-Host legst du sie einmalig mit `"Herald OS.exe" --enroll-windows-v3` an.
  - Beim Desktop-Host nutzt Herald eine bereits vorhandene Desktop-Host-Policy. Selbst anlegen kann Herald sie noch nicht (siehe Bekannte Einschränkungen).

## Installation

1. Lade `HeraldOS-0.1.5-win-x64-Setup.exe` und `HeraldOS-0.1.5-win-x64-Setup.exe.sha256` aus dem Release herunter.
2. Prüfe die Prüfsumme in PowerShell:
   ```powershell
   (Get-FileHash .\HeraldOS-0.1.5-win-x64-Setup.exe -Algorithm SHA256).Hash
   ```
   Das Ergebnis muss `9DEC330B9E70A8C8B35731ADB0168C837DDFF4EF7DC203D0EFD7018DE20B4AB9` lauten.
3. Beende Herald OS, falls es läuft. Das Setup schließt die App nicht selbst, sondern bricht ab.
4. Starte das Setup. Es installiert pro Benutzer und braucht keine Administratorrechte.

Das Setup ist **nicht signiert**. SmartScreen oder Smart App Control können warnen oder den Start blockieren.

Update, Deinstallation und Rückweg beschreibt `docs/release/INSTALL_AND_ROLLBACK.md`.

## Bekannte Einschränkungen

- Das Setup ist nicht signiert.
- Ist Hermes nach dem Start von Herald länger als zwei Minuten offline, gibt Herald auf. Klicke auf **Erneut versuchen**, sobald Hermes wieder läuft.
- Eine Desktop-Host-Policy kann Herald noch nicht selbst anlegen. Das Enrollment schreibt nur Server-Host-Policies.
- Laufen Herald und ein weiterer Client desselben gemeinsamen Vertrags unter einem Windows-Benutzer, teilen sie sich `%LOCALAPPDATA%\Hermes-Stable\herald-os\notifications.json`.
- Getestet auf einem Windows-11-Rechner mit Hermes-Desktop-Host und vom Owner abgenommen. Weitere Rechner und zwei aufeinanderfolgende Updates sind noch nicht getestet.

## Credits

- **Herald OS:** Luke The Dev (@iamlukethedev), MIT.
- **Hermes Agent:** Nous Research, MIT.
- **Windows-Portierung und deutsche Übersetzung:** Dragon Lucky Eagle Origin.

## Hinweis zur App-ID
Diese Windows-Portierung nutzt die Upstream-App-ID `dev.iamluke.heraldos`. Ein offizieller Upstream-Windows-Build mit derselben App-ID würde diese Installation ersetzen (und umgekehrt). Die Abstimmung mit dem ursprünglichen Autor läuft.
