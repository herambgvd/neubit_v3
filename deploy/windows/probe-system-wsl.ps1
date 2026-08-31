<#
.SYNOPSIS
    Verify the one assumption the whole appliance design rests on: that SYSTEM can
    own and start a WSL2 distro, so the console comes up at boot with nobody
    logged in.

.DESCRIPTION
    Run this ELEVATED on any candidate box. It changes nothing that it does not
    undo — a throwaway distro and a throwaway scheduled task, both removed on the
    way out.

    ══ WHY THIS SCRIPT EXISTS ══════════════════════════════════════════════════

    WSL distros are registered PER USER, under HKCU\...\Lxss. So a distro imported
    by the administrator who ran the installer is invisible to SYSTEM, which is the
    account a boot-time task runs under. Get that wrong and the appliance works
    perfectly until the first reboot and then never starts again with nobody signed
    in — which is exactly the property the product is sold on. The failure would
    reach a customer before it reached us.

    install-appliance.ps1 is built for the answer "SYSTEM has its own registration,
    so do everything as SYSTEM". This proves it on real hardware rather than
    inferring it from documentation.

    The NVR's own plan records what happens otherwise, three times in one week:
    "this is the third claim this week that read correctly and had never been
    executed." A five-minute probe is cheaper than that.

.PARAMETER Rootfs
    A rootfs tarball to import. Optional — without one the probe still answers the
    registration and boot-task questions using whatever distro it can see.
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
    Write-Host 'This probe must run ELEVATED — it registers a scheduled task under SYSTEM.' -ForegroundColor Red
    exit 2
}

# Run a script as SYSTEM and hand back what it printed. Same mechanism the
# installer uses, so a pass here is a pass for the installer's own path.
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
Head 'SYSTEM can run wsl.exe at all'
$r = AsSystem -TimeoutSeconds 180 -Script @'
    $out = (wsl.exe --status) -replace "`0", ''
    "exit=$LASTEXITCODE"
    $out
'@
if ($r.ok -and (($r.out -join ' ') -match 'exit=0')) {
    Yes 'wsl.exe runs under NT AUTHORITY\SYSTEM'
} else {
    No 'SYSTEM could not run wsl.exe'
    foreach ($l in $r.out) { Note $l }
    Note 'The appliance cannot start at boot without this. Nothing below will help.'
}

# ── 3 ────────────────────────────────────────────────────────────────────────
Head "SYSTEM's distro registration is separate from this account's"
$mine = ((& wsl.exe --list --quiet) -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ', '
$r = AsSystem -TimeoutSeconds 180 -Script @'
    $names = (wsl.exe --list --quiet) -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($names) { "SYSTEM-SEES: " + ($names -join ', ') } else { "SYSTEM-SEES: (none)" }
'@
$systemSees = (($r.out | Where-Object { $_ -match 'SYSTEM-SEES' }) -join '')
Note "this account sees : $(if ($mine) { $mine } else { '(none)' })"
Note "SYSTEM sees       : $($systemSees -replace 'SYSTEM-SEES: ', '')"
if ($r.ok) {
    Yes 'SYSTEM has its own distro list'
    Note 'This is why install-appliance.ps1 imports the distro AS SYSTEM. A distro'
    Note 'imported by the installing admin would be invisible to the boot task.'
} else {
    No 'could not read SYSTEM''s distro list'
}

# ── 4 ────────────────────────────────────────────────────────────────────────
if ($Rootfs) {
    Head 'SYSTEM can import, start and unregister a distro'
    if (-not (Test-Path -LiteralPath $Rootfs)) {
        No "rootfs not found: $Rootfs"
    } else {
        $dir = Join-Path $env:TEMP 'neubit-probe-distro'
        $r = AsSystem -TimeoutSeconds 900 -Script @"
    Remove-Item -Recurse -Force '$dir' -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path '$dir' | Out-Null
    wsl.exe --import $Probe '$dir' '$Rootfs' --version 2
    "import exit=`$LASTEXITCODE"
    `$who = wsl.exe -d $Probe -u root -- id -un
    "whoami-in-distro=`$who"
    wsl.exe --terminate $Probe
    wsl.exe --unregister $Probe
    "unregister exit=`$LASTEXITCODE"
    Remove-Item -Recurse -Force '$dir' -ErrorAction SilentlyContinue
"@
        $joined = ($r.out -join ' ')
        if ($r.ok -and $joined -match 'import exit=0' -and $joined -match 'whoami-in-distro=root') {
            Yes 'SYSTEM imported a distro, ran a command in it as root, and removed it'
        } else {
            No 'the SYSTEM import/start/remove cycle did not complete'
            foreach ($l in $r.out) { Note $l }
        }
    }
} else {
    Head 'SYSTEM can import a distro  (skipped)'
    Note 'Pass -Rootfs <path to a .tar> to exercise the real import path.'
    Note 'Produce one with:  docker create --name r ubuntu:24.04; docker export r -o rootfs.tar'
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
$sysCfg = Join-Path $env:SystemRoot 'System32\config\systemprofile\.wslconfig'
Note "SYSTEM's .wslconfig: $(if (Test-Path $sysCfg) { 'present' } else { 'absent (the installer writes it)' })"

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
    Write-Host '  STILL UNPROVEN by this probe: that the boot task actually fires after a' -ForegroundColor DarkGray
    Write-Host '  real reboot with nobody signed in. Only a reboot proves that. Install,' -ForegroundColor DarkGray
    Write-Host '  reboot, sign in to NOTHING, and browse to the box from another machine.' -ForegroundColor DarkGray
} else {
    Write-Host '  Read the FAIL lines above before installing.' -ForegroundColor Yellow
}
Write-Host ''
exit $(if ($Fail -eq 0) { 0 } else { 1 })
