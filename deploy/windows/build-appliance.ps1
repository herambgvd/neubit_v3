<#
.SYNOPSIS
    Bake the Neubit VMS appliance payload: one WSL2 distro tarball that already
    contains the container engine and every release image.

.DESCRIPTION
    Runs on a BUILD machine, not on a customer's. It produces
    dist\appliance\, which desktop\electron-builder.yml then carries into the
    installer as extraResources.

    ══ WHY THE IMAGES ARE BAKED IN ══════════════════════════════════════════════

    The obvious design ships a rootfs and a tar of images and lets the installer
    apt-install docker and `docker load` on arrival. The P0 spike did exactly that
    and measured what it costs:

      * `docker load` of the payload took 6 m 20 s on a spinning disk, with no
        progress an operator can read.
      * `apt-get install` needs INTERNET at install time, which an air-gapped site
        does not have.
      * an apt run interrupted by a reboot leaves eight half-configured packages
        and a dpkg that needs `--configure -a` from a shell nobody has.
      * nothing is pinned: whatever docker-ce is current on install day is what
        that customer gets.

    So all of it happens here, once, on a machine we control. The installer's job
    shrinks to `wsl --import`.

    ══ AND WHY THE IMAGES ARE BUILT WITH -f docker-compose.yml ALONE ════════════

    docker-compose.override.yml auto-merges on every plain `docker compose` call
    and builds the `deps` stage of both Next apps. Before P0 it built into the SAME
    TAG as the production `runner` stage, so a payload saved from a developer's
    machine shipped a console whose CMD was a bare `node` — it exits 0 on start and
    the console never appears. The override now uses `:dev` tags, but this script
    still passes the base file explicitly and tags with the release version, because
    "the override happened not to be merged" is not a property to rely on.

.PARAMETER Version
    The release version. Every image is tagged with it and the appliance overlay
    pins it, so two releases cannot share a tag.

.PARAMETER OutDir
    Where to stage the payload. Defaults to <repo>\dist\appliance.

.PARAMETER SkipImages
    Reuse images already tagged with -Version instead of rebuilding. For iterating
    on the distro bake without a 20-minute image build in front of it.

.PARAMETER KeepBuildDistro
    Do not unregister the temporary build distro when finished. For debugging a
    bake that produced something unexpected.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Version,
    [string] $OutDir = '',
    [switch] $SkipImages,
    [switch] $KeepBuildDistro
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  . $Message" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

# Native executables do not raise PowerShell errors, so every one of them is
# checked. `Start-Transcript` also does not capture a native command's console
# output — the NVR spent a day on that, with a recorder's careful explanation going
# to a console nobody watched while the log recorded only "exit code 1" — so the
# output is captured and echoed rather than left to the transcript.
#
# == WHY EVERY NATIVE CALL RELAXES ErrorActionPreference ======================
#
# In Windows PowerShell 5.1, `2>&1` on a NATIVE executable wraps each stderr line
# in a NativeCommandError record. Under $ErrorActionPreference = 'Stop' the FIRST
# such line is a TERMINATING error — so a merely chatty program kills the script
# before its exit code is ever looked at.
#
# That is not hypothetical. The first run of this script died three seconds into a
# thirty-minute build on:
#
#     docker.exe :  Image neubit-v3-workflow Building
#
# `docker compose build` writes its progress to stderr, and a normal progress line
# was reported as fatal. Nothing was wrong with the build.
#
# So the preference is relaxed around the invocation only, and the EXIT CODE stays
# the sole thing that decides success — which is the correct contract for a native
# program anyway. stderr is still captured, because that is where the useful
# failure text lives.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]   $Exe,
        [Parameter(Mandatory)][string[]] $Arguments
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>&1
        return [pscustomobject]@{ Output = $out; Code = $LASTEXITCODE }
    } finally { $ErrorActionPreference = $prev }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]   $Exe,
        [Parameter(Mandatory)][string[]] $Arguments,
        [string] $What = ''
    )
    $label = if ($What) { $What } else { "$Exe $($Arguments -join ' ')" }
    $r = Invoke-Native -Exe $Exe -Arguments $Arguments
    foreach ($line in $r.Output) { Write-Host "    $line" -ForegroundColor DarkGray }
    if ($r.Code -ne 0) { throw "$label failed with exit code $($r.Code)" }
    return $r.Output
}

<# Fire-and-forget cleanup: removing something that may not be there.
   The exit code is deliberately ignored — "no such container" and "no distribution
   with the supplied name" are the EXPECTED answers on a clean machine, not faults.
   What must not happen is the message itself aborting the run. #>
function Invoke-BestEffort {
    param(
        [Parameter(Mandatory)][string]   $Exe,
        [Parameter(Mandatory)][string[]] $Arguments
    )
    try { Invoke-Native -Exe $Exe -Arguments $Arguments | Out-Null } catch { }
}

<# Gzip a file, streaming, without loading it into memory.

   == WHY THE PAYLOAD IS COMPRESSED AT ALL ==================================

   `wsl --export` writes a PLAIN TAR. The .tar.gz name is inherited from every
   WSL example on the internet and is a lie unless somebody compresses it: the
   first successful run of this script produced a 5,728 MB file whose magic bytes
   were "./".

   And the size is not the disk being wasteful. Inside the distro `docker load`
   stores layers EXTRACTED, so the exported filesystem is several times the
   1,367 MB image tar that went into it. P0's "1420 MB image payload" measured the
   tar, not the distro, and the plan's "~1.6 GB installer" was derived from the
   wrong artifact. This is where that gets corrected.

   `wsl --import` accepts a gzip tarball directly, so the installer needs no
   decompression step. Verified before this was written rather than assumed: a
   77 MB rootfs compressed to 29 MB, imported, started, and reported
   Ubuntu 24.04.4 LTS from inside.

   .NET's GZipStream rather than a shelled-out gzip: a build agent is not
   guaranteed to have a Linux distro with gzip on it, and Docker Desktop's own
   distro has no /mnt/c to reach the file through — which is how the first attempt
   at this failed. #>
function Compress-Gzip {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $in = [System.IO.File]::OpenRead($Source)
    try {
        $out = [System.IO.File]::Create($Destination)
        try {
            $gz = New-Object System.IO.Compression.GZipStream(
                $out, [System.IO.Compression.CompressionLevel]::Optimal)
            # Disposed INSIDE, before the file stream: GZipStream writes its
            # trailer on dispose, and a file closed first truncates the archive
            # into something that unpacks for 99% of its length and then fails.
            try { $in.CopyTo($gz, 4MB) } finally { $gz.Dispose() }
        } finally { $out.Dispose() }
    } finally { $in.Dispose() }
}

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DeployDir  = Join-Path $RepoRoot 'deploy'
$WindowsDir = $PSScriptRoot
$InDistro   = Join-Path $WindowsDir 'appliance'
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'dist\appliance' }

$BuildDistro = 'neubit-vms-build'
$Work        = Join-Path $env:TEMP "neubit-appliance-$Version"

# Every image the appliance runs. Third-party ones are pulled and re-tagged so the
# payload is self-contained and pinned; ours are built.
# Must list EVERY service the base compose builds. A service missing here is not
# baked, is not pinned by the appliance overlay, and boot.sh runs --no-build — so
# compose refuses to start the whole stack rather than skipping one container.
# Cross-check with:  docker compose -f docker-compose.yml config  |  grep -B... build
$OwnServices = @(
    'core', 'ingest', 'workflow', 'access', 'vision', 'ops-agent',
    'frontend', 'admin-frontend', 'tiles',
    # the reporting / BI plane, added with feat/vms
    # reporting-projector was folded into reading-writer on 2026-09-05; its
    # image no longer exists and asking for it here would fail the payload build.
    'dashboards', 'reading-writer', 'reporting-migrate'
)
$ThirdParty = @(
    'traefik:v3.1',
    'timescale/timescaledb:2.17.2-pg16',
    'redis:7-alpine',
    'nats:2.10-alpine'
)

Write-Host ''
Write-Host "Neubit VMS appliance payload — $Version" -ForegroundColor Green
Write-Host ''

# ── 1. images ────────────────────────────────────────────────────────────────
if ($SkipImages) {
    Write-Step 'Skipping the image build (-SkipImages)'
} else {
    Write-Step 'Building the production images'
    Push-Location $DeployDir
    try {
        # -f docker-compose.yml alone. See the header.
        Invoke-Checked -Exe 'docker' -What 'compose build' -Arguments @(
            'compose', '-f', 'docker-compose.yml', 'build'
        )
        foreach ($svc in $OwnServices) {
            Invoke-Checked -Exe 'docker' -What "tag $svc" -Arguments @(
                'tag', "neubit-v3-$svc`:latest", "neubit-v3-$svc`:$Version"
            )
            Write-Ok "neubit-v3-$svc`:$Version"
        }
    } finally { Pop-Location }

    Write-Step 'Pulling the pinned third-party images'
    foreach ($img in $ThirdParty) {
        Invoke-Checked -Exe 'docker' -What "pull $img" -Arguments @('pull', $img)
        Write-Ok $img
    }
}

# ── 2. a rootfs of our own ───────────────────────────────────────────────────
#
# Ubuntu stopped publishing a WSL rootfs — cloud-images.ubuntu.com/wsl/ carries
# only manifests now, and `wsl --install` from the Store is not something an
# appliance installer can depend on. Exporting a container is one line, 80 MB,
# reproducible and version-pinned, which is better than what we lost.
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$RootfsTar = Join-Path $Work 'rootfs.tar'

Write-Step 'Building the base rootfs from ubuntu:24.04'
Invoke-Checked -Exe 'docker' -Arguments @('pull', 'ubuntu:24.04') -What 'pull ubuntu'
Invoke-BestEffort -Exe 'docker' -Arguments @('rm', '-f', 'neubit-rootfs')
Invoke-Checked -Exe 'docker' -Arguments @('create', '--name', 'neubit-rootfs', 'ubuntu:24.04') -What 'create rootfs container'
Invoke-Checked -Exe 'docker' -Arguments @('export', 'neubit-rootfs', '-o', $RootfsTar) -What 'export rootfs'
Invoke-BestEffort -Exe 'docker' -Arguments @('rm', 'neubit-rootfs')
Write-Ok ("rootfs.tar  {0:N0} MB" -f ((Get-Item $RootfsTar).Length / 1MB))

# ── 3. bake ──────────────────────────────────────────────────────────────────
Write-Step "Importing the build distro ($BuildDistro)"
Invoke-BestEffort -Exe 'wsl' -Arguments @('--unregister', $BuildDistro)   # usually absent
$DistroDir = Join-Path $Work 'distro'
New-Item -ItemType Directory -Force -Path $DistroDir | Out-Null
Invoke-Checked -Exe 'wsl' -Arguments @('--import', $BuildDistro, $DistroDir, $RootfsTar, '--version', '2') -What 'wsl --import'

try {
    Write-Step 'Installing the container engine into the distro'
    $prep = Join-Path $Work 'prep.sh'
    $prepScript = @'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl iproute2 iptables >/dev/null
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*
mkdir -p /opt/neubit
dockerd --version
docker compose version
'@ -replace "`r`n", "`n"
    # NOT Set-Content -Encoding utf8. In PowerShell 5.1 that writes a BOM, bash reads
    # the BOM as part of the first token, and the first line of every script staged
    # this way died as "﻿set: command not found" — silently, because the line that
    # failed was the `set -euo pipefail` that would have aborted on it. Both bake
    # scripts have therefore been running with no error trapping at all. WriteAllText
    # with a plain UTF8Encoding($false) writes the bytes bash expects.
    [IO.File]::WriteAllText($prep, $prepScript, (New-Object Text.UTF8Encoding($false)))
    $prepWsl = '/mnt/' + $prep.Substring(0,1).ToLower() + ($prep.Substring(2) -replace '\\','/')
    Invoke-Checked -Exe 'wsl' -What 'engine install' -Arguments @(
        '-d', $BuildDistro, '-u', 'root', '--', 'bash', $prepWsl
    )

    Write-Step 'Staging /opt/neubit inside the distro'
    foreach ($f in @('boot.sh', 'wsl.conf', 'docker-compose.appliance.yml')) {
        $src = Join-Path $InDistro $f
        if (-not (Test-Path -LiteralPath $src)) { throw "missing appliance file: $src" }
    }
    $stage = @"
set -euo pipefail
mkdir -p /opt/neubit
cp '$(( '/mnt/' + $InDistro.Substring(0,1).ToLower() + ($InDistro.Substring(2) -replace '\\','/') ))/boot.sh' /opt/neubit/boot.sh
cp '$(( '/mnt/' + $InDistro.Substring(0,1).ToLower() + ($InDistro.Substring(2) -replace '\\','/') ))/docker-compose.appliance.yml' /opt/neubit/
cp '$(( '/mnt/' + $InDistro.Substring(0,1).ToLower() + ($InDistro.Substring(2) -replace '\\','/') ))/wsl.conf' /etc/wsl.conf
cp '$(( '/mnt/' + $DeployDir.Substring(0,1).ToLower() + ($DeployDir.Substring(2) -replace '\\','/') ))/docker-compose.yml' /opt/neubit/
cp '$(( '/mnt/' + $DeployDir.Substring(0,1).ToLower() + ($DeployDir.Substring(2) -replace '\\','/') ))/migrate.sh' /opt/neubit/
# /opt/GATEWAY, NOT /opt/neubit/gateway — and this is not a style choice.
#
# docker-compose.yml mounts '../gateway/traefik.yml', and compose resolves a
# relative bind path against the PROJECT DIRECTORY. boot.sh passes
# --project-directory /opt/neubit, so '../gateway' is /opt/gateway. Staged one
# level in, the path does not exist, Docker CREATES IT AS A DIRECTORY, and
# Traefik exits because its config file is a folder. The gateway is the only
# thing publishing :80, so the whole console is gone — and nothing in the boot
# log says 'gateway', it says a container restarted.
#
# Verified with `docker compose ... --project-directory <dir> config`, which
# resolved the source to <dir>/../gateway.
mkdir -p /opt/neubit/postgres /opt/gateway
cp -r '$(( '/mnt/' + $DeployDir.Substring(0,1).ToLower() + ($DeployDir.Substring(2) -replace '\\','/') ))/postgres/.' /opt/neubit/postgres/
cp -r '$(( '/mnt/' + $RepoRoot.Substring(0,1).ToLower() + ($RepoRoot.Substring(2) -replace '\\','/') ))/gateway/.' /opt/gateway/
sed -i 's/\r$//' /opt/neubit/boot.sh /opt/neubit/migrate.sh /etc/wsl.conf /opt/neubit/postgres/*.sh
chmod +x /opt/neubit/boot.sh /opt/neubit/migrate.sh
ls -la /opt/neubit /opt/gateway
"@ -replace "`r`n", "`n"
    $stageFile = Join-Path $Work 'stage.sh'
    # See the note on $prep above: -Encoding utf8 writes a BOM that bash chokes on.
    [IO.File]::WriteAllText($stageFile, $stage, (New-Object Text.UTF8Encoding($false)))
    $stageWsl = '/mnt/' + $stageFile.Substring(0,1).ToLower() + ($stageFile.Substring(2) -replace '\\','/')
    Invoke-Checked -Exe 'wsl' -What 'stage /opt/neubit' -Arguments @(
        '-d', $BuildDistro, '-u', 'root', '--', 'bash', $stageWsl
    )

    Write-Step 'Loading the release images into the distro'
    $ImgTar = Join-Path $Work 'images.tar'
    $allImages = @($OwnServices | ForEach-Object { "neubit-v3-$_`:$Version" }) + $ThirdParty
    Invoke-Checked -Exe 'docker' -What 'docker save' -Arguments (@('save', '-o', $ImgTar) + $allImages)
    Write-Ok ("images.tar  {0:N0} MB" -f ((Get-Item $ImgTar).Length / 1MB))

    $imgWsl = '/mnt/' + $ImgTar.Substring(0,1).ToLower() + ($ImgTar.Substring(2) -replace '\\','/')
    # Through boot.sh, NOT a hand-rolled dockerd. Same launcher at bake time and at
    # run time, so the image store cannot differ — see the header of boot.sh.
    Invoke-Checked -Exe 'wsl' -What 'engine up (bake)' -Arguments @(
        '-d', $BuildDistro, '-u', 'root', '--', '/opt/neubit/boot.sh', 'engine'
    )
    Invoke-Checked -Exe 'wsl' -What 'docker load' -Arguments @(
        '-d', $BuildDistro, '-u', 'root', '--', 'docker', 'load', '-i', $imgWsl
    )

    Write-Step 'Verifying the bake'
    $loaded = & wsl -d $BuildDistro -u root -- docker image ls --format '{{.Repository}}:{{.Tag}}'
    $missing = @($allImages | Where-Object { $loaded -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw "these images did not survive the bake: $($missing -join ', ')"
    }
    Write-Ok "$($allImages.Count) images present"

    # Shut the distro down cleanly before exporting, or the export captures a
    # running engine's open files.
    Invoke-BestEffort -Exe 'wsl' -Arguments @('--terminate', $BuildDistro)

    Write-Step 'Exporting the appliance distro'
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $Payload = Join-Path $OutDir 'neubit-vms.tar.gz'
    $RawTar  = Join-Path $Work 'neubit-vms.tar'
    Invoke-Checked -Exe 'wsl' -What 'wsl --export' -Arguments @('--export', $BuildDistro, $RawTar)
    $rawMb = (Get-Item $RawTar).Length / 1MB
    Write-Ok ("exported  {0:N0} MB, uncompressed" -f $rawMb)

    Write-Step 'Compressing the payload'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Compress-Gzip -Source $RawTar -Destination $Payload
    $sw.Stop()
    $gzMb = (Get-Item $Payload).Length / 1MB
    Write-Ok ("neubit-vms.tar.gz  {0:N0} MB  ({1:N1}x smaller, {2:N0}s)" -f `
        $gzMb, ($rawMb / $gzMb), $sw.Elapsed.TotalSeconds)

    # A gzip member starts 1f 8b. Checked because the failure this guards against
    # is silent: a plain tar named .tar.gz imports perfectly well, so nothing
    # downstream would ever complain, and the release would just be four times
    # the size it should be.
    $magic = [byte[]]::new(2)
    $fs = [System.IO.File]::OpenRead($Payload)
    try { $fs.Read($magic, 0, 2) | Out-Null } finally { $fs.Dispose() }
    if ($magic[0] -ne 0x1f -or $magic[1] -ne 0x8b) {
        throw "the payload is not gzip (magic $('{0:x2}{1:x2}' -f $magic[0], $magic[1])) - compression did not take"
    }
}
finally {
    # Save the rootfs BEFORE $Work is deleted. probe-system-wsl.ps1 needs one to
    # exercise the check that decides whether a box can run the appliance at all,
    # and a skipped gate reads like a passed gate to somebody on a customer site.
    if (Test-Path -LiteralPath $RootfsTar) {
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
        Copy-Item -LiteralPath $RootfsTar -Destination (Join-Path $OutDir 'rootfs.tar') -Force
    }

    if ($KeepBuildDistro) {
        Write-Warn "build distro $BuildDistro kept (-KeepBuildDistro)"
    } else {
        Invoke-BestEffort -Exe 'wsl' -Arguments @('--unregister', $BuildDistro)
    }
    Remove-Item -Recurse -Force -Path $Work -ErrorAction SilentlyContinue
}

# ── 4. the rest of the payload ───────────────────────────────────────────────
Write-Step 'Staging the install scripts'
# backup/restore ride along because the database they protect lives INSIDE the
# distro this payload replaces. An operator who has the new payload but not these
# two has no way to carry their tenants, users and recorders across the upgrade —
# and would only discover that after the old distro was already unregistered.
foreach ($f in @('install-appliance.ps1', 'uninstall-appliance.ps1', 'probe-system-wsl.ps1',
                 'backup-appliance-db.ps1', 'restore-appliance-db.ps1', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $WindowsDir $f) -Destination $OutDir -Force
    Write-Ok $f
}

# boot.sh and the compose overlay go BESIDE the installer as well as inside the
# tarball. They are the appliance's own init and its own service definitions — the
# two files most likely to need a field fix — and baked in, changing one line costs
# a 2.9 GB rebake and a redelivery. The installer copies these over the baked
# copies, so a fix ships in a 30 KB bundle. Same files, same commit, so the two
# can never disagree.
foreach ($cfg in @('boot.sh', 'docker-compose.appliance.yml')) {
    Copy-Item -LiteralPath (Join-Path $InDistro $cfg) -Destination $OutDir -Force
    Write-Ok $cfg
}

$probeRootfs = Join-Path $OutDir 'rootfs.tar'
if (Test-Path -LiteralPath $probeRootfs) {
    Write-Ok ("rootfs.tar  {0:N0} MB  (for probe-system-wsl.ps1)" -f ((Get-Item $probeRootfs).Length / 1MB))
} else {
    Write-Warn 'rootfs.tar was not staged - probe-system-wsl.ps1 will skip its main check'
}
@{ version = $Version; built = (Get-Date).ToUniversalTime().ToString('o'); distro = 'neubit-vms' } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir 'appliance.json') -Encoding utf8
Write-Ok 'appliance.json'

$total = (Get-ChildItem -Recurse -File $OutDir | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Step 'Payload staged'
Write-Host ("  {0}   ({1:N0} MB)" -f $OutDir, ($total / 1MB)) -ForegroundColor Green
Write-Host ''
Write-Host '  The offline basemap (deploy/tiles/planet.pmtiles, 3.7 GB) is NOT in here.' -ForegroundColor DarkGray
Write-Host '  It is larger than every image combined and ships as a separate optional' -ForegroundColor DarkGray
Write-Host '  download — see deploy/windows/README.md.' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Next:  cd desktop  &&  npm run package:win' -ForegroundColor DarkGray
Write-Host ''
