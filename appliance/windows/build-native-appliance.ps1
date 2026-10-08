<#
.SYNOPSIS
    Stages the Neubit VMS native appliance payload (docs/WINDOWS_NATIVE_APPLIANCE.md section 3)
    into one directory the desktop installer ships as resources\server.

.DESCRIPTION
    The payload:

      neubitvms-svc.exe       the supervisor / Windows Service (Go)
      python\                 a relocatable CPython 3.11 (python-build-standalone) with
                              every service's third-party dependencies, from a
                              hash-pinned Windows lock generated from the services'
                              own pyproject.toml, plus kernel and reporting
      services\<name>\        each Python service's source (they are all `app`,
                              so each runs from its own directory)
      web\frontend, web\admin the two Next.js standalone builds
      config\                 the repo's own gateway/, nats.conf and the service
                              database list, rendered at service start
      scripts\                install / uninstall / fetch-binaries
      binaries.json           the pinned third-party runtimes
      bin\                    -Offline only: those runtimes, pre-fetched

    Every download (uv, CPython, and with -Offline the runtimes) is verified by
    SHA-256 before it is used. Run it from the repo root. Build it from the Bash
    tool / a plain terminal: Next's build workers run out of memory under some
    hosted PowerShell sessions.

.PARAMETER Version
    Stamped into neubitvms-svc.exe and payload.json. Default: desktop/package.json.

.PARAMETER OutDir
    Where the payload is staged. Default: dist\vms-server. Emptied first.

.PARAMETER CacheDir
    Download cache, re-used between builds.

.PARAMETER Offline
    Also fetch the runtimes into the payload's bin\ (the air-gapped installer).

.PARAMETER SkipWeb
    Re-use the existing .next\standalone builds instead of running next build.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File appliance\windows\build-native-appliance.ps1
#>
[CmdletBinding()]
param(
    [string] $Version  = '',
    [string] $OutDir   = '',
    [string] $CacheDir = (Join-Path $env:TEMP 'neubit-vms-build-cache'),
    [switch] $Offline,
    [switch] $SkipWeb
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step  { param([string]$m) Write-Host "==> $m" }
function Write-Detail { param([string]$m) Write-Host "    $m" }

# Native commands do not throw on failure in Windows PowerShell; this does.
function Invoke-Native {
    param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @(), [string]$Cwd = '')
    $prev = Get-Location
    if ($Cwd) { Set-Location -LiteralPath $Cwd }
    try {
        & $Exe @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') exited $LASTEXITCODE" }
    } finally {
        Set-Location -LiteralPath $prev
    }
}

function Get-Verified {
    param([Parameter(Mandatory)][object]$Tool, [Parameter(Mandatory)][string]$Cache)
    $leaf = (($Tool.url -split '/')[-1]) -replace '[^A-Za-z0-9\.\-_]', '_'
    $path = Join-Path $Cache "$($Tool.sha256.Substring(0,16))-$leaf"
    if (Test-Path -LiteralPath $path) {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Tool.sha256) { return $path }
        Remove-Item -LiteralPath $path -Force
    }
    Write-Detail "downloading $($Tool.url)"
    Invoke-WebRequest -Uri $Tool.url -OutFile "$path.part" -UseBasicParsing
    $have = (Get-FileHash -LiteralPath "$path.part" -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($have -ne $Tool.sha256) {
        Remove-Item -LiteralPath "$path.part" -Force
        throw "SHA-256 mismatch for $($Tool.name): expected $($Tool.sha256), got $have - refusing to use it"
    }
    Move-Item -LiteralPath "$path.part" -Destination $path -Force
    return $path
}

# robocopy's exit codes 0-7 are success; 8+ is failure.
function Copy-Tree {
    param([string]$From, [string]$To, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @())
    $args = @($From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
    if ($ExcludeDirs.Count)  { $args += '/XD'; $args += $ExcludeDirs }
    if ($ExcludeFiles.Count) { $args += '/XF'; $args += $ExcludeFiles }
    & robocopy.exe @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed ($LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}

try {
    $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    if (-not $OutDir) { $OutDir = Join-Path $Repo 'dist\vms-server' }
    if (-not $Version) {
        $Version = (Get-Content -LiteralPath (Join-Path $Repo 'desktop\package.json') -Raw | ConvertFrom-Json).version
    }
    $Build = Join-Path $Repo 'dist\vms-build'
    foreach ($d in @($CacheDir, $Build)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

    Write-Step "Neubit VMS native payload $Version -> $OutDir"
    if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

    $tools = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'build-tools.json') -Raw | ConvertFrom-Json).tools
    $uvTool = $tools | Where-Object name -eq 'uv'
    $pyTool = $tools | Where-Object name -eq 'cpython'

    # -- 1. the supervisor ----------------------------------------------------
    Write-Step 'neubitvms-svc.exe'
    $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
    Invoke-Native go @('build', '-trimpath', '-ldflags', "-s -w -X main.version=$Version",
        '-o', (Join-Path $OutDir 'neubitvms-svc.exe'), './cmd/neubitvms-svc') (Join-Path $Repo 'appliance')
    $stamped = & (Join-Path $OutDir 'neubitvms-svc.exe') version
    if ($stamped -ne $Version) { throw "version stamp did not apply: binary says '$stamped'" }

    # -- 2. uv and CPython ----------------------------------------------------
    Write-Step "uv $($uvTool.version)"
    $uvZip = Get-Verified -Tool $uvTool -Cache $CacheDir
    $uvDir = Join-Path $Build 'uv'
    if (Test-Path $uvDir) { Remove-Item $uvDir -Recurse -Force }
    Expand-Archive -LiteralPath $uvZip -DestinationPath $uvDir -Force
    $uv = (Get-ChildItem -LiteralPath $uvDir -Recurse -Filter 'uv.exe' | Select-Object -First 1).FullName

    Write-Step "CPython $($pyTool.version)"
    $pyTar = Get-Verified -Tool $pyTool -Cache $CacheDir
    $pyTmp = Join-Path $Build 'cpython'
    if (Test-Path $pyTmp) { Remove-Item $pyTmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $pyTmp | Out-Null
    Invoke-Native (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xzf', $pyTar, '-C', $pyTmp)
    Move-Item -LiteralPath (Join-Path $pyTmp 'python') -Destination (Join-Path $OutDir 'python')
    $python = Join-Path $OutDir 'python\python.exe'

    # -- 3. dependencies: one Windows lock from every pyproject ---------------
    Write-Step 'Python dependencies'
    $reqIn = Join-Path $Build 'requirements.in'
    $lock = Join-Path $Build 'requirements.lock'
    Invoke-Native $python @((Join-Path $Repo 'appliance\build\requirements.py'), $Repo, $reqIn)
    $env:UV_CACHE_DIR = Join-Path $CacheDir 'uv'
    $env:UV_PYTHON_DOWNLOADS = 'never'
    Invoke-Native $uv @('pip', 'compile', $reqIn, '--python', $python, '--python-platform', 'x86_64-pc-windows-msvc',
        '--generate-hashes', '--no-header', '--quiet', '-o', $lock)
    Invoke-Native $uv @('pip', 'install', '--python', $python, '--system', '--break-system-packages',
        '--require-hashes', '--no-deps', '--quiet', '-r', $lock)
    # The repo's own packages, from source, after the lock: --no-deps so nothing
    # outside the lock is ever resolved.
    Invoke-Native $uv @('pip', 'install', '--python', $python, '--system', '--break-system-packages',
        '--no-deps', '--no-sources', '--quiet', (Join-Path $Repo 'backend\kernel'), (Join-Path $Repo 'backend\reporting'))
    # No quotes inside the -c argument: Windows PowerShell 5.1 mangles embedded
    # double quotes when it builds a native command line.
    Invoke-Native $python @('-c', 'import fastapi, uvicorn, asyncpg, alembic, kernel, reporting')
    Copy-Item -LiteralPath $lock -Destination (Join-Path $OutDir 'requirements.lock')

    # -- 4. service sources ---------------------------------------------------
    Write-Step 'services'
    $xd = @('tests', '__pycache__', '.pytest_cache', 'coverage', '.venv', 'node_modules', '*.egg-info')
    $xf = @('.env', '.env.*', 'Dockerfile*', 'run-tests.sh', '*.pyc', '.coverage', 'coverage.xml')
    foreach ($svc in @('core', 'ingest', 'workflow', 'access', 'vision', 'reading-writer', 'reporting')) {
        Copy-Tree -From (Join-Path $Repo "backend\$svc") -To (Join-Path $OutDir "services\$svc") -ExcludeDirs $xd -ExcludeFiles $xf
        if (Get-ChildItem -LiteralPath (Join-Path $OutDir "services\$svc") -Recurse -Force -Filter '.env' -ErrorAction SilentlyContinue) {
            throw "a .env file reached services\$svc - pydantic-settings would read it"
        }
    }

    # -- 5. web ---------------------------------------------------------------
    $env:NEXT_TELEMETRY_DISABLED = '1'
    foreach ($w in @(@{ Src = 'frontend'; Dst = 'frontend' }, @{ Src = 'admin-frontend'; Dst = 'admin' })) {
        $src = Join-Path $Repo $w.Src
        if (-not $SkipWeb) {
            # From the lockfile, every build: a stale or partial node_modules (the
            # dev stack keeps its own inside the container) builds a different app,
            # and Windows needs the win32 native packages (swc, lightningcss, oxide).
            Write-Step "npm ci: $($w.Src)"
            Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund', '--loglevel=error') $src
            Write-Step "next build: $($w.Src)"
            Invoke-Native 'npm.cmd' @('run', 'build') $src
        }
        $standalone = Join-Path $src '.next\standalone'
        if (-not (Test-Path (Join-Path $standalone 'server.js'))) { throw "$($w.Src): no standalone build at $standalone" }
        $dst = Join-Path $OutDir "web\$($w.Dst)"
        Copy-Tree -From $standalone -To $dst -ExcludeFiles @('.env', '.env.*')
        Copy-Tree -From (Join-Path $src '.next\static') -To (Join-Path $dst '.next\static')
        if (Test-Path (Join-Path $src 'public')) { Copy-Tree -From (Join-Path $src 'public') -To (Join-Path $dst 'public') }
    }

    # -- 6. config templates (the repo's own files) ---------------------------
    Write-Step 'config templates'
    $cfg = Join-Path $OutDir 'config'
    Copy-Tree -From (Join-Path $Repo 'gateway') -To (Join-Path $cfg 'gateway') -ExcludeFiles @('*.md')
    New-Item -ItemType Directory -Force -Path (Join-Path $cfg 'nats'), (Join-Path $cfg 'postgres') | Out-Null
    Copy-Item (Join-Path $Repo 'deploy\nats\nats.conf') (Join-Path $cfg 'nats\nats.conf')
    Copy-Item (Join-Path $Repo 'deploy\postgres\init-service-dbs.sh') (Join-Path $cfg 'postgres\init-service-dbs.sh')

    # -- 7. scripts and the runtime manifest ----------------------------------
    Write-Step 'scripts'
    $scripts = Join-Path $OutDir 'scripts'
    New-Item -ItemType Directory -Force -Path $scripts | Out-Null
    foreach ($s in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | Where-Object Name -ne 'build-native-appliance.ps1') {
        Copy-Item -LiteralPath $s.FullName -Destination $scripts
    }
    Copy-Item (Join-Path $PSScriptRoot 'binaries.json') (Join-Path $OutDir 'binaries.json')

    if ($Offline) {
        Write-Step 'runtimes (offline payload)'
        Invoke-Native 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'fetch-binaries.ps1'),
            '-BinDir', (Join-Path $OutDir 'bin'), '-CacheDir', $CacheDir)
    }

    $commit = (& git -C $Repo rev-parse --short HEAD) 2>$null
    $dirty = [bool](& git -C $Repo status --porcelain 2>$null)
    $info = [pscustomobject]@{ version = $Version; commit = $commit; dirty = $dirty; offline = [bool]$Offline
                               built = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    [IO.File]::WriteAllText((Join-Path $OutDir 'payload.json'), ($info | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

    $size = (Get-ChildItem -LiteralPath $OutDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
    Write-Step ("done: {0:N0} MB in {1}" -f $size, $OutDir)
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'BUILD FAILED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
    exit 1
}
