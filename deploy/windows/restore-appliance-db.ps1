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
    The .sql produced by backup-appliance-db.ps1. The .env saved beside it is used
    automatically unless -EnvFile says otherwise.

.PARAMETER EnvFile
    The /opt/neubit/.env saved with the dump. Its POSTGRES_PASSWORD,
    VE_DATABASE_URL, VE_JWT_SECRET and VE_SECRETS_KEY are put back into the new
    install's .env before the stack comes up — see backup-appliance-db.ps1 for why
    the restore is worthless without them. Pass -NoEnv to skip deliberately.

.PARAMETER NoEnv
    Restore the databases without carrying the old secrets over. Only correct when
    the .env was never replaced (the distro was not re-imported).

.PARAMETER Distro
    The WSL distro name. Defaults to neubit-vms.

.PARAMETER Yes
    Do not prompt before dropping the freshly created databases.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $InFile,
    [string] $EnvFile = '',
    [switch] $NoEnv,
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

# The secrets saved with the dump, defaulting to the sibling this backup writes.
if (-not $NoEnv) {
    if (-not $EnvFile) { $EnvFile = [regex]::Replace($InFile, '\.sql$', '') + '.env' }
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw ("no environment file at $EnvFile. The dump alone restores a database " +
               "the new install cannot open — its POSTGRES_PASSWORD, VE_JWT_SECRET and " +
               "VE_SECRETS_KEY were regenerated when the distro was replaced. Find the " +
               ".env saved with this dump, pass -EnvFile, or pass -NoEnv if you are sure " +
               "the .env was never replaced.")
    }
    $EnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
    Write-Host "Secrets: $EnvFile"
}
$envWsl = if ($NoEnv) { '' } else {
    '/mnt/' + $EnvFile.Substring(0,1).ToLower() + ($EnvFile.Substring(2).Replace('\', '/'))
}

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
# `CREATE ROLE neubit;` is the first statement pg_dumpall writes, and the role
# ALWAYS exists already — the new install's postgres created it from POSTGRES_USER
# on first boot. Under ON_ERROR_STOP that single line aborted the entire restore
# before one table was created; measured on a scratch cluster of the same image,
# psql exit 3, nothing restored. Dropping the line is lossless: the `ALTER ROLE`
# immediately after it sets every attribute and the password anyway.
#
# ON_ERROR_STOP stays on for everything else. The point is to fail loudly on a
# genuinely broken dump, not to wave through the one error we have proven benign.
grep -v '^CREATE ROLE neubit;`$' '$inWsl' | docker exec -i "`$cid" psql -U neubit -d postgres -v ON_ERROR_STOP=1
rc=`$?
if [ `$rc -ne 0 ]; then echo "!! restore failed (psql exit `$rc)" >&2; exit `$rc; fi

# The restore has just put the OLD database password back (the dump's ALTER ROLE),
# so the new install's freshly generated .env no longer opens its own database.
# Carry the old secrets across before anything tries to connect. Only these four:
# everything else in .env belongs to the NEW install (NEUBIT_VERSION, paths, the
# ops-agent token) and must not be dragged backwards.
if [ -n '$envWsl' ] && [ -f '$envWsl' ]; then
  echo '--- carrying the per-install secrets across ---'
  for k in POSTGRES_PASSWORD VE_DATABASE_URL VE_JWT_SECRET VE_SECRETS_KEY; do
    v=`$(grep -E "^`${k}=" '$envWsl' | head -1 | cut -d= -f2-)
    if [ -z "`$v" ]; then echo "  !! `$k missing from the saved .env" >&2; continue; fi
    if grep -qE "^`${k}=" /opt/neubit/.env; then
      # `|` as the delimiter: VE_DATABASE_URL contains slashes.
      sed -i "s|^`${k}=.*|`${k}=`${v}|" /opt/neubit/.env
    else
      printf '%s=%s\n' "`$k" "`$v" >> /opt/neubit/.env
    fi
    echo "  restored `$k"
  done
fi

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
