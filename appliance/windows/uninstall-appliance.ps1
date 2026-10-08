<#
.SYNOPSIS
    Removes the Neubit VMS server: the NeubitVMS service and its firewall rule.
    KEEPS the database, files and secrets unless -RemoveData -Confirm is given,
    so uninstall + reinstall (or an upgrade) adopts the existing system.

.PARAMETER RemoveData
    Also delete the data root (database, files, logs, secrets). Irreversible;
    needs -Confirm as well, so it is never one flag away.
#>
[CmdletBinding()]
param(
    [string] $ServerDir = '',
    [string] $Root = '',
    [switch] $RemoveData,
    [switch] $Confirm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  . $m" -ForegroundColor DarkGray }

try {
    if (-not $ServerDir) { $ServerDir = Split-Path -Parent $PSScriptRoot }
    $svc = Join-Path $ServerDir 'neubitvms-svc.exe'

    if (-not $Root) {
        try {
            $k = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey('SOFTWARE\Neubit\VMS')
            if ($k) { $Root = [string]$k.GetValue('DataRoot') }
        } catch { }
        if (-not $Root) { $Root = Join-Path $env:ProgramData 'Neubit\VMS' }
    }

    Write-Step 'Stopping and removing the NeubitVMS service'
    if (Test-Path -LiteralPath $svc) {
        & $svc uninstall
        if ($LASTEXITCODE -ne 0) { throw "neubitvms-svc uninstall failed ($LASTEXITCODE)" }
    } elseif (Get-Service -Name NeubitVMS -ErrorAction SilentlyContinue) {
        Stop-Service -Name NeubitVMS -Force -ErrorAction SilentlyContinue
        & sc.exe delete NeubitVMS | Out-Null
    }
    Write-Ok 'service removed'

    Write-Step 'Firewall'
    Get-NetFirewallRule -Group 'Neubit VMS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Ok 'rule removed'

    if ($RemoveData) {
        if (-not $Confirm) { throw '-RemoveData deletes the database and every file; add -Confirm to really do it.' }
        Write-Step "Deleting the data root $Root"
        Remove-Item -LiteralPath $Root -Recurse -Force
        try {
            $k = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey('SOFTWARE\Neubit', $true)
            if ($k) { $k.DeleteSubKeyTree('VMS', $false) }
        } catch { }
        Write-Ok 'deleted'
    } else {
        Write-Ok "data kept in $Root (a reinstall adopts it)"
    }
    exit 0
}
catch {
    Write-Host 'UNINSTALL FAILED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
