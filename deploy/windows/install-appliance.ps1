<#
.SYNOPSIS
    Install the Neubit VMS appliance on this Windows box.

.DESCRIPTION
    Imports the baked WSL2 distro, points it at the storage the operator chose,
    arranges for it to start at boot with nobody logged in, and opens the one port
    the console needs.

    ══ NOTHING RUNS AS SYSTEM, AND THAT IS NOT A PREFERENCE ═════════════════════

    This script used to import the distro, write .wslconfig and register the boot
    task all in SYSTEM's context. WSL distros are registered PER USER under
    HKCU\...\Lxss, a boot-time task runs as SYSTEM, and so SYSTEM had to be the
    owner or the appliance would work beautifully until the first reboot and never
    start again with nobody signed in.

    That design is dead. WSL refuses LocalSystem outright:

        Running WSL as local system is not supported.
        Error code: Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED

    and the fallback everyone reaches for next — a task under a normal account with
    "run whether user is logged on or not" — fails for a second, independent reason:
    the Store build of WSL is not reachable from session 0 at all
    (microsoft/WSL#9271, #11280). No scheduled task of any shape can start a distro
    with nobody signed in. Pinning an older WSL is not an answer either; the Store
    updates it in the background and the appliance would then die silently at the
    next reboot rather than at install time (microsoft/WSL#41394).

    So the appliance runs in the INSTALLING USER'S session: the distro is imported
    as that account, .wslconfig is that account's, and the trigger is AT LOGON
    rather than at startup. Unattended restart becomes a Windows problem instead of
    a WSL one, and is solved the way Docker Desktop solves it — auto-logon a
    dedicated account.

    This script deliberately does NOT configure auto-logon. It enables the built-in
    netplwiz option and prints the two steps, because netplwiz stores the credential
    as an LSA secret while this script would have to write cleartext into HKLM, and
    because storing a password on a customer's machine is their decision to make.

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

# The account that owns the distro and runs the logon task. Elevation does not
# change it — an administrator elevating their own session keeps the same SID and
# the same profile, and WSL's per-user registration keys off exactly that. Read it
# once so the import, the trigger and the messages cannot disagree.
$OwnerAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name

# ══ WHAT MAKES AN INSTALL "REAL" ═════════════════════════════════════════════
#
# Not the presence of the distro. An import that completed and then hit any error
# on the way to a running stack leaves a registered distro that has never held a
# byte of anybody's data — and the guard protecting the database cannot tell it
# apart from a production appliance, so it refuses and sends the operator to the
# uninstaller with no way to know what they are about to destroy.
#
# The distro can only hold data once /opt/neubit/.env exists: nothing in the stack
# starts without it, and Postgres creates its database on first boot. So the
# installer records that moment here, and THIS FILE, not the distro, is what means
# "there may be data inside". Distro present and no state file = a wreck from an
# unfinished run, and replacing it costs nothing.
#
# Deliberately conservative in the one direction that matters: .env written but the
# stack never started is still treated as data-bearing.
$StatePath = Join-Path $env:ProgramData 'Neubit\VMS\install-state.json'

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
Run a block of PowerShell in THIS session and return its output.

It used to run as SYSTEM through a throwaway scheduled task. It does not any more,
and the replacement is deliberately the dullest thing that can work: this script is
already running interactively and elevated as the account that will own the distro,
which is precisely the context every one of these commands needs. There is nothing
left to hand the work off to.

The blocks are passed as text rather than script blocks because their callers build
them by interpolation, and are echoed as they run — a `wsl --import` of 2.9 GB is
several minutes of silence otherwise.

Output is routed through a file rather than the task's own streams: a task has no
stdout to inherit, and losing the child's explanation is the single most expensive
mistake the NVR made in this area — `Start-Transcript` does not capture a native
command's console output either, so a careful error message went to a console
nobody was watching while the log recorded "exit code 1".
#>
function Invoke-InSession {
    param(
        [Parameter(Mandatory)][string] $Script,
        [string] $What = 'command',
        # For blocks whose output is a value this script reads rather than progress
        # an operator should see. Without it an internal check answers the console
        # with a bare 'ABSENT' between two unrelated steps.
        [switch] $Quiet
    )

    $block = [scriptblock]::Create($Script)

    # Relaxed for the same reason it is relaxed around every other native call in
    # this script: in Windows PowerShell 5.1, `2>&1` on a native exe wraps each
    # stderr line in a NativeCommandError, and under 'Stop' the first one is
    # terminating — so wsl.exe reporting ordinary progress would abort the install.
    # The blocks below check $LASTEXITCODE and throw on their own.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $block 2>&1 | ForEach-Object {
            $line = $_.ToString()
            if (-not $Quiet) { Write-Host "    $line" -ForegroundColor DarkGray }
            $line
        }
    }
    catch { throw "$What failed: $($_.Exception.Message)" }
    finally { $ErrorActionPreference = $prev }

    return $out
}

<# Whether this account already has the distro. Asked as this account, because
   that is now the only account that can have it — see the header. #>
function Test-DistroPresent {
    $out = Invoke-InSession -What 'distro check' -Quiet -Script @'
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
        Write-Ok 'logon task stopped'
    } catch { Write-Ok 'no logon task registered' }

    try {
        Invoke-InSession -What 'terminate distro' -Script @'
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
    # .wslconfig is per-user, and the appliance's distro is registered to the
    # installing account, so it is THAT account's copy that governs it. It was
    # SYSTEM's until WSL stopped supporting LocalSystem — see the header.
    #
    # ══ AND WHY IT IS NOT ALWAYS MIRRORED ════════════════════════════════════
    #
    # networkingMode=mirrored needs Windows 11 22H2 (build 22621) or later. It is
    # an OS capability, not a WSL one, so a current WSL on Windows 10 still cannot
    # do it. Writing it there leaves a config key that silently does nothing while
    # the file claims the LAN is open — so on those machines this writes what is
    # actually true instead, and says so out loud.
    #
    # localhostForwarding belongs ONLY to the NAT branch. It is what a standalone
    # install runs on there: the appliance and the shell are the same box, the shell
    # asks 127.0.0.1, and NAT forwards it. Under mirrored networking it means
    # nothing — the distro is on the host's own stack — and current WSL says so on
    # every single invocation:
    #
    #     wsl: The wsl2.localhostForwarding setting has no effect when using
    #          mirrored networking mode
    #
    # on stderr, where it cost a 2.9 GB import. Writing a key that does nothing is
    # cheap; writing one the tool argues with on every call is not.
    $cfg = Join-Path $env:USERPROFILE '.wslconfig'
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
'@
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
    }

    # Compare the whole file, not a marker line. A marker match said "already
    # configured" for any file that merely mentioned the right key — including one
    # this installer wrote in an older shape, which is how a machine kept a
    # .wslconfig that made wsl.exe complain on every call.
    $existing = if (Test-Path -LiteralPath $cfg) { (Get-Content -LiteralPath $cfg -Raw) } else { '' }
    if ($existing.Trim() -eq $desired.Trim()) {
        Write-Ok "networking already configured for $OwnerAccount ($cfg)"
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

function Write-AutoLogonInstructions {
    # ══ THE STEP THAT IS NOT DONE YET ════════════════════════════════════════
    #
    # Printed on EVERY outcome, deliberately. It lived in the success branch
    # only, so the one run that timed out told an engineer the install had
    # failed and never mentioned the step still owed — on an install that had in
    # fact completed. Whether the console answered in time has nothing to do with
    # whether this machine can restart on its own.
    #
    # The appliance starts from a LOGON task; see the header for why no boot task
    # can work. A server that reboots to a sign-in screen serves nothing until
    # somebody signs in.
    Write-Host ''
    Write-Host '  ONE STEP LEFT - without it this server does NOT come back on its own.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "  The appliance starts when $OwnerAccount signs in. Make Windows do that:"
    Write-Host ''
    Write-Host '    1. netplwiz'
    Write-Host '    2. clear  "Users must enter a user name and password to use this computer"'
    Write-Host "    3. choose $OwnerAccount, enter its password, OK"
    Write-Host '    4. reboot, sign in to NOTHING, and browse to this box from another machine'
    Write-Host ''
    Write-Host '  Step 4 is the only proof. Everything before it works just as well on a' -ForegroundColor DarkGray
    Write-Host '  machine that never restarts unattended.' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Lock the console afterwards if the machine is reachable by people: set a' -ForegroundColor DarkGray
    Write-Host '  screen saver with "On resume, display logon screen". Locking keeps the' -ForegroundColor DarkGray
    Write-Host '  session - and the appliance - running.' -ForegroundColor DarkGray
}

function Register-LogonTask {
    # AT LOGON, as the account that owns the distro — not at startup, and not as
    # SYSTEM. See the header for why neither of those is available any more.
    #
    # Starting the distro is all Windows has to do: /etc/wsl.conf's `[boot] command=`
    # runs boot.sh inside it, which starts the engine and the stack. That is why this
    # is a task and not a service — there is no long-running Windows-side process to
    # supervise, and a service could not launch WSL anyway.
    $action = New-ScheduledTaskAction -Execute 'wsl.exe' `
                  -Argument "-d $DistroName -u root -- /opt/neubit/boot.sh boot"

    # A short delay, because the trigger fires while the session is still being
    # built. Mirrored networking follows the host's interfaces, and starting the
    # distro before they are up costs a restart cycle for nothing.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $OwnerAccount
    $trigger.Delay = 'PT20S'

    $principal = New-ScheduledTaskPrincipal -UserId $OwnerAccount -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
                    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -StartWhenAvailable `
                    -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(2)) `
                    -ExecutionTimeLimit ([TimeSpan]::Zero)

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force `
        -Description "Starts the Neubit VMS appliance when $OwnerAccount signs in. Removed by uninstall-appliance.ps1." | Out-Null
    Write-Ok "logon task registered for $OwnerAccount ($TaskName)"
}

function Enable-AutoLogonOption {
    # Windows 11 hides netplwiz's "Users must enter a user name and password"
    # checkbox whenever passwordless (Hello) sign-in is on, which is the default —
    # so the operator opens the dialog this script tells them to open and the option
    # they were told to clear is not there. Clearing this value shows it again.
    #
    # It enables NOTHING on its own and stores no password. Auto-logon is still an
    # explicit act by the operator, in a built-in dialog that puts the credential in
    # an LSA secret rather than in the cleartext HKLM values this script would
    # otherwise have to write.
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device'
    try {
        if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
        Set-ItemProperty -LiteralPath $key -Name 'DevicePasswordLessBuildVersion' -Value 0 -Type DWord
        Write-Ok 'netplwiz auto-logon option made visible (nothing enabled, no password stored)'
    } catch {
        Write-Warn "could not unhide the netplwiz auto-logon option: $($_.Exception.Message)"
    }
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

$conflicts = @(Get-PortConflicts)
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
$present    = Test-DistroPresent
$configured = Test-Path -LiteralPath $StatePath

# A state file with no distro is the opposite wreck — someone unregistered the
# distro by hand. Say so and carry on; there is nothing left to protect.
if ($configured -and -not $present) {
    Write-Warn "$StatePath describes an install whose distro is gone. Treating this as a fresh install."
    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    $configured = $false
}

Write-Step $(
    if     ($present -and $configured) { 'Replacing the existing appliance distro (upgrade)' }
    elseif ($present)                  { 'Replacing a distro left behind by an unfinished install' }
    else                               { 'Importing the appliance distro' }
)

# Named volumes live INSIDE the distro, so replacing it on upgrade would discard
# the database. The upgrade path therefore keeps the data volumes and replaces only
# what the payload owns.
#
# NOT IMPLEMENTED YET, and said plainly rather than papered over: the first release
# is install-only. `docker compose down` without -v already preserves the volumes
# across a stack restart, but a distro REPLACEMENT discards them with the VHD, and
# the export/import dance that would preserve them has not been written or tested.
# The NVR's two upgrade post-mortems are the argument for not guessing here.
if ($present -and $configured -and -not $Force) {
    $state = try { Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } catch { $null }
    $when  = if ($state -and $state.PSObject.Properties.Name -contains 'installed') { $state.installed } else { 'an earlier run' }
    throw ("An appliance was installed by $when and may hold its database. In-place upgrade " +
           "is not implemented in this release — replacing the distro would discard the " +
           "database with it. Uninstall first (uninstall-appliance.ps1 -KeepData), then " +
           "install, or pass -Force to replace the distro AND LOSE ITS DATA.")
}

if ($present -and -not $configured) {
    Write-Warn 'A distro from an unfinished install is registered. It was never configured —'
    Write-Warn 'no .env, so nothing ever started and there is no database to lose. Replacing it.'
}

$payloadWsl = $Payload
$importScript = @"
    # NOT 'Stop'. wsl.exe writes ordinary notices to stderr, PowerShell 5.1 wraps
    # each one in a NativeCommandError, and under 'Stop' the first is terminating —
    # so a warning about an unrelated .wslconfig key aborted a 2.9 GB import that
    # had not started yet. The exit code below is what decides, as it should be for
    # a native program. Same reasoning as the prerequisite check above.
    `$ErrorActionPreference = 'Continue'
    `$names = (wsl.exe --list --quiet) -replace "``0", '' -split "``r?``n" | ForEach-Object { `$_.Trim() }
    if (`$names -contains '$DistroName') {
        wsl.exe --unregister $DistroName
    }
    wsl.exe --import $DistroName '$DistroDir' '$payloadWsl' --version 2
    if (`$LASTEXITCODE -ne 0) { throw "wsl --import failed with `$LASTEXITCODE" }
    'imported'
"@
Invoke-InSession -Script $importScript -What 'distro import' | Out-Null
Write-Ok "$DistroName imported for $OwnerAccount"

<#
Refresh /opt/neubit/boot.sh from the payload directory when one is shipped there.

boot.sh is baked INTO the distro, which means a one-line fix to the appliance's
own init used to cost a full 2.9 GB rebake and a redelivery to site. That is the
wrong price for the script most likely to need a field fix, and it was paid the
first time boot.sh was found swallowing its own `status` output on a customer
machine.

Same file, same commit — build-appliance.ps1 stages it beside the installer as
well as inside the tarball, so this overwrites like with like. Best effort: no
boot.sh beside the installer means an older payload layout, and the baked one is
correct for it.
#>
$bootShHost = Join-Path $PayloadDir 'boot.sh'
if (Test-Path -LiteralPath $bootShHost) {
    # Normalised HERE, in PowerShell, rather than with a sed inside the distro.
    # The sed needed a carriage return in its pattern, and every layer between this
    # file and bash wants its own escaping for that — the first attempt ended up
    # embedding a real CR byte in this script, in a repo whose .gitattributes
    # normalises line endings. `r`n is PowerShell's own escape and cannot be
    # misread by anything downstream, because nothing downstream sees it.
    $bootShLf = Join-Path $env:ProgramData 'Neubit\VMS\install\boot.sh'
    New-Item -ItemType Directory -Force -Path (Split-Path $bootShLf) | Out-Null
    [IO.File]::WriteAllText($bootShLf, ((Get-Content -LiteralPath $bootShHost -Raw) -replace "`r`n", "`n"))
    $bootShWsl = '/mnt/' + $bootShLf.Substring(0,1).ToLower() + $bootShLf.Substring(2).Replace('\','/')
    try {
        Invoke-InSession -Quiet -What 'refresh boot.sh' -Script @"
    wsl.exe -d $DistroName -u root -- cp '$bootShWsl' /opt/neubit/boot.sh
    wsl.exe -d $DistroName -u root -- chmod +x /opt/neubit/boot.sh
    if (`$LASTEXITCODE -ne 0) { throw "refreshing boot.sh failed with `$LASTEXITCODE" }
"@ | Out-Null
        Write-Ok 'boot.sh refreshed from the payload'
    } catch {
        Write-Warn "could not refresh boot.sh: $($_.Exception.Message)"
        Write-Warn 'the copy baked into the distro will be used'
    }
}

# ── 6. configuration ─────────────────────────────────────────────────────────
Write-Step 'Writing the appliance configuration'

# The bulk path as the distro sees it: D:\NeubitData -> /mnt/d/NeubitData.
#
# .Replace(), not -replace. The right-hand side of -replace is a REGULAR
# EXPRESSION and a lone backslash is not a valid one, so every ordinary Windows
# path threw "The regular expression pattern \ is not valid" here -- one line into
# the configuration step, with the 2.9 GB import already behind it.
$bulkWsl = '/mnt/' + $BulkDir.Substring(0,1).ToLower() + $BulkDir.Substring(2).Replace('\','/')

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
$envShWsl = '/mnt/' + $envShPath.Substring(0,1).ToLower() + $envShPath.Substring(2).Replace('\','/')

$envScript = @"
    `$ErrorActionPreference = 'Continue'
    wsl.exe -d $DistroName -u root -- bash '$envShWsl' '$Version' '$bulkWsl' '$AdminEmail' '$adminPass' '$RuntimeEnv'
    if (`$LASTEXITCODE -ne 0) { throw "writing /opt/neubit/.env failed with `$LASTEXITCODE" }
"@
Invoke-InSession -Script $envScript -What 'write .env' | Out-Null
Write-Ok "bulk storage mapped to $bulkWsl"
Write-Ok "VE_ENV=$RuntimeEnv"

# The line past which this distro may hold data. Written here, immediately after
# .env, and not at the end of a successful run: a console that fails its six-minute
# health check has still created a database, and marking that install "incomplete"
# would hand the next attempt permission to delete it.
New-Item -ItemType Directory -Force -Path (Split-Path $StatePath) | Out-Null
[pscustomobject]@{
    distro    = $DistroName
    version   = $Version
    account   = $OwnerAccount
    distroDir = $DistroDir
    bulkDir   = $BulkDir
    installed = (Get-Date).ToString('s')
} | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
Write-Ok "recorded this install in $StatePath"

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
Write-Step 'Registering the logon task'
Register-LogonTask
Enable-AutoLogonOption
Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null

Write-Step 'Starting the appliance'
Start-ScheduledTask -TaskName $TaskName

# Start-ScheduledTask returns as soon as the request is accepted, not when the
# task runs. Asking afterwards separates "the stack is still coming up" from
# "nothing was ever launched" — two identical-looking silences.
Start-Sleep -Seconds 3
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
if ($taskInfo -and $taskInfo.LastRunTime -and $taskInfo.LastRunTime -gt (Get-Date).AddMinutes(-5)) {
    Write-Ok "logon task ran at $($taskInfo.LastRunTime)"
} else {
    Write-Warn 'the logon task does not report a recent run; watch the boot log if the console does not appear'
}

<#
The first boot is the long one, and this used to give it six minutes.

That is not enough and the failure was ugly: on the first customer install every
container was up and healthy, the console answered perfectly, and the installer
had already printed "The console did not answer within six minutes" and exited 1
— telling an engineer on a customer's site that a completed install had failed.
The stack has 15 containers and a first boot that builds the whole schema from
the ORM metadata before uvicorn binds a port.

So: wait longer, say what is happening while waiting, and when it does time out
ASK THE STACK before pronouncing. A console that has not answered yet is not the
same fault as a stack that never started, and the operator should not have to
know that to read the last line of an installer.
#>
<#
══ WHY THIS DOES NOT ASK LOCALHOST ═══════════════════════════════════════════

It used to ask only http://127.0.0.1/health, and on the first customer install it
never got an answer from a console that was serving perfectly the whole time.

Under networkingMode=mirrored the distro shares the HOST'S loopback, and Docker's
published port is not reachable there. The DNAT rule Docker installs sits in
PREROUTING and covers traffic arriving on an interface; loopback would need
docker-proxy, and it is not listening. Measured on that machine:

    direct to the container (172.18.0.4)  : 200
    the distro's eth0       (10.24.103.39): 200
    loopback                (127.0.0.1)   : 000

Loopback is the single address that cannot work under the networking mode this
installer itself configures, and it was the only one being tried.

So every local IPv4 is a candidate, loopback last. Which one answers is worth
knowing rather than hiding: it is the address the operator will hand to the
customer, and "http://localhost" printed as if it worked would send the next
engineer chasing a console that is up.
#>
Write-Step 'Waiting for the console'
Write-Host '    first boot builds the database schema; this can take several minutes' -ForegroundColor DarkGray

$candidates = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -ExpandProperty IPAddress -Unique
) + '127.0.0.1'
Write-Host ("    trying " + ($candidates -join ', ')) -ForegroundColor DarkGray

$waitMinutes = 15
$deadline = (Get-Date).AddMinutes($waitMinutes)
$ready = $false
$readyHost = $null
$nextTick = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not $ready) {
    foreach ($addr in $candidates) {
        try {
            $r = Invoke-WebRequest -Uri "http://${addr}:$ConsolePort/health" -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $ready = $true; $readyHost = $addr; break }
        } catch { }
    }
    if ($ready) { break }
    if ((Get-Date) -gt $nextTick) {
        $left = [int]($deadline - (Get-Date)).TotalMinutes
        Write-Host "    still waiting - ${left} min left" -ForegroundColor DarkGray
        $nextTick = (Get-Date).AddSeconds(60)
    }
    Start-Sleep -Seconds 5
}

Write-Host ''
if ($ready) {
    Write-Host '  Neubit VMS is running.' -ForegroundColor Green
    Write-Host ''
    Write-Host "    http://$readyHost" -ForegroundColor Green
    Write-Host ''
    Write-Host '  That is the address that answered, and the one to give the customer.' -ForegroundColor DarkGray
    if ($readyHost -ne '127.0.0.1') {
        # Not a footnote. Somebody WILL try localhost on this machine, find it
        # refused, and conclude the appliance is down.
        Write-Host '  http://localhost does NOT work here: mirrored networking shares this' -ForegroundColor DarkGray
        Write-Host '  machine loopback with the distro, and the published port is not on it.' -ForegroundColor DarkGray
    }
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

    Write-AutoLogonInstructions

} else {
    Write-Warn "The console did not answer within $waitMinutes minutes."
    Write-Host ''

    # Ask the stack rather than guessing, because the two cases need opposite
    # actions and the operator cannot tell them apart from silence.
    $running = @(& wsl.exe -d $DistroName -u root -- docker ps --format '{{.Names}}' 2>$null |
                 ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    if ($running.Count -gt 0) {
        Write-Host "  The stack IS running - $($running.Count) containers up." -ForegroundColor Green
        Write-Host ''
        Write-Host '  EVERYTHING THIS INSTALLER DOES IS DONE. Do not re-run it. The console is'
        Write-Host '  most likely still finishing its first boot; try these in a browser:'
        Write-Host ''
        foreach ($addr in $candidates) { Write-Host "    http://$addr" }
        Write-Host ''
        Write-Host '  If it is still refused in a few minutes:' -ForegroundColor DarkGray
    } else {
        Write-Host '  No containers are running. The stack did not start.' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  Look at what happened with:' -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host "    wsl -d $DistroName -u root -- tail -50 /var/log/neubit-boot.log" -ForegroundColor DarkGray
    Write-Host "    wsl -d $DistroName -u root -- /opt/neubit/boot.sh status" -ForegroundColor DarkGray
    Write-Host ''

    if ($running.Count -gt 0) { Write-AutoLogonInstructions }

    # exit 1 ONLY when something is actually wrong. A running stack whose console
    # is slow is not a failed install, and saying so cost a site visit's worth of
    # confidence the first time.
    if ($running.Count -eq 0) { exit 1 }
}
Write-Host ''
