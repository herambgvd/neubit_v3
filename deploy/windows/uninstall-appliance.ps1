<#
.SYNOPSIS
    Remove the Neubit VMS appliance from this Windows box.

.DESCRIPTION
    Undoes exactly what install-appliance.ps1 did: the boot task, the firewall
    rules, and the WSL distro from SYSTEM's profile.

    DATA IS KEPT BY DEFAULT. Recordings and the database are the customer's, and an
    uninstall run to fix something unrelated must not be the thing that loses a
    month of evidence. -RemoveData deletes them, and says exactly what it is about
    to delete before it does.

    Note what "keeping the data" can and cannot mean:

      * the BULK directory — recordings, the offline basemap — is an ordinary
        Windows folder and survives untouched.
      * the DATABASE lives in named volumes inside the distro's virtual disk, so
        unregistering the distro takes it with it. -KeepData therefore leaves the
        distro in place and removes only the boot task and the firewall rules,
        which is what you want before a reinstall.

.PARAMETER KeepData
    Leave the distro registered (and with it the database) and remove only the boot
    task and firewall rules. The reinstall path.

.PARAMETER RemoveData
    Also delete the bulk data directory. Irreversible; prompts unless -Yes.

.PARAMETER BulkDir
    The bulk directory to delete with -RemoveData. Defaults to the installer's.

.PARAMETER Yes
    Do not prompt.
#>
[CmdletBinding()]
param(
    [switch] $KeepData,
    [switch] $RemoveData,
    [string] $BulkDir = '',
    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$DistroName = 'neubit-vms'
$TaskName   = 'Neubit VMS appliance'
$RulePrefix = 'Neubit VMS'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  . $Message" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

function Assert-Administrator {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This must run as Administrator: it removes a SYSTEM scheduled task, a WSL distro and firewall rules.'
    }
}

# Same throwaway-task trick as the installer, and for the same reason: the distro
# is registered in SYSTEM's profile, so it can only be unregistered from there.
function Invoke-AsSystem {
    param([Parameter(Mandatory)][string] $Script, [string] $What = 'command', [int] $TimeoutSeconds = 600)

    $stamp      = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $dir        = Join-Path $env:ProgramData 'Neubit\VMS\install'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $scriptPath = Join-Path $dir "rm-system-$stamp.ps1"
    $logPath    = Join-Path $dir "rm-system-$stamp.log"
    $donePath   = Join-Path $dir "rm-system-$stamp.done"

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

    $taskName  = "NeubitVMSUninstall-$stamp"
    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
                     -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while (-not (Test-Path -LiteralPath $donePath)) {
            if ((Get-Date) -gt $deadline) { throw "$What as SYSTEM timed out" }
            Start-Sleep -Milliseconds 700
        }
        foreach ($line in (Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue)) {
            Write-Host "    $line" -ForegroundColor DarkGray
        }
        if ((Get-Content -LiteralPath $donePath -Raw).Trim() -ne '0') { throw "$What as SYSTEM failed" }
    }
    finally {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $scriptPath, $logPath, $donePath -Force -ErrorAction SilentlyContinue
    }
}

Assert-Administrator
if (-not $BulkDir) { $BulkDir = Join-Path $env:ProgramData 'Neubit\VMS\data' }

Write-Host ''
Write-Host 'Removing the Neubit VMS appliance' -ForegroundColor Green
Write-Host ''

# ── 1. stop it ───────────────────────────────────────────────────────────────
Write-Step 'Stopping the appliance'
try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Ok 'boot task removed'
} catch { Write-Ok 'no boot task registered' }

try {
    Invoke-AsSystem -What 'stop the stack' -TimeoutSeconds 300 -Script @'
    $names = (wsl.exe --list --quiet) -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() }
    if ($names -contains 'neubit-vms') {
        wsl.exe -d neubit-vms -u root -- /opt/neubit/boot.sh stop
        wsl.exe --terminate neubit-vms
        'stopped'
    } else { 'distro not registered' }
'@
} catch { Write-Warn "could not stop the stack cleanly: $($_.Exception.Message)" }

# ── 2. firewall ──────────────────────────────────────────────────────────────
Write-Step 'Removing the firewall rules'
try {
    Get-NetFirewallHyperVRule -Name 'NeubitVMSConsole' -ErrorAction Stop | Remove-NetFirewallHyperVRule -ErrorAction Stop
    Write-Ok 'Hyper-V firewall rule removed'
} catch { Write-Ok 'no Hyper-V firewall rule' }
try {
    Get-NetFirewallRule -Group $RulePrefix -ErrorAction Stop | Remove-NetFirewallRule -ErrorAction Stop
    Write-Ok 'Windows Firewall rules removed'
} catch { Write-Ok 'no Windows Firewall rules' }

# NOT the .wslconfig. Mirrored networking is machine-wide and another distro on
# this box may now depend on it; silently reverting a global network setting on the
# way out is worse than leaving a two-line file behind. Say so instead.
Write-Warn ("SYSTEM's .wslconfig was left in place — mirrored networking is machine-wide and " +
            "removing it could break another WSL distro. Delete " +
            "$env:SystemRoot\System32\config\systemprofile\.wslconfig by hand if nothing else needs it.")

# ── 3. the distro ────────────────────────────────────────────────────────────
if ($KeepData) {
    Write-Step 'Keeping the distro (-KeepData)'
    Write-Ok 'the database and the container images are untouched; reinstall will reuse them'
} else {
    Write-Step 'Unregistering the distro'
    Write-Warn 'This deletes the DATABASE, which lives in volumes inside the distro.'
    if (-not $Yes) {
        $answer = Read-Host '  Type YES to continue'
        if ($answer -ne 'YES') { Write-Host '  Aborted.' -ForegroundColor Yellow; exit 1 }
    }
    try {
        Invoke-AsSystem -What 'unregister the distro' -TimeoutSeconds 900 -Script @'
    $names = (wsl.exe --list --quiet) -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() }
    if ($names -contains 'neubit-vms') {
        wsl.exe --unregister neubit-vms
        'unregistered'
    } else { 'distro not registered' }
'@
        Write-Ok 'distro unregistered'
    } catch { Write-Warn "could not unregister the distro: $($_.Exception.Message)" }
}

# ── 4. bulk data ─────────────────────────────────────────────────────────────
if ($RemoveData) {
    Write-Step 'Deleting the bulk data'
    if (Test-Path -LiteralPath $BulkDir) {
        $size = (Get-ChildItem -Recurse -File -LiteralPath $BulkDir -ErrorAction SilentlyContinue |
                 Measure-Object -Property Length -Sum).Sum
        Write-Warn ("About to delete {0} ({1:N1} GB) — recordings included. This cannot be undone." -f $BulkDir, ($size / 1GB))
        if (-not $Yes) {
            $answer = Read-Host '  Type DELETE to continue'
            if ($answer -ne 'DELETE') { Write-Host '  Bulk data kept.' -ForegroundColor Yellow; exit 0 }
        }
        Remove-Item -Recurse -Force -LiteralPath $BulkDir
        Write-Ok "$BulkDir deleted"
    } else {
        Write-Ok "$BulkDir does not exist"
    }
} else {
    Write-Step 'Keeping the bulk data'
    Write-Ok "$BulkDir (recordings, basemap) left in place — pass -RemoveData to delete it"
}

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host ''
