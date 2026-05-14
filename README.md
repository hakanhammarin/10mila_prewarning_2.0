# Prewarning

Storbildsdisplay för förvarning till växel. Pollar OLA-databasen,
trycker diff-events ut till F11-skärmar via Server-Sent Events.

- **Stack:** Node.js 20+ · Express · `mysql2/promise` · vanilla-JS frontend
- **OS:** Linux (systemd, testat på Ubuntu 24.04 LTS) och Windows (NSSM)
- **Datakälla:** MySQL — primär + sekundär med automatisk failover
- **Frontend:** öppna `http://server:8080/?class=Herrkavlen` i F11

## Krav

- Node.js >= 20
- Nätåtkomst till tävlingens MySQL-databas (port 3306)
- En användare med läsrättigheter på databasen (defaulten är RO-kontot
  `samuel` i den angivna konfigurationen)

## Snabbstart (utveckling, macOS/Linux)

```bash
cp config.example.yml config.yml
# fyll i mysql.primary om den skiljer sig från defaultvärdena
npm install
npm start
# öppna http://localhost:8080/
```

## Installation — Ubuntu 24.04 LTS (systemd)

```bash
# 1. Installera Node.js 20 om det inte redan finns
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs rsync

# 2. Hämta repot till t.ex. /home/operator/prewarning
git clone <repo-url> prewarning
cd prewarning

# 3. Installera tjänsten
sudo ./install.sh
```

`install.sh` är idempotent och utför:

- skapar systemanvändaren `prewarning`
- kopierar koden till `/opt/prewarning` med `rsync`
- `npm ci --omit=dev` i appens katalog
- lägger en default-konfig i `/etc/prewarning/config.yml`
  (befintlig konfig rörs inte)
- registrerar och startar `prewarning.service`

Verifiering:

```bash
sudo systemctl status prewarning
sudo journalctl -u prewarning -f
curl -s http://localhost:8080/healthz | jq .
```

### Fyll i sekundär MySQL natten innan loppet

Editera `/etc/prewarning/config.yml`:

```yaml
mysql:
  secondary:
    host: 192.168.1.nn       # IP/hostnamn till backup-servern
    port: 3306
    user: *****
    password: *********
    database: tiomila2026
```

Restart krävs för att den ska plockas upp:

```bash
sudo systemctl restart prewarning
```

Failover-banner (`📡 sekundär databas`) dyker upp automatiskt högst upp i
UI:t när primär är onåbar.

## Installation — Windows (NSSM)

```powershell
# 1. Installera Node.js 20 från https://nodejs.org
# 2. Installera NSSM från https://nssm.cc/download och lägg den i PATH
# 3. Starta en elevated PowerShell i repots rot
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install-nssm.ps1
```

Standardplaceringar:

- App: `C:\Prewarning\`
- Konfig: `C:\Prewarning\config\config.yml`
- Loggar: `C:\Prewarning\logs\stdout.log` (och `stderr.log`)

Verifiering:

```powershell
nssm status Prewarning
Get-Content -Wait C:\Prewarning\logs\stdout.log
Invoke-WebRequest http://localhost:8080/healthz
```

## URL-mall för F11-skärmarna

```
http://<server>:8080/?class=Herrkavlen
http://<server>:8080/?class=Damkavlen
http://<server>:8080/?class=Ungdomskavlen
```

- `?class` accepterar antingen klassnamn (`Herrkavlen`) eller numerisk
  klass-id från databasen.
- Vald klass sparas i `localStorage` så F11-skärmen minns sitt val efter
  omstart även om URL:en saknar `?class`.
- Ingen `?class` → klockan visas centrerat och dropdownen för klassval
  öppnas automatiskt.

Skapa bokmärken eller en `.bat`/`.sh` som kör en kiosk-Chrome i F11
direkt mot rätt URL.

## Konfig

Se `config.example.yml`. Hela konfigen kan också sättas via miljövariabler
om man föredrar det:

| miljövariabel                              | default        |
| ------------------------------------------ | -------------- |
| `PREWARNING_CONFIG`                        | filsökväg      |
| `PREWARNING_MYSQL_PRIMARY_HOST`            | —              |
| `PREWARNING_MYSQL_PRIMARY_PORT`            | 3306           |
| `PREWARNING_MYSQL_PRIMARY_USER`            | —              |
| `PREWARNING_MYSQL_PRIMARY_PASSWORD`        | —              |
| `PREWARNING_MYSQL_PRIMARY_DATABASE`        | —              |
| `PREWARNING_MYSQL_SECONDARY_*`             | (ej satta)     |
| `PREWARNING_POLL_INTERVAL_MS`              | 1000           |
| `PREWARNING_HTTP_PORT`                     | 8080           |
| `PREWARNING_FAILOVER_FAILURES`             | 3              |
| `PREWARNING_QUERY_TIMEOUT_MS`              | 3000           |
| `PREWARNING_PRIMARY_RECHECK_MS`            | 30000          |
| `PREWARNING_DEBUG=1`                       | extra loggning |

Lösenord ska aldrig hårdkodas i koden — bara via konfig.

## Endpoints

- `GET /` — frontend
- `GET /events?class=<id-eller-namn>` — SSE-stream (snapshot + diff)
- `GET /classes` — JSON-lista över tävlingens klasser
- `GET /healthz` — JSON: aktiv DB-pool, antal SSE-klienter, antal klasser

## State-maskin per löpare

```
[osynlig] ─Prewarning─▶ [GRÖN 60s] ─▶ [GUL] ─finishTime─▶ [RÖD] ─readInTime─▶ [borta]
                                                           │
                                                  fallback finishTime + 2 min
```

ETA-countdown på varje rad är rolling median av `prewarning → finishTime`
för de **första 10 färdiga löparna per (klass, sträcka)** den här
tävlingen. Default 180 s tills 10 prov finns. Fryser på `0:00` om
finishTime inte kommit (visar inte negativa siffror).

## Schema-antaganden

Alla SQL-queries lever i [`src/queries.js`](src/queries.js). Om kolumn-
namnen i `tiomila2026` skiljer sig från standard-OLA/MeOS-namnen är det
den enda fil du behöver röra:

- `splittimes` JOIN `raceclasssplittimecontrols` WHERE `name = 'Prewarning'`
- `results.finishTime` för målgång
- `rawdatafromelectronicpunchingcards.readInTime` för avläsning
  (via `results.rawDataFromElectronicPunchingCardsId`)
- `entries.teamName` för lagnamn
- `raceclasses` för klasslistan
- `runnerStatus` används inte i v1 (NOK-spåret är skrotat)

Polling-querien filtrerar på `modifyDate > :lastPoll` så bara nyändrade
rader hämtas en gång per sekund.

## v2 — explicit utanför scope

  - positions-/placerings-kolumn
- Docker-image
