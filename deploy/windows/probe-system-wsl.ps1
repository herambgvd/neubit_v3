<#
.SYNOPSIS
    Verify that this box can run the appliance: that THIS account can own and start
    a WSL2 distro, and that the machine can be made to come back on its own after a
    power cut.

.DESCRIPTION
    Run this ELEVATED on any candidate box. It changes nothing that it does not
    undo — a throwaway distro and a throwaway scheduled task, both removed on the
    way out.

    ══ WHY THIS SCRIPT EXISTS, AND WHY IT NOW ASKS A DIFFERENT QUESTION ═════════

    It used to prove that SYSTEM could own a distro, because the appliance started
    from a boot task and WSL registers distros PER USER under HKCU\...\Lxss. That
    question is settled and the answer is no:

        Running WSL as local system is not supported.
        Error code: Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED

    Nor does the usual fallback survive contact — the Store build of WSL cannot be
    reached from session 0 at all, so a task under a normal account with "run
    whether user is logged on or not" fails for a second, independent reason
    (microsoft/WSL#9271, #11280).

    So the installer imports the distro as the account running it and triggers AT
    LOGON, and unattended restart is bought with auto-logon rather than with a boot
    task. This probe asks about that shape: can this account do the import, and can
    this machine be set to log itself in.

    The failure this exists to prevent has not changed. It would reach a customer
    as an appliance that installs perfectly, serves the console all day, and is
    dead after the first power cut with nobody on site to notice why.

.PARAMETER Rootfs
    A rootfs tarball to import. The payload ships one — pass `-Rootfs .\rootfs.tar`.
    Without it the probe cannot exercise the path the installer actually takes, and
    says so rather than passing.
#>
[CmdletBinding()]
param(
    [string] $Rootfs = ''
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$Probe = 'neubit-probe'
$Pass = 0; $Fail = 0

function Head { param([string]$m) Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Yes  { param([string]$m) $script:Pass++; Write-Host "  PASS  $m" -ForegroundColor Green }
function No   { param([string]$m) $script:Fail++; Write-Host "  FAIL  $m" -ForegroundColor Red }
function Note { param([string]$m) Write-Host "        $m" -ForegroundColor DarkGray }

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'This probe must run ELEVATED — it reads firewall and logon policy and registers a scheduled task.' -ForegroundColor Red
    exit 2
}

# Run a script as SYSTEM and hand back what it printed. The installer no longer
# uses this; it is kept because check 3 reports what SYSTEM can and cannot do on
# this particular box, and that is the whole explanation for the design.
function AsSystem {
    param([Parameter(Mandatory)][string] $Script, [int] $TimeoutSeconds = 600)

    $stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $dir   = Join-Path $env:TEMP 'neubit-probe'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $sp = Join-Path $dir "$stamp.ps1"; $lp = Join-Path $dir "$stamp.log"; $dp = Join-Path $dir "$stamp.done"

    @"
`$ErrorActionPreference = 'Continue'
try { & { $Script } *>&1 | Tee-Object -FilePath '$lp'; `$c = 0 }
catch { `$_ | Out-String | Add-Content -LiteralPath '$lp'; `$c = 1 }
Set-Content -LiteralPath '$dp' -Value `$c
"@ | Set-Content -LiteralPath $sp -Encoding utf8

    $t = "NeubitProbe-$stamp"
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$sp`""
    $p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    try {
        Register-ScheduledTask -TaskName $t -Action $a -Principal $p -Force | Out-Null
        Start-ScheduledTask -TaskName $t
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while (-not (Test-Path -LiteralPath $dp)) {
            if ((Get-Date) -gt $deadline) { return @{ ok = $false; out = @('TIMED OUT') } }
            Start-Sleep -Milliseconds 500
        }
        return @{
            ok  = ((Get-Content -LiteralPath $dp -Raw).Trim() -eq '0')
            out = @(Get-Content -LiteralPath $lp -ErrorAction SilentlyContinue)
        }
    }
    finally {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $sp, $lp, $dp -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host 'Neubit VMS — appliance feasibility probe' -ForegroundColor Green
Write-Host "  $([Environment]::OSVersion.VersionString)  ·  $env:COMPUTERNAME"

# ── 1 ────────────────────────────────────────────────────────────────────────
Head 'WSL 2 is installed and usable'
$v = (& wsl.exe --version 2>&1) -replace "`0", ''
if ($LASTEXITCODE -eq 0) {
    Yes (($v -split "`r?`n" | Where-Object { $_ -match 'WSL version' }) -join '')
    Note (($v -split "`r?`n" | Where-Object { $_ -match 'Kernel version' }) -join '')
} else {
    No 'wsl --version failed'
    Note 'Install with: wsl --install --no-distribution   (then reboot)'
    Note 'Without WSL 2 this box cannot run the appliance as designed.'
}

# ── 2 ────────────────────────────────────────────────────────────────────────
#
# THE GATE. This is the exact sequence install-appliance.ps1 performs, run as the
# same account, in the same session. Nothing below matters if this fails.
Head 'This account can import, start and unregister a distro'
if (-not $Rootfs) {
    No 'no -Rootfs given, so the path the installer takes was never exercised'
    Note 'The payload ships one:  .\probe-system-wsl.ps1 -Rootfs .\rootfs.tar'
} elseif (-not (Test-Path -LiteralPath $Rootfs)) {
    No "rootfs not found: $Rootfs"
} else {
    $dir = Join-Path $env:TEMP 'neubit-probe-distro'
    Remove-Item -Recurse -Force -LiteralPath $dir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    & wsl.exe --import $Probe $dir $Rootfs --version 2 2>&1 |
        ForEach-Object { $t = ($_ -replace "`0", '').Trim(); if ($t) { Note $t } }
    $importOk = ($LASTEXITCODE -eq 0)

    $who = ''
    if ($importOk) {
        $who = ((& wsl.exe -d $Probe -u root -- id -un) -replace "`0", '') -join ''
        $who = $who.Trim()
    }

    & wsl.exe --terminate $Probe 2>&1 | Out-Null
    & wsl.exe --unregister $Probe 2>&1 | Out-Null
    Remove-Item -Recurse -Force -LiteralPath $dir -ErrorAction SilentlyContinue

    if ($importOk -and $who -eq 'root') {
        Yes "imported a distro as $($identity.Name), ran a command in it as root, removed it"
    } else {
        No 'the import / start / remove cycle did not complete'
        Note "import succeeded = $importOk    id in distro = '$who'"
        Note 'This is the path install-appliance.ps1 takes. Do not install on this box.'
    }
}

# ── 3 ────────────────────────────────────────────────────────────────────────
#
# Informational, and it is the reason the design looks the way it does. Reported
# rather than graded: whichever way it lands, the appliance still installs as a
# logon task.
Head 'Why this installs as a logon task, not a boot task'
$r = AsSystem -TimeoutSeconds 180 -Script @'
    $out = (wsl.exe --status) -replace "`0", ''
    "exit=$LASTEXITCODE"
    $out
'@
foreach ($l in $r.out) { $t = "$l".Trim(); if ($t) { Note $t } }
if ($r.ok -and (($r.out -join ' ') -match 'exit=0')) {
    Note 'SYSTEM can run wsl.exe on this box TODAY. The appliance still installs as a'
    Note 'logon task deliberately — the Store updates WSL in the background and current'
    Note 'builds refuse LocalSystem, so a boot task would die at some later reboot'
    Note 'rather than here, where somebody is watching.'
} else {
    Note 'SYSTEM cannot run wsl.exe here. Expected on current WSL, and exactly why the'
    Note 'appliance starts from a logon task instead.'
}

# ── 4 ────────────────────────────────────────────────────────────────────────
#
# A logon task only survives a power cut if the machine logs itself in. On a
# domain-joined box that is a policy question, not a local one, and finding out
# afterwards means telling a customer their server does not restart.
Head 'The machine can be made to sign itself in'
$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
if ($cs -and $cs.PartOfDomain) {
    No "domain-joined ($($cs.Domain)) - auto-logon may be blocked by Group Policy"
    Note 'Confirm with the customer IT before promising unattended restart. Without'
    Note 'auto-logon the console comes back only when somebody signs in.'
} else {
    Yes 'workgroup machine - auto-logon can be configured locally'
    Note 'After installing: run netplwiz, clear "Users must enter a user name and'
    Note 'password", choose the account that installed the appliance, then REBOOT to'
    Note 'prove the console comes back on its own.'
}

# ── 5 ────────────────────────────────────────────────────────────────────────
Head 'Mirrored networking is available'
$build = [Environment]::OSVersion.Version.Build
if ($build -ge 22000) {
    Yes "Windows build $build supports networkingMode=mirrored"
} else {
    No "Windows build $build predates mirrored networking (needs 22000+ / Windows 11 or Server 2022)"
    Note 'Without it the desktop app still works on this machine, but the web console'
    Note 'is unreachable from the LAN without a portproxy refreshed at every boot.'
}
$myCfg = Join-Path $env:USERPROFILE '.wslconfig'
Note "this account's .wslconfig: $(if (Test-Path -LiteralPath $myCfg) { 'present' } else { 'absent (the installer writes it)' })"

# ── 6 ────────────────────────────────────────────────────────────────────────
Head 'The Hyper-V firewall can be opened for WSL'
try {
    $s = Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore -ErrorAction Stop | Select-Object -First 1
    Note "default inbound action: $($s.DefaultInboundAction)"
    if ($s.DefaultInboundAction -eq 'Block') {
        Note 'Blocked by default — this is normal, and is why the installer adds a rule.'
    }
    if (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
        Yes 'New-NetFirewallHyperVRule is available'
    } else {
        No 'New-NetFirewallHyperVRule is missing on this Windows build'
        Note 'The console would be reachable on this machine and refused from the LAN.'
    }
} catch {
    No "could not read the Hyper-V firewall settings: $($_.Exception.Message)"
}

# ── 7 ────────────────────────────────────────────────────────────────────────
Head 'Disks'
try {
    Get-PhysicalDisk | ForEach-Object {
        Note ("{0}  {1}  {2:N0} GB" -f $_.MediaType.PadRight(12), $_.FriendlyName, ($_.Size / 1GB))
    }
    Note ''
    Note 'The distro (database + container layers) wants an SSD; recordings and the'
    Note 'basemap want the big spinning disk. install-appliance.ps1 takes both paths.'
} catch { Note "could not enumerate disks: $($_.Exception.Message)" }

Write-Host ''
Write-Host ('  {0} passed, {1} failed' -f $Pass, $Fail) -ForegroundColor $(if ($Fail -eq 0) { 'Green' } else { 'Yellow' })
Write-Host ''
if ($Fail -eq 0) {
    Write-Host '  This box can run the appliance as designed.' -ForegroundColor Green
    Write-Host ''
    Write-Host '  STILL UNPROVEN by this probe: that the machine signs itself in and the' -ForegroundColor DarkGray
    Write-Host '  logon task starts the stack. Only a reboot proves that. Install, set' -ForegroundColor DarkGray
    Write-Host '  auto-logon with netplwiz, reboot, touch NOTHING, and browse to this box' -ForegroundColor DarkGray
    Write-Host '  from another machine.' -ForegroundColor DarkGray
} else {
    Write-Host '  Read the FAIL lines above before installing.
  Only a reboot proves the last mile: install, reboot, touch nothing, and browse
  to this box from another machine.' -ForegroundColor Yellow
}
Write-Host ''
exit $(if ($Fail -eq 0) { 0 } else { 1 })
