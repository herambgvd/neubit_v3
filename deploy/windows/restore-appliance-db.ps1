<#
.SYNOPSIS
    Restore a dump taken by backup-appliance-db.ps1 into a freshly installed appliance.

.DESCRIPTION
    Run this AFTER install-appliance.ps1 has finished and the new stack has come up
    once. That order is deliberate, not incidental:

      * the new install boots, runs its migrations and creates a fresh database with
        a bootstrap admin. That fresh state is what we are about to replace.
      * restoring ON TOP of it is not safe — pg_dumpall's CREATE DATABASE statements
        fail on databases that already exist, and the restore then pours old rows
        into a new schema, leaving a database that is neither. So this DROPS the
        appliance databases first and restores into an empty cluster.
      * then the stack is started again, and each service's migrations run against
        the restored data — applying whatever deltas the new release added.

    Everything is done with the stack DOWN except postgres, so no service is reading
    or writing while its database is dropped underneath it.

.PARAMETER InFile
    The .sql produced by backup-appliance-db.ps1.

.PARAMETER Distro
    The WSL distro name. Defaults to neubit-vms.

.PARAMETER Yes
    Do not prompt before dropping the freshly created databases.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $InFile,
    [string] $Distro = 'neubit-vms',
    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  + $m" -ForegroundColor Green }

if (-not (Test-Path -LiteralPath $InFile)) { throw "no such dump: $InFile" }
$InFile = (Resolve-Path -LiteralPath $InFile).Path
$size = (Get-Item -LiteralPath $InFile).Length
Write-Host ("Dump: {0}  ({1:N1} MB)" -f $InFile, ($size / 1MB))

if (-not $Yes) {
    Write-Host ''
    Write-Host 'This DROPS the databases the new install just created and replaces them' -ForegroundColor Yellow
    Write-Host 'with the contents of that file. The bootstrap admin created by this' -ForegroundColor Yellow
    Write-Host 'install will be replaced by the accounts from the dump.' -ForegroundColor Yellow
    $a = Read-Host 'Type RESTORE to continue'
    if ($a -ne 'RESTORE') { Write-Host 'Aborted.'; exit 1 }
}

$inWsl = '/mnt/' + $InFile.Substring(0,1).ToLower() + ($InFile.Substring(2).Replace('\', '/'))

$sh = @"
set -uo pipefail
cd /opt/neubit
COMPOSE="docker compose -f /opt/neubit/docker-compose.yml -f /opt/neubit/docker-compose.appliance.yml --project-directory /opt/neubit"

/opt/neubit/boot.sh engine >/dev/null 2>&1 || true

echo '--- stopping the stack (postgres stays) ---'
`$COMPOSE down

echo '--- postgres only ---'
`$COMPOSE up -d --no-build postgres
for i in `$(seq 1 60); do
  cid=`$(docker ps --filter 'name=postgres' --format '{{.Names}}' | head -1)
  if [ -n "`$cid" ] && docker exec "`$cid" pg_isready -U neubit >/dev/null 2>&1; then break; fi
  sleep 1
done
cid=`$(docker ps --filter 'name=postgres' --format '{{.Names}}' | head -1)
if [ -z "`$cid" ]; then echo '!! postgres did not start' >&2; exit 1; fi
echo "postgres container: `$cid"

echo '--- dropping the databases this install created ---'
# Only the appliance's own databases. template0/template1/postgres are the cluster's
# and dropping them would leave nothing to restore INTO.
for db in `$(docker exec "`$cid" psql -U neubit -d postgres -At -c "select datname from pg_database where datistemplate = false and datname <> 'postgres'"); do
  echo "  drop `$db"
  docker exec "`$cid" psql -U neubit -d postgres -c "drop database if exists \"`$db\" with (force)" >/dev/null
done

echo '--- restoring ---'
# ON_ERROR_STOP so a broken dump fails HERE, loudly, instead of half-restoring and
# leaving a database that looks populated and is not.
docker exec -i "`$cid" psql -U neubit -d postgres -v ON_ERROR_STOP=1 < '$inWsl'
rc=`$?
if [ `$rc -ne 0 ]; then echo "!! restore failed (psql exit `$rc)" >&2; exit `$rc; fi

echo '--- bringing the whole stack up (migrations run now) ---'
`$COMPOSE up -d --no-build
echo 'restore complete'
"@

$shFile = Join-Path $env:TEMP 'neubit-restore-db.sh'
[IO.File]::WriteAllText($shFile, ($sh -replace "`r`n", "`n"))
$shWsl = '/mnt/' + $shFile.Substring(0,1).ToLower() + ($shFile.Substring(2).Replace('\', '/'))

Write-Step "Restoring into $Distro"
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & wsl.exe -d $Distro -u root -- bash $shWsl 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $code = $LASTEXITCODE
}
finally { $ErrorActionPreference = $prev }
Remove-Item -LiteralPath $shFile -Force -ErrorAction SilentlyContinue

if ($code -ne 0) { throw "restore failed (exit $code). The stack may be partly up — check with boot.sh status." }
Write-Ok 'databases restored and the stack is starting'
Write-Host ''
Write-Host 'Give it a couple of minutes, then check the console and that your' -ForegroundColor Cyan
Write-Host 'recorders/users are the ones you had before.' -ForegroundColor Cyan
