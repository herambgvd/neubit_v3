<#
.SYNOPSIS
    Installs (or upgrades in place) the Neubit VMS server as the Windows Service
    "NeubitVMS". Idempotent: running it again over an existing install is the
    upgrade path, and it never touches the database, files or secrets.

.DESCRIPTION
    Run elevated, by the desktop installer (NSIS) or by hand. In order:

      1. stop the service if it is running (an upgrade replaces its binaries);
      2. provision the data root: directories, config.json, secrets (generated
         once, never rotated), the first administrator;
      3. refuse a port another program already listens on, naming it;
      4. install the pinned runtimes into <data root>\bin: copied from an
         offline payload, or downloaded and SHA-256-verified;
      5. the Visual C++ runtime PostgreSQL needs (Authenticode-checked);
      6. seal the program directory, register the service, seal the data root;
      7. one inbound firewall rule: the console port, nothing else;
      8. start the service and wait until the console answers.

    Modelled on the Neubit NVR's install-appliance.ps1.

.PARAMETER ServerDir
    The payload directory (resources\server). Default: this script's parent.
.PARAMETER Root
    Data root override. Default: the registry's DataRoot, else
    %ProgramData%\Neubit\VMS, else <drive>:\NeubitVMS when installed off C:.
.PARAMETER Ports
    Port overrides, e.g. "ui=8090".
.PARAMETER RuntimeEnv
    dev (default) or prod. prod needs -LicenseToken: core refuses prod unlicensed.
.PARAMETER AdminEmail / AdminPassword
    Unattended installs only. Normally the operator creates the first
    administrator in the console's first-run setup, on this computer, and no
    password is written anywhere. With -AdminEmail the server creates it instead;
    the password is generated when omitted and written to
    <data root>\config\admin-credentials.txt (administrators only).
.PARAMETER NvrUrl
    A Neubit NVR on this machine (default http://127.0.0.1:8000 is assumed).
.PARAMETER SkipFetch
    Do not download runtimes (they must already be in <data root>\bin).
#>
[CmdletBinding()]
param(
    [string] $ServerDir = '',
    [string] $Root = '',
    [string] $Ports = '',
    [ValidateSet('', 'dev', 'prod')][string] $RuntimeEnv = '',
    [string] $LicenseToken = '',
    [string] $AdminEmail = '',
    [string] $AdminPassword = '',
    [string] $NvrUrl = '',
    [int]    $ReadyTimeoutSec = 900,
    [switch] $SkipFetch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ServiceName = 'NeubitVMS'
$RuleName = 'Neubit VMS - web console'
$LogDir = Join-Path $env:ProgramData 'Neubit'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$InstallLog = Join-Path $LogDir 'vms-install.log'
Start-Transcript -LiteralPath $InstallLog -Append | Out-Null

function Write-Step { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn { param([string]$m) Write-Host "  ! $m" -ForegroundColor Yellow }
function Write-Ok   { param([string]$m) Write-Host "  . $m" -ForegroundColor DarkGray }

# The NSIS installer is 32-bit, so this may be 32-bit PowerShell, which is given
# SysWOW64 for System32. Sysnative reaches the real one.
function Get-System32 {
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        return (Join-Path $env:SystemRoot 'Sysnative')
    }
    return (Join-Path $env:SystemRoot 'System32')
}

function Invoke-Svc {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$Capture)
    if ($Capture) {
        # PS 5.1 wraps each stderr line of a native command in an ErrorRecord,
        # and under 'Stop' the FIRST one is terminating: a warning on stderr
        # would abort the install. The exit code is the verdict, not stderr.
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $out = @(& $script:Svc @Arguments 2>&1 | ForEach-Object { "$_" })
        } finally {
            $ErrorActionPreference = $prev
        }
        if ($LASTEXITCODE -ne 0) { throw "neubitvms-svc $($Arguments -join ' ') failed: $($out -join "`n")" }
        return $out
    }
    & $script:Svc @Arguments
    if ($LASTEXITCODE -ne 0) { throw "neubitvms-svc $($Arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

function Assert-Administrator {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer as Administrator: it registers a Windows Service, seals the data directory and adds a firewall rule.'
    }
}

function Get-Ports {
    $map = @{}
    $args = @('ports')
    if ($Root) { $args += @('-root', $Root) }
    foreach ($line in (Invoke-Svc -Arguments $args -Capture)) {
        $k, $v = "$line".Split('=', 2)
        if ($v) { $map[$k.Trim()] = [int]$v }
    }
    return $map
}

function Get-PortOwners {
    param([int[]]$PortList)
    $found = @()
    foreach ($port in $PortList) {
        $l = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
        if ($l) {
            $names = foreach ($procId in @($l | Select-Object -ExpandProperty OwningProcess -Unique)) {
                $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($p) { "$($p.ProcessName) (PID $procId)" } else { "PID $procId" }
            }
            $found += "port $port is used by $($names -join ', ')"
        }
    }
    return $found
}

function Install-VcRuntime {
    param([string]$BinDir)
    $sys = Get-System32
    $have = (Test-Path (Join-Path $sys 'vcruntime140.dll')) -and (Test-Path (Join-Path $sys 'msvcp140.dll'))
    $redist = Join-Path $BinDir 'vc_redist.x64.exe'
    if (-not (Test-Path -LiteralPath $redist)) {
        if ($have) { Write-Ok 'Visual C++ runtime already installed'; return }
        throw 'The Visual C++ 2015-2022 x64 runtime is missing and bin\ has no vc_redist.x64.exe to install it from.'
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $redist
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "$redist is not validly signed by Microsoft ($($sig.Status)); refusing to run it."
    }
    $p = Start-Process -FilePath $redist -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru -WindowStyle Hidden
    switch ($p.ExitCode) {
        0    { Write-Ok 'installed the Visual C++ runtime' }
        1638 { Write-Ok 'Visual C++ runtime already installed (same or newer)' }
        3010 { Write-Warn 'installed the Visual C++ runtime; Windows asks for a restart when convenient' }
        default { throw "the Visual C++ runtime installer failed with exit code $($p.ExitCode)" }
    }
}

try {
    if (-not $ServerDir) { $ServerDir = Split-Path -Parent $PSScriptRoot }
    $script:Svc = Join-Path $ServerDir 'neubitvms-svc.exe'
    if (-not (Test-Path -LiteralPath $script:Svc)) { throw "neubitvms-svc.exe not found in $ServerDir" }
    $version = & $script:Svc version
    Write-Step "Neubit VMS server $version"

    Assert-Administrator

    Write-Step 'Stopping the service if it is running'
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        Invoke-Svc -Arguments @('stop')
        Write-Ok 'stopped'
    } else {
        Write-Ok 'not installed yet'
    }

    Write-Step 'Preparing the data root'
    $prov = @('provision', '-install-dir', $ServerDir)
    if ($Root)          { $prov += @('-root', $Root) }
    if ($Ports)         { $prov += @('-ports', $Ports) }
    if ($RuntimeEnv)    { $prov += @('-runtime-env', $RuntimeEnv) }
    if ($LicenseToken)  { $prov += @('-license', $LicenseToken) }
    if ($AdminEmail)    { $prov += @('-admin-email', $AdminEmail) }
    if ($AdminPassword) { $prov += @('-admin-password', $AdminPassword) }
    if ($NvrUrl)        { $prov += @('-nvr-url', $NvrUrl) }
    $provOut = Invoke-Svc -Arguments $prov -Capture
    $provOut | ForEach-Object { Write-Ok $_ }
    $dataRoot = ($provOut | Where-Object { "$_" -like 'data root:*' } | Select-Object -First 1) -replace '^data root:\s*', ''
    if (-not $dataRoot) { throw 'provision did not report the data root' }
    if (-not $Root) { $Root = $dataRoot }

    Write-Step 'Checking ports'
    $portMap = Get-Ports
    # @(): a function returning an empty array returns $null, and under
    # StrictMode $null.Count throws -- the no-conflict case, i.e. every clean
    # install, failed here.
    $conflicts = @(Get-PortOwners -PortList @($portMap.Values))
    if ($conflicts.Count -gt 0) {
        throw ("These ports are already in use, so the VMS cannot start:`n  " + ($conflicts -join "`n  ") +
               "`nFree them, or re-run with -Ports to move the VMS, e.g. -Ports `"ui=8090`".")
    }
    Write-Ok "console on port $($portMap['ui']); everything else on 127.0.0.1"

    Write-Step 'Installing the runtimes'
    $bin = Join-Path $Root 'bin'
    $offlineBin = Join-Path $ServerDir 'bin'
    if (Test-Path -LiteralPath (Join-Path $offlineBin 'vendorbin.lock.json')) {
        & robocopy.exe $offlineBin $bin /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "copying the offline runtimes failed ($LASTEXITCODE)" }
        $global:LASTEXITCODE = 0
        Write-Ok 'copied from the offline payload'
    } elseif (-not $SkipFetch) {
        $fetch = Join-Path $PSScriptRoot 'fetch-binaries.ps1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fetch -BinDir $bin -Manifest (Join-Path $ServerDir 'binaries.json')
        if ($LASTEXITCODE -ne 0) { throw 'fetching the runtimes failed (see above); nothing was started' }
    } else {
        Write-Ok 'skipped (-SkipFetch)'
    }
    Install-VcRuntime -BinDir $bin

    Write-Step 'Securing the program directory'
    # The directory only, NOT /T: /T strips inheritance from every file and the
    # (OI)(CI) grants do not apply to files, leaving each with an empty DACL --
    # the service could not even read its own exe.
    & (Join-Path (Get-System32) 'icacls.exe') $ServerDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warn "could not tighten $ServerDir (icacls exit $LASTEXITCODE)" } else { Write-Ok 'administrators + SYSTEM write; users read' }

    Write-Step "Registering the $ServiceName service"
    $inst = @('install')
    if ($PSBoundParameters.ContainsKey('Root')) { $inst += @('-root', $Root) }
    Invoke-Svc -Arguments $inst

    Write-Step 'Firewall'
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $RuleName -Group 'Neubit VMS' -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $portMap['ui'] -Profile Any -Description 'Neubit VMS web console. Removed by uninstall-appliance.ps1.' | Out-Null
    Write-Ok "allowed inbound TCP/$($portMap['ui'])"

    Write-Step 'Starting the server'
    Invoke-Svc -Arguments @('start')
    Write-Ok 'service running; waiting for the console (first start creates the database)'
    $st = @('status', '-wait-ready', "$($ReadyTimeoutSec)s")
    if ($PSBoundParameters.ContainsKey('Root')) { $st += @('-root', $Root) }
    & $script:Svc @st
    if ($LASTEXITCODE -ne 0) {
        throw ("The service is running but the console did not come up within $ReadyTimeoutSec s. " +
               "Logs: $(Join-Path $Root 'logs'). The service keeps trying on its own.")
    }

    $ui = if ($portMap['ui'] -eq 80) { '' } else { ":$($portMap['ui'])" }
    Write-Step 'Install complete'
    Write-Host "  On this server:  http://localhost$ui"
    Write-Host "  On the network:  http://$($env:COMPUTERNAME)$ui"
    $cred = Join-Path $Root 'config\admin-credentials.txt'
    if (Test-Path -LiteralPath $cred) {
        Write-Host "  First sign-in:   see $cred (administrators only)"
    } else {
        Write-Host '  First sign-in:   open Neubit VMS on this computer and create the administrator'
    }
    Stop-Transcript | Out-Null
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'INSTALL FAILED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "Log: $InstallLog"
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}
