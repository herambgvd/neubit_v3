<#
.SYNOPSIS
    Dump the appliance's databases to a file on Windows, before an upgrade.

.DESCRIPTION
    THE REASON THIS EXISTS: the appliance's unit of delivery is the WSL distro
    tarball, and its named volumes — including pgdata — live INSIDE that distro's
    virtual disk. Replacing the distro is how a new release arrives, and it takes
    the database with it. install-appliance.ps1 refuses to do that over a
    configured install for exactly this reason.

    So the upgrade is: run THIS, replace the distro, run restore-appliance-db.ps1.

    What is NOT in here, because it does not need to be: the bulk directory —
    recordings and the offline basemap. That is an ordinary Windows folder outside
    the distro and no part of an upgrade touches it.

    RUN AS THE ACCOUNT THAT INSTALLED THE APPLIANCE. WSL distros are registered per
    user; from another account the distro simply is not there.

    ALSO SAVED, and the upgrade is worthless without it: /opt/neubit/.env.

    The installer generates POSTGRES_PASSWORD, VE_JWT_SECRET and VE_SECRETS_KEY
    fresh on every FIRST install, and that .env lives inside the distro — so a
    distro replacement mints new ones. Two things then break, both silently:

      * the restored dump carries `ALTER ROLE neubit ... PASSWORD '<old hash>'`,
        which puts the database password back to the OLD one while the new .env
        holds the new one. Every service is then locked out of its own database.
        The installer's own comment says it: "changing it would lock the appliance
        out."
      * VE_SECRETS_KEY encrypts tenant secrets AT REST (core/app/core/secrets.py:
        "rotating that env var re-keys everything"). Restore old rows under a new
        key and the ciphertext in them is unreadable by anyone, permanently.

    So the .env is saved beside the dump and put back by restore-appliance-db.ps1.

.PARAMETER OutFile
    Where to write the dump. Defaults to
    %ProgramData%\Neubit\VMS\backup\neubit-db-<timestamp>.sql
    The environment file is written beside it with a .env extension.

.PARAMETER Distro
    The WSL distro name. Defaults to neubit-vms.
#>
[CmdletBinding()]
param(
    [string] $OutFile = '',
    [string] $Distro  = 'neubit-vms'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  + $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "  ! $m" -ForegroundColor Yellow }

if (-not $OutFile) {
    $dir = Join-Path $env:ProgramData 'Neubit\VMS\backup'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $OutFile = Join-Path $dir ("neubit-db-{0}.sql" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$outDir = Split-Path -Parent $OutFile
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# The dump is written from INSIDE the distro straight onto the Windows path, never
# piped back through PowerShell. `>` in PowerShell 5.1 writes UTF-8 WITH a BOM, and
# a BOM at the top of a .sql file makes psql choke on the first statement of the
# restore — at which point the operator has a backup that only fails when they need
# it. Redirecting inside bash writes the bytes pg_dumpall actually produced.
$outWsl = '/mnt/' + $OutFile.Substring(0,1).ToLower() + ($OutFile.Substring(2).Replace('\', '/'))
$EnvOut = [regex]::Replace($OutFile, '\.sql$', '') + '.env'
$envWsl = '/mnt/' + $EnvOut.Substring(0,1).ToLower() + ($EnvOut.Substring(2).Replace('\', '/'))

Write-Step "Dumping the appliance databases from $Distro"

# One script file rather than an inline command: this crosses PowerShell → wsl →
# bash, and each layer wants its own escaping for quotes, $ and (). Every attempt
# to pass this inline during the first install was mangled by one layer or another.
$sh = @"
set -euo pipefail
/opt/neubit/boot.sh engine >/dev/null 2>&1 || true

# The container is found by NAME rather than assumed: the compose project is the
# project directory (/opt/neubit -> "neubit"), but an operator who has renamed
# anything should get a clear error here rather than an empty dump.
cid=`$(docker ps --filter 'name=postgres' --format '{{.Names}}' | head -1)
if [ -z "`$cid" ]; then
  echo '!! no running postgres container. Start the stack first: /opt/neubit/boot.sh boot' >&2
  exit 1
fi
echo "postgres container: `$cid"

# pg_dumpall, not pg_dump: it carries the ROLES and every database in one file, so
# a restore does not depend on someone remembering the database list. The appliance
# has six-plus databases and that list grows with each service.
docker exec "`$cid" pg_dumpall -U neubit > '$outWsl'

# The per-install secrets. See the header: without these the dump restores into an
# appliance that cannot open its own database or read its own encrypted rows.
cp /opt/neubit/.env '$envWsl'
echo "saved /opt/neubit/.env"
"@

$shFile = Join-Path $env:TEMP 'neubit-backup-db.sh'
[IO.File]::WriteAllText($shFile, ($sh -replace "`r`n", "`n"))
$shWsl = '/mnt/' + $shFile.Substring(0,1).ToLower() + ($shFile.Substring(2).Replace('\', '/'))

$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & wsl.exe -d $Distro -u root -- bash $shWsl 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $code = $LASTEXITCODE
}
finally { $ErrorActionPreference = $prev }
Remove-Item -LiteralPath $shFile -Force -ErrorAction SilentlyContinue

if ($code -ne 0) { throw "pg_dumpall failed (exit $code). Nothing was written that you can trust." }
if (-not (Test-Path -LiteralPath $OutFile)) { throw "the dump file was not created at $OutFile" }

$size = (Get-Item -LiteralPath $OutFile).Length
Write-Ok ("{0}  ({1:N1} MB)" -f $OutFile, ($size / 1MB))

# A pg_dumpall that produced almost nothing is the failure mode worth catching HERE
# rather than during the restore, when the old distro is already gone.
if ($size -lt 20KB) {
    Write-Warn 'That is suspiciously small for a configured appliance. Open it and check'
    Write-Warn 'it contains your tenants/users before you replace the distro.'
}
Write-Host ''
if (-not (Test-Path -LiteralPath $EnvOut)) {
    throw ("the environment file was not saved to $EnvOut. Do NOT upgrade on this " +
           "backup: without it the restored database cannot be opened by the new install.")
}
Write-Ok "$EnvOut  (per-install secrets)"

Write-Host ''
Write-Host 'Keep BOTH files, together, OUTSIDE the distro directory. Restoring after' -ForegroundColor Yellow
Write-Host 'the new install: restore-appliance-db.ps1 -InFile "<the .sql>"' -ForegroundColor Yellow
Write-Host 'The .env beside it is picked up automatically.' -ForegroundColor Yellow
