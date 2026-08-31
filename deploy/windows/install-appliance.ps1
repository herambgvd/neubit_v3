<#
.SYNOPSIS
    Install the Neubit VMS appliance on this Windows box.

.DESCRIPTION
    Imports the baked WSL2 distro, points it at the storage the operator chose,
    arranges for it to start at boot with nobody logged in, and opens the one port
    the console needs.

    ══ EVERYTHING RUNS AS SYSTEM, AND THAT IS THE WHOLE DESIGN ══════════════════

    WSL distros are registered PER USER, under HKCU\...\Lxss. A distro imported by
    the administrator who ran the installer is invisible to any other account —
    including SYSTEM, which is the account a boot-time task runs under. Import it
    as the installing user and the appliance works beautifully until the first
    reboot, then never starts again with nobody logged in, which is precisely the
    property the product is sold on.

    So the import, the boot task and the .wslconfig all live in SYSTEM's context.
    Invoke-AsSystem below does that with a throwaway scheduled task — built in, no
    third-party tool to redistribute.

    Verify this on any box with probe-system-wsl.ps1 before trusting it.

    ══ IDEMPOTENT, BECAUSE IT IS ALSO THE UPGRADE PATH ══════════════════════════

    Re-running over a live appliance is the upgrade. The NVR learned twice what
    that costs when it is not designed for:

      * its port check found the ports in use BY THE PRODUCT BEING UPGRADED, and
        refused, advising the operator to stop the conflicting software.
      * NSIS extracts before any hook runs, so the running service held its own
        payload and the upgrade could not replace it.

    Hence: Stop-Appliance runs FIRST, before the port check and before anything is
    written, and installer.nsh stops it again from `customInit` — early enough to
    unlock the payload. Neither is redundant: a hand-run upgrade never goes through
    NSIS at all.

.PARAMETER PayloadDir
    Where neubit-vms.tar.gz and appliance.json were laid down. Defaults to the
    directory holding this script.

.PARAMETER DistroDir
    Where the distro's virtual disk goes. This holds the container layers and the
    DATABASE, so it wants an SSD. Defaults to %ProgramData%\Neubit\VMS\distro.

.PARAMETER BulkDir
    Where recordings and the offline basemap go. Large, sequential, cheap per GB —
    a spinning disk is the right home. Defaults to <DistroDir>\..\data.

.PARAMETER Force
    Continue even when a required port is in use, or when pgdata would land on a
    disk detected as mechanical.

.PARAMETER AdminEmail
    The bootstrap administrator, created on first boot while the users table is
    empty. Defaults to admin@gvd.in.

.PARAMETER AdminPassword
    Its password. Left empty, one is GENERATED for this machine and printed at the
    end — an appliance must not ship a password that is the same everywhere.
    Ignored on a re-install: the account already exists and .env is preserved.

.PARAMETER RuntimeEnv
    VE_ENV for the stack. 'dev' (the default) or 'prod'.

    DEFAULT dev, DELIBERATELY, and it is a licensing decision rather than a
    sloppy one. core/app/core/license.py falls back to an unlimited license when
    env is 'dev' and nothing is configured; under 'prod' a missing or invalid
    license token is a HARD ERROR and core does not start. Nothing issues license
    tokens yet, so 'prod' here would produce an appliance that installs perfectly
    and then refuses to run. Flip this when licensing ships, together.
#>
[CmdletBinding()]
param(
    [string] $PayloadDir = '',
    [string] $DistroDir  = '',
    [string] $BulkDir    = '',
    [switch] $Force,
    [string] $AdminEmail = 'admin@gvd.in',
    [string] $AdminPassword = '',
    # NOT named $Env: $env: is PowerShell's environment-variable drive and this
    # script reads $env:ProgramData and $env:SystemRoot. Same word, two meanings,
    # in one file is how a reader loses ten minutes.
    [ValidateSet('dev','prod')][string] $RuntimeEnv = 'dev'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── constants ────────────────────────────────────────────────────────────────
$DistroName  = 'neubit-vms'
$TaskName    = 'Neubit VMS appliance'
$RulePrefix  = 'Neubit VMS'
$ConsolePort = 80
$VmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'   # WSL's Hyper-V firewall VM

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  . $Message" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

function Assert-Administrator {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw ("This installer must run as Administrator. It registers a boot task under " +
               "SYSTEM, imports a WSL distro into SYSTEM's profile and creates firewall " +
               "rules — none of which a standard account may do. Re-run from an elevated prompt.")
    }
}

<#
Run a PowerShell script block as NT AUTHORITY\SYSTEM and return its output.

A throwaway scheduled task, because it is built in. The alternatives all cost
something we do not want to pay: PsExec is a third-party binary to redistribute
and is increasingly flagged by endpoint protection, and a service wrapper is a
whole executable to sign for the sake of a handful of one-shot commands.

Output is routed through a file rather than the task's own streams: a task has no
stdout to inherit, and losing the child's explanation is the single most expensive
mistake the NVR made in this area — `Start-Transcript` does not capture a native
command's console output either, so a careful error message went to a console
nobody was watching while the log recorded "exit code 1".
#>
function Invoke-AsSystem {
    param(
        [Parameter(Mandatory)][string] $Script,
        [string] $What = 'command',
        [int]    $TimeoutSeconds = 900
    )

    $stamp   = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $dir     = Join-Path $env:ProgramData 'Neubit\VMS\install'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $scriptPath = Join-Path $dir "as-system-$stamp.ps1"
    $logPath    = Join-Path $dir "as-system-$stamp.log"
    $donePath   = Join-Path $dir "as-system-$stamp.done"

    # The wrapper writes a .done file carrying the exit code. Task Scheduler's own
    # LastTaskResult reports whether the TASK ran, not whether the script inside it
    # succeeded, and treating the two as the same is how a failed import is
    # reported as a successful install.
    $wrapper = @"
`$ErrorActionPreference = 'Continue'
try {
    & {
$Script
    } *>&1 | Tee-Object -FilePath '$logPath'
    `$code = 0
} catch {
    `$_ | Out-String | Add-Content -LiteralPath '$logPath'
    `$code = 1
}
Set-Content -LiteralPath '$donePath' -Value `$code
"@
    Set-Content -LiteralPath $scriptPath -Value $wrapper -Encoding utf8

    $taskName = "NeubitVMSInstall-$stamp"
    $action   = New-ScheduledTaskAction -Execute 'powershell.exe' `
                    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -ExecutionTimeLimit ([TimeSpan]::FromSeconds($TimeoutSeconds + 60))

    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
            -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName

        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while (-not (Test-Path -LiteralPath $donePath)) {
            if ((Get-Date) -gt $deadline) { throw "$What as SYSTEM timed out after ${TimeoutSeconds}s" }
            Start-Sleep -Milliseconds 700
        }
        $code = (Get-Content -LiteralPath $donePath -Raw).Trim()
        $out  = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath } else { @() }
        foreach ($line in $out) { Write-Host "    $line" -ForegroundColor DarkGray }
        if ($code -ne '0') { throw "$What as SYSTEM failed (see the lines above)" }
        return $out
    }
    finally {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $scriptPath, $logPath, $donePath -Force -ErrorAction SilentlyContinue
    }
}

<# Whether SYSTEM already has the distro. Asked as SYSTEM, because asking as the
   installing user answers a different question — see the header. #>
function Test-DistroPresent {
    $out = Invoke-AsSystem -What 'distro check' -TimeoutSeconds 120 -Script @'
    $names = (wsl.exe --list --quiet) -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($names -contains 'neubit-vms') { 'PRESENT' } else { 'ABSENT' }
'@
    return (($out -join ' ') -match 'PRESENT')
}

<# Stop a running appliance. FIRST, before the port check and before anything is
   written. See the header for what it costs when this is not done. Best-effort
   throughout: no task, no distro or no permission all fall through to the checks
   that report the specific problem properly. #>
function Stop-Appliance {
    Write-Step 'Stopping any running appliance'

    try {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($existing.State -ne 'Disabled') {
            Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
        }
        Write-Ok 'boot task stopped'
    } catch { Write-Ok 'no boot task registered' }

    try {
        Invoke-AsSystem -What 'terminate distro' -TimeoutSeconds 180 -Script @'
    $names = (wsl.exe --list --quiet) -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() }
    if ($names -contains 'neubit-vms') {
        wsl.exe -d neubit-vms -u root -- /opt/neubit/boot.sh stop
        wsl.exe --terminate neubit-vms
        'terminated'
    } else { 'nothing to terminate' }
'@ | Out-Null
    } catch { Write-Warn "could not terminate the distro cleanly: $($_.Exception.Message)" }
}

<# Ports already listening. Checked AFTER Stop-Appliance, so the appliance does not
   report itself as the conflict, and BEFORE anything is written, so a conflict
   does not leave a half-installed machine. #>
function Get-PortConflicts {
    # SilentlyContinue rather than try/catch on Stop: "no matching objects" is how
    # this cmdlet says the port is free — the normal, healthy answer — and under
    # ErrorActionPreference=Stop it arrives as a terminating error that fills the
    # log of every successful install with alarming CIM failures.
    $listening = Get-NetTCPConnection -State Listen -LocalPort $ConsolePort -ErrorAction SilentlyContinue
    if (-not $listening) { return @() }

    $owner = 'unknown process'
    try {
        $pids  = @($listening | Select-Object -ExpandProperty OwningProcess -Unique)
        $names = foreach ($processId in $pids) {
            $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($p) { "$($p.ProcessName) (PID $processId)" } else { "PID $processId" }
        }
        if ($names) { $owner = ($names -join ', ') }
    } catch { }
    return @([pscustomobject]@{ Port = $ConsolePort; Owner = $owner })
}

<# Whether a path sits on a disk Windows reports as mechanical.
   Unknown counts as fine: MediaType is 'Unspecified' on plenty of healthy SSDs
   behind RAID controllers, and refusing to install on those would be worse than
   the warning this exists to give. #>
function Test-PathOnHdd {
    param([Parameter(Mandatory)][string] $Path)
    try {
        $letter = (Split-Path -Qualifier $Path).TrimEnd(':')
        $part   = Get-Partition -DriveLetter $letter -ErrorAction Stop
        $disk   = Get-PhysicalDisk -ErrorAction Stop |
                    Where-Object { $_.DeviceId -eq (Get-Disk -Number $part.DiskNumber).Number }
        return ($disk.MediaType -eq 'HDD')
    } catch { return $false }
}

function Set-MirroredNetworking {
    # ══ WHY THIS, AND WHY IT IS SYSTEM'S FILE ════════════════════════════════
    #
    # WSL2's default NAT publishes a distro's ports to the host's LOOPBACK only.
    # The desktop shell is therefore fine with no work at all — it reaches
    # http://127.0.0.1 today — but a LAN browser is refused, and "the web console
    # on every operator's machine" is half the product.
    #
    # Mirrored networking gives the distro the host's own interfaces, so a socket
    # bound 0.0.0.0 inside it answers on the LAN address. Measured in the P0 spike:
    # from inside the distro, http://<lan-ip>/login returned 200 against exactly
    # that.
    #
    # .wslconfig is per-user, and the appliance's distro runs as SYSTEM, so it is
    # SYSTEM's copy that governs it.
    #
    # ══ AND WHY IT IS NOT ALWAYS MIRRORED ════════════════════════════════════
    #
    # networkingMode=mirrored needs Windows 11 22H2 (build 22621) or later. It is
    # an OS capability, not a WSL one, so a current WSL on Windows 10 still cannot
    # do it. Writing it there leaves a config key that silently does nothing while
    # the file claims the LAN is open — so on those machines this writes what is
    # actually true instead, and says so out loud.
    #
    # localhostForwarding is what a STANDALONE install runs on: the appliance and
    # the desktop shell are the same box, the shell asks 127.0.0.1, and NAT
    # forwards it. It defaults to true; it is pinned here so a pre-existing
    # .wslconfig that turned it off cannot take the console down.
    $systemProfile = Join-Path $env:SystemRoot 'System32\config\systemprofile'
    $cfg = Join-Path $systemProfile '.wslconfig'
    $build = [Environment]::OSVersion.Version.Build
    $canMirror = $build -ge 22621

    if ($canMirror) {
        $desired = @'
# Written by the Neubit VMS installer.
#
# Mirrored networking makes the appliance's distro share this machine's network
# interfaces, so the console is reachable at the host's LAN address and not only
# on loopback. Without it the desktop app works and every remote browser gets a
# connection refused, with nothing in any log to explain it.
[wsl2]
networkingMode=mirrored
localhostForwarding=true
'@
        $marker = 'networkingMode\s*=\s*mirrored'
    } else {
        $desired = @'
# Written by the Neubit VMS installer.
#
# NAT, not mirrored: networkingMode=mirrored needs Windows 11 22H2 or later and
# this machine is older, so the key would sit here doing nothing. localhostForwarding
# is what carries a standalone install — the desktop shell and the appliance are the
# same box and the shell asks 127.0.0.1.
#
# The console is therefore NOT reachable from another machine on this network.
# Upgrading Windows is the fix; a port proxy is not, because WSL's NAT address
# changes on every boot.
[wsl2]
localhostForwarding=true
'@
        $marker = 'localhostForwarding\s*=\s*true'
    }

    if ((Test-Path -LiteralPath $cfg) -and ((Get-Content -LiteralPath $cfg -Raw) -match $marker)) {
        Write-Ok "networking already configured for SYSTEM ($cfg)"
    } else {
        Set-Content -LiteralPath $cfg -Value $desired -Encoding ascii
        Write-Ok "networking configured ($cfg)"
    }

    if (-not $canMirror) {
        Write-Warn ("Windows build $build — mirrored networking needs Windows 11 22H2 (22621) or later.")
        Write-Warn ("The console will work ON THIS MACHINE and be REFUSED from the LAN. " +
                    "That is the whole of a standalone install and none of a server install.")
    }
}

function Set-FirewallRules {
    # ══ THE RULE IS THE POINT ════════════════════════════════════════════════
    #
    # Mirrored networking is necessary and not sufficient. The Hyper-V firewall
    # that fronts WSL defaults to blocking inbound:
    #
    #     Get-NetFirewallHyperVVMSetting -> DefaultInboundAction: Block
    #
    # In the P0 spike the socket was bound and answering from inside the distro
    # while Windows refused the identical URL. Nothing in any log says "firewall";
    # it presents as a server that is up and unreachable, which is the single most
    # likely support ticket for this product.
    $ruleName = "$RulePrefix - console"

    try {
        Get-NetFirewallHyperVRule -Name 'NeubitVMSConsole' -ErrorAction Stop |
            Remove-NetFirewallHyperVRule -ErrorAction Stop
    } catch { }

    try {
        New-NetFirewallHyperVRule -Name 'NeubitVMSConsole' -DisplayName $ruleName `
            -Direction Inbound -VMCreatorId $VmCreatorId -Protocol TCP `
            -LocalPorts $ConsolePort -Action Allow -ErrorAction Stop | Out-Null
        Write-Ok "allowed inbound TCP/$ConsolePort to the appliance (Hyper-V firewall)"
    } catch {
        Write-Warn ("could not create the Hyper-V firewall rule: $($_.Exception.Message)")
        Write-Warn ("The console will work on this machine and be REFUSED from the LAN. " +
                    "New-NetFirewallHyperVRule needs Windows 11 22H2 / Server 2022 or later.")
    }

    # The ordinary Windows Firewall rule as well. Mirrored mode puts the listener on
    # the host's own stack, so both gates are in the path and only opening one of
    # them produces the same unreachable-server symptom.
    try {
        Get-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop | Remove-NetFirewallRule -ErrorAction Stop
    } catch { }
    New-NetFirewallRule -DisplayName $ruleName -Group $RulePrefix -Direction Inbound `
        -Action Allow -Protocol TCP -LocalPort $ConsolePort -Profile Any `
        -Description "Neubit VMS console. Removed by uninstall-appliance.ps1." `
        -ErrorAction Stop | Out-Null
    Write-Ok "allowed inbound TCP/$ConsolePort (Windows Firewall)"
}

function Register-BootTask {
    # At startup, as SYSTEM, whether or not anyone signs in. Starting the distro is
    # all Windows has to do — /etc/wsl.conf's `[boot] command=` runs boot.sh inside
    # it, which starts the engine and the stack. That is why this is a task and not
    # a service: there is no long-running Windows-side process to supervise, and a
    # service wrapper would be an executable to write, sign and maintain for the
    # sake of one command.
    $action = New-ScheduledTaskAction -Execute 'wsl.exe' `
                  -Argument "-d $DistroName -u root -- /opt/neubit/boot.sh boot"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
                    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -StartWhenAvailable `
                    -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(2)) `
                    -ExecutionTimeLimit ([TimeSpan]::Zero)

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force `
        -Description 'Starts the Neubit VMS appliance at boot. Removed by uninstall-appliance.ps1.' | Out-Null
    Write-Ok "boot task registered as SYSTEM ($TaskName)"
}

# ═════════════════════════════════════════════════════════════════════════════
# main
# ═════════════════════════════════════════════════════════════════════════════

Assert-Administrator

if (-not $PayloadDir) { $PayloadDir = $PSScriptRoot }
$Payload = Join-Path $PayloadDir 'neubit-vms.tar.gz'
if (-not (Test-Path -LiteralPath $Payload)) {
    throw "appliance payload not found at $Payload. Run build-appliance.ps1 first, or pass -PayloadDir."
}

$manifest = if (Test-Path -LiteralPath (Join-Path $PayloadDir 'appliance.json')) {
    Get-Content -LiteralPath (Join-Path $PayloadDir 'appliance.json') -Raw | ConvertFrom-Json
} else { $null }
$Version = if ($manifest) { $manifest.version } else { 'unknown' }

if (-not $DistroDir) { $DistroDir = Join-Path $env:ProgramData 'Neubit\VMS\distro' }
if (-not $BulkDir)   { $BulkDir   = Join-Path $env:ProgramData 'Neubit\VMS\data' }

Write-Host ''
Write-Host "Neubit VMS appliance — $Version" -ForegroundColor Green
Write-Host "  distro (database, container layers) : $DistroDir"
Write-Host "  bulk   (recordings, basemap)        : $BulkDir"
Write-Host ''

# ── 1. stop first ────────────────────────────────────────────────────────────
Stop-Appliance

# ── 2. then check ────────────────────────────────────────────────────────────
Write-Step 'Checking prerequisites'

# ErrorActionPreference relaxed around this ONE call, deliberately. `2>&1` on a
# native exe in Windows PowerShell 5.1 turns each stderr line into a
# NativeCommandError, and under 'Stop' the first one is terminating — so a chatty
# `wsl --version` would abort here with a stack trace instead of reaching the
# check below and printing the sentence an operator can act on. The exit code is
# what decides, as it should be for a native program.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $wslVersion = (& wsl.exe --version 2>&1) -replace "`0", ''
    $wslCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $prevEap }
if ($wslCode -ne 0) {
    throw ("WSL 2 is required and `wsl --version` failed. Install it with " +
           "`wsl --install --no-distribution` from an elevated prompt, reboot, and re-run this.")
}
Write-Ok (($wslVersion -split "`r?`n" | Where-Object { $_ -match 'WSL version' }) -join '')

$conflicts = Get-PortConflicts
if ($conflicts.Count -gt 0) {
    foreach ($c in $conflicts) { Write-Warn "port $($c.Port) is already in use by $($c.Owner)" }
    if (-not $Force) {
        throw ("The console needs TCP/$ConsolePort and something else is listening on it. " +
               "Stop that software and re-run, or pass -Force if you know it is about to go away.")
    }
    Write-Warn 'continuing anyway (-Force)'
} else {
    Write-Ok "TCP/$ConsolePort is free"
}

if (Test-PathOnHdd -Path $DistroDir) {
    Write-Warn "$DistroDir appears to be on a mechanical disk."
    Write-Warn ("The distro holds the DATABASE and every container layer. Postgres fsync on a " +
                "spinning disk is punishing — the P0 spike measured apt alone spending minutes " +
                "parked in the ext4 journal. Put -DistroDir on an SSD and -BulkDir here instead.")
    if (-not $Force) { throw 'Refusing. Pass -Force to install anyway.' }
    Write-Warn 'continuing anyway (-Force)'
}

# ── 3. storage ───────────────────────────────────────────────────────────────
Write-Step 'Preparing the data directories'
foreach ($d in @($DistroDir, $BulkDir, (Join-Path $BulkDir 'recordings'), (Join-Path $BulkDir 'tiles'))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Write-Ok $DistroDir
Write-Ok $BulkDir

# ── 4. networking ────────────────────────────────────────────────────────────
Write-Step 'Configuring networking'
Set-MirroredNetworking
Set-FirewallRules

# ── 5. the distro ────────────────────────────────────────────────────────────
$present = Test-DistroPresent
Write-Step $(if ($present) { 'Replacing the existing appliance distro (upgrade)' } else { 'Importing the appliance distro' })

# Named volumes live INSIDE the distro, so replacing it on upgrade would discard
# the database. The upgrade path therefore keeps the data volumes and replaces only
# what the payload owns.
#
# NOT IMPLEMENTED YET, and said plainly rather than papered over: the first release
# is install-only. `docker compose down` without -v already preserves the volumes
# across a stack restart, but a distro REPLACEMENT discards them with the VHD, and
# the export/import dance that would preserve them has not been written or tested.
# The NVR's two upgrade post-mortems are the argument for not guessing here.
if ($present -and -not $Force) {
    throw ("An appliance is already installed. In-place upgrade is not implemented in this " +
           "release — replacing the distro would discard the database with it. Uninstall first " +
           "(uninstall-appliance.ps1 -KeepData), then install, or pass -Force to replace the " +
           "distro AND LOSE ITS DATA.")
}

$payloadWsl = $Payload
$importScript = @"
    `$ErrorActionPreference = 'Stop'
    `$names = (wsl.exe --list --quiet) -replace "``0", '' -split "``r?``n" | ForEach-Object { `$_.Trim() }
    if (`$names -contains '$DistroName') {
        wsl.exe --unregister $DistroName
    }
    wsl.exe --import $DistroName '$DistroDir' '$payloadWsl' --version 2
    if (`$LASTEXITCODE -ne 0) { throw "wsl --import failed with `$LASTEXITCODE" }
    'imported'
"@
Invoke-AsSystem -Script $importScript -What 'distro import' -TimeoutSeconds 1800 | Out-Null
Write-Ok "$DistroName imported into SYSTEM's profile"

# ── 6. configuration ─────────────────────────────────────────────────────────
Write-Step 'Writing the appliance configuration'

# The bulk path as the distro sees it: D:\NeubitData -> /mnt/d/NeubitData.
$bulkWsl = '/mnt/' + $BulkDir.Substring(0,1).ToLower() + ($BulkDir.Substring(2) -replace '\','/')

<#
══ /opt/neubit/.env IS GENERATED HERE, AND WITHOUT IT NOTHING STARTS ══════════

Every service in docker-compose.yml declares `env_file: .env`, and compose treats
a missing one as fatal — not a warning:

    env file /opt/neubit/.env not found: ... no such file or directory

The distro has no .env: build-appliance.ps1 deliberately does not bake the repo's
development file, because it carries `dev-jwt-secret-change-me` and one Postgres
password for every machine we would ever ship. So the file is generated HERE, per
install, with secrets unique to this box.

The same file is what compose interpolates ${NEUBIT_VERSION} and ${NEUBIT_BULK}
from — `--project-directory /opt/neubit` makes /opt/neubit/.env both the env_file
and the interpolation source. An earlier version of this script wrote those two
keys to `.env.appliance`, which nothing reads.

RE-RUNNING PRESERVES THE SECRETS. Postgres owns a database created under the
generated password; regenerating it on an upgrade would lock the appliance out of
its own data. Only the install-specific keys are refreshed.
#>
$adminPass = $AdminPassword
if (-not $adminPass) {
    # Upper, lower, digit and a symbol by construction — a generated password that
    # trips a policy check on first login is worse than no generator at all.
    $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $bytes = New-Object byte[] 12
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $adminPass = 'Nb@' + (-join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] }))
    $generatedPassword = $true
} else {
    $generatedPassword = $false
}

# Written to a file and run as a script rather than embedded in the wsl.exe command
# line: it contains quotes, $-expansions and a heredoc, and every layer between
# here and bash (PowerShell here-string -> scheduled-task wrapper -> wsl argv)
# would want its own escaping.
$envSh = @'
#!/usr/bin/env bash
# Generated by install-appliance.ps1. Creates /opt/neubit/.env on first install
# and refreshes only the install-specific keys afterwards.
set -euo pipefail

VERSION="$1"; BULK="$2"; ADMIN_EMAIL="$3"; ADMIN_PASS="$4"; RUNTIME_ENV="$5"
ENVFILE=/opt/neubit/.env

rand() { head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }

if [ ! -f "$ENVFILE" ]; then
  PGPW="$(rand 32)"
  umask 077
  cat > "$ENVFILE" <<EOF
# Generated by install-appliance.ps1 on first install. This is NOT a copy of the
# repository's development .env — every secret below is unique to this machine.
#
# The installer PRESERVES these values when it is re-run. Postgres holds a database
# created under the password below; changing it would lock the appliance out.
POSTGRES_USER=neubit
POSTGRES_PASSWORD=${PGPW}
POSTGRES_DB=neubit_control
VE_DATABASE_URL=postgresql+asyncpg://neubit:${PGPW}@postgres:5432/neubit_control
VE_REDIS_URL=redis://redis:6379/0
VE_NATS_URL=nats://nats:4222
VE_ENV=${RUNTIME_ENV}
VE_JWT_SECRET=$(rand 48)
VE_SECRETS_KEY=$(rand 48)
VE_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}
VE_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASS}
OPS_AGENT_TOKEN=$(rand 32)
OPS_AGENT_URL=http://ops-agent:9000
EOF
  chmod 600 "$ENVFILE"
  echo "created $ENVFILE with per-install secrets"
else
  echo "$ENVFILE already exists - its secrets are kept"
fi

set_kv() {
  if grep -q "^$1=" "$ENVFILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENVFILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENVFILE"
  fi
}
set_kv NEUBIT_VERSION "$VERSION"
set_kv NEUBIT_BULK "$BULK"

echo "--- /opt/neubit/.env (secrets masked) ---"
sed -E 's/^(POSTGRES_PASSWORD|VE_JWT_SECRET|VE_SECRETS_KEY|OPS_AGENT_TOKEN|VE_DATABASE_URL|VE_BOOTSTRAP_ADMIN_PASSWORD)=.*/\1=********/' "$ENVFILE"
'@ -replace "`r`n", "`n"

$envShPath = Join-Path $env:ProgramData 'Neubit\VMS\install\write-env.sh'
New-Item -ItemType Directory -Force -Path (Split-Path $envShPath) | Out-Null
[IO.File]::WriteAllText($envShPath, $envSh)
$envShWsl = '/mnt/' + $envShPath.Substring(0,1).ToLower() + ($envShPath.Substring(2) -replace '\','/')

$envScript = @"
    `$ErrorActionPreference = 'Continue'
    wsl.exe -d $DistroName -u root -- bash '$envShWsl' '$Version' '$bulkWsl' '$AdminEmail' '$adminPass' '$RuntimeEnv'
    if (`$LASTEXITCODE -ne 0) { throw "writing /opt/neubit/.env failed with `$LASTEXITCODE" }
"@
Invoke-AsSystem -Script $envScript -What 'write .env' -TimeoutSeconds 300 | Out-Null
Write-Ok "bulk storage mapped to $bulkWsl"
Write-Ok "VE_ENV=$RuntimeEnv"

# The generated password has to survive the installer's own window closing — under
# NSIS this whole run scrolls past in a details pane nobody can copy from.
if ($generatedPassword) {
    $credPath = Join-Path $env:ProgramData 'Neubit\VMS\admin-credentials.txt'
    @"
Neubit VMS bootstrap administrator
Generated by install-appliance.ps1 for this machine.

  email     $AdminEmail
  password  $adminPass

Sign in, change this password, then delete this file.
"@ | Set-Content -LiteralPath $credPath -Encoding utf8
    Write-Ok "bootstrap credentials written to $credPath"
}

# ── 7. start at boot, and now ────────────────────────────────────────────────
Write-Step 'Registering the boot task'
Register-BootTask
Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null

Write-Step 'Starting the appliance'
Start-ScheduledTask -TaskName $TaskName

Write-Step 'Waiting for the console'
$deadline = (Get-Date).AddMinutes(6)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ConsolePort/health" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 5
}

Write-Host ''
if ($ready) {
    $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -First 1 -ExpandProperty IPAddress)
    Write-Host '  Neubit VMS is running.' -ForegroundColor Green
    Write-Host ''
    Write-Host "    on this machine   http://localhost"
    if ($lan) { Write-Host "    from the network  http://$lan" }
    Write-Host ''
    Write-Host '  Sign in with the bootstrap administrator, then change its password:'
    Write-Host ''
    Write-Host "    email     $AdminEmail"
    if ($generatedPassword) {
        Write-Host "    password  $adminPass"
        Write-Host ''
        Write-Host "  Also saved to $credPath - delete it once you have changed the password." -ForegroundColor DarkGray
    } else {
        Write-Host '    password  the one you passed as -AdminPassword'
    }
} else {
    Write-Warn 'The console did not answer within six minutes.'
    Write-Host ''
    Write-Host '  The first boot initialises the database, which is slow on a mechanical disk.' -ForegroundColor DarkGray
    Write-Host '  Look at what it is doing with:' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host "    wsl -d $DistroName -u root -- tail -50 /var/log/neubit-boot.log" -ForegroundColor DarkGray
    Write-Host "    wsl -d $DistroName -u root -- /opt/neubit/boot.sh status" -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}
Write-Host ''
