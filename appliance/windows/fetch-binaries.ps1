<#
.SYNOPSIS
    Installs the third-party runtimes the Neubit VMS native Windows appliance
    supervises, verifying every download against appliance/windows/binaries.json
    before a single byte is extracted.

    Adapted from the Neubit NVR's fetch-binaries.ps1 (same verified-before-extract
    order, the same extract-rule grammar and receipt schema), so both products
    vendor their runtimes the same way.

.DESCRIPTION
    PostgreSQL + TimescaleDB, NATS, Traefik, node, ffmpeg and poppler are several
    hundred megabytes together
    and are not committed to this repository. This script is how they get onto a
    build agent or an appliance: it reads the pinned manifest, downloads each
    artifact, checks its SHA-256, and only then unpacks it into the bin directory
    that layout.Layout.BinDir points at (appliance/internal/layout).

    THE ORDER MATTERS AND IS NOT NEGOTIABLE. The hash is checked while the
    download is still an opaque blob in the cache directory. Nothing is opened,
    nothing is extracted and nothing is written into the bin directory until the
    digest matches, because an archive is a parser surface: handing unverified
    bytes to a zip reader is the whole class of bug this ordering exists to avoid.
    A mismatch deletes the download and stops the script with a non-zero exit.

    After extraction the script writes vendorbin.lock.json into the bin directory,
    recording the archive digest it verified plus the SHA-256 and size of every
    file it wrote. That receipt records the chain manifest -> archive -> installed file, so it
    stays checkable long after the archives are gone.

    Designed to run unattended: no prompts, no interactive auth, deterministic
    exit codes (0 success, 1 failure), and re-runs are cheap because verified
    downloads stay in the cache directory and already-correct artifacts are
    skipped.

.PARAMETER BinDir
    Where the binaries are installed. Defaults to the appliance's own bin
    directory, %ProgramData%\Neubit\VMS\bin (layout.Layout.BinDir for the
    default data root). CI normally points this at a staging directory it then packages.

.PARAMETER Manifest
    Path to binaries.json. Defaults to the copy next to this script.

.PARAMETER CacheDir
    Where downloaded archives are kept between runs. Defaults to a directory under
    TEMP. Point it at a persistent path on a build agent to avoid re-downloading
    ~400 MB per build.

.PARAMETER Only
    Install just these artifacts, by manifest name (postgresql, timescaledb,
    vcredist, node, nats, traefik, ffmpeg, poppler). Handy when bumping one pin.

.PARAMETER Force
    Re-download and re-extract even when the receipt already shows the artifact
    correctly installed.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File appliance\windows\fetch-binaries.ps1

.EXAMPLE
    .\fetch-binaries.ps1 -BinDir C:\build\stage\bin -CacheDir C:\build\cache
#>

[CmdletBinding()]
param(
    [string]   $BinDir   = (Join-Path $env:ProgramData 'Neubit\VMS\bin'),
    [string]   $Manifest = '',
    [string]   $CacheDir = (Join-Path $env:TEMP 'neubit-vms-vendorbin-cache'),
    [string[]] $Only     = @(),
    [switch]   $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Invoke-WebRequest renders a progress bar per buffer in Windows PowerShell 5.1,
# which turns a 325 MB download into a multi-minute one and floods a CI log.
$ProgressPreference = 'SilentlyContinue'

# Older Windows PowerShell hosts still default to TLS 1.0/1.1, which every
# publisher used here now refuses. Setting this explicitly means the script does
# not silently depend on whatever the agent image happened to configure.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls

Add-Type -AssemblyName System.IO.Compression.FileSystem

# The receipt schema this script writes (the NVR's, unchanged).
$ReceiptSchema = 1
$ReceiptName   = 'vendorbin.lock.json'

function Write-Step  { param([string]$Message) Write-Host "==> $Message" }
function Write-Detail { param([string]$Message) Write-Host "    $Message" }

# -- glob matching ------------------------------------------------------------

<#
Translates a manifest glob into a .NET regex, matching the semantics of
globMatch() in the NVR's Go vendorbin package exactly:

    ?   one character, never "/"
    *   zero or more characters, never crossing "/"
    **  zero or more characters, crossing "/" freely

Two implementations of one grammar is the price of having the fetch in PowerShell
and the verify in Go. They are kept honest by being tiny and by the Go tests
covering the same table of cases this comment describes.
#>
function ConvertTo-GlobRegex {
    param([Parameter(Mandatory)][string]$Glob)

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('^')
    $i = 0
    while ($i -lt $Glob.Length) {
        $c = $Glob[$i]
        if ($c -eq '*') {
            if (($i + 1) -lt $Glob.Length -and $Glob[$i + 1] -eq '*') {
                [void]$sb.Append('.*'); $i += 2
            } else {
                [void]$sb.Append('[^/]*'); $i += 1
            }
        } elseif ($c -eq '?') {
            [void]$sb.Append('[^/]'); $i += 1
        } else {
            [void]$sb.Append([regex]::Escape([string]$c)); $i += 1
        }
    }
    [void]$sb.Append('$')
    return $sb.ToString()
}

# -- rule parsing -------------------------------------------------------------

<#
Parses one artifact's extractGlob into placement rules. The grammar is documented
on parseRules() in the Go package; this is the second implementation of it.

    spec := rule (";" rule)*
    rule := ("file" | "flat" | "tree") ":" src "=>" dst

An archive kind of "none" has no archive to select from, so the whole string is
just the destination path.
#>
function Get-ExtractRules {
    param(
        [Parameter(Mandatory)][string]$Archive,
        [Parameter(Mandatory)][string]$Spec
    )

    if ($Archive -eq 'none') {
        Assert-SafeDestination -Destination $Spec
        return @([pscustomobject]@{ Kind = 'file'; Src = ''; Dst = $Spec })
    }

    $rules = @()
    foreach ($part in $Spec.Split(';')) {
        $part = $part.Trim()
        if ([string]::IsNullOrWhiteSpace($part)) { continue }

        $colon = $part.IndexOf(':')
        if ($colon -lt 0) { throw "extract rule '$part' has no '<kind>:' prefix" }
        $kind = $part.Substring(0, $colon).Trim()
        if ($kind -notin @('file', 'flat', 'tree')) {
            throw "extract rule '$part' has unknown kind '$kind' (want file, flat or tree)"
        }

        $rest  = $part.Substring($colon + 1)
        $arrow = $rest.IndexOf('=>')
        if ($arrow -lt 0) { throw "extract rule '$part' has no '=>' separator" }

        $src = $rest.Substring(0, $arrow).Trim()
        $dst = $rest.Substring($arrow + 2).Trim()
        if ([string]::IsNullOrWhiteSpace($src)) { throw "extract rule '$part' has an empty source selector" }
        Assert-SafeDestination -Destination $dst
        if ($kind -eq 'tree' -and ($src.Contains('*') -or $src.Contains('?'))) {
            throw "extract rule '$part': a tree rule takes a literal prefix, not a glob"
        }

        $rules += [pscustomobject]@{ Kind = $kind; Src = $src.TrimEnd('/'); Dst = $dst }
    }

    if ($rules.Count -eq 0) { throw "extractGlob '$Spec' contains no rules" }
    return $rules
}

<#
The zip-slip guard, applied to manifest destinations. The Go side enforces the
same rules at Load time, but this script must not depend on anyone having run the
Go side first: it is frequently the very first thing a fresh build agent executes.
#>
function Assert-SafeDestination {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Destination)

    if ([string]::IsNullOrWhiteSpace($Destination)) { throw "empty destination" }
    if ($Destination.Contains('\')) { throw "destination '$Destination' must use / separators" }
    if ($Destination.StartsWith('/')) { throw "destination '$Destination' must be relative to the bin directory" }
    if ($Destination.Length -ge 2 -and $Destination[1] -eq ':') {
        throw "destination '$Destination' must be relative to the bin directory"
    }
    foreach ($seg in $Destination.Split('/')) {
        if ($seg -eq '..') { throw "destination '$Destination' must not contain '..'" }
    }
}

<#
Resolves a bin-relative path to an absolute one and proves it is still inside the
bin directory.

This repeats work Assert-SafeDestination already did, on purpose. That function
guards strings from the MANIFEST; this one guards paths built from ARCHIVE MEMBER
NAMES, which are attacker-controlled in a way the manifest is not. A zip whose
entries are named "..\..\Windows\System32\..." is the textbook attack, and the
only reliable defence is to compare the resolved path against the resolved root
rather than to pattern-match the name.
#>
function Resolve-UnderRoot {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Relative
    )

    $rootFull = [IO.Path]::GetFullPath($Root)
    if (-not $rootFull.EndsWith([IO.Path]::DirectorySeparatorChar)) {
        $rootFull += [IO.Path]::DirectorySeparatorChar
    }
    $full = [IO.Path]::GetFullPath((Join-Path $Root ($Relative -replace '/', '\')))
    if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to write '$Relative': it resolves outside '$Root'"
    }
    return $full
}

# -- download + hash ----------------------------------------------------------

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

<#
Downloads an artifact into the cache and returns the path, having proved the bytes
match the manifest digest.

A cached file is re-hashed rather than trusted by name: the cache is an ordinary
directory that anything on the machine could have written to, so its contents get
exactly the same scrutiny as a fresh download. A cached file whose digest does not
match is treated as a stale download and replaced, not as tampering, because that
is overwhelmingly what it is -- a pin was bumped and the old archive kept its name.
The download itself, though, is never given a second chance: if freshly fetched
bytes do not match, the script deletes them and stops.
#>
function Get-VerifiedArchive {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Sha256,
        [Parameter(Mandatory)][string]$CachePath
    )

    $want = $Sha256.ToLowerInvariant()

    if ((Test-Path -LiteralPath $CachePath) -and -not $Force) {
        $have = Get-Sha256 -Path $CachePath
        if ($have -eq $want) {
            Write-Detail "cached, digest matches ($($want.Substring(0,12))...)"
            return $CachePath
        }
        Write-Detail "cached copy has digest $($have.Substring(0,12))..., expected $($want.Substring(0,12))...; re-downloading"
        Remove-Item -LiteralPath $CachePath -Force
    }

    # Download to a .part file so an interrupted run can never leave something at
    # the cache path that a later run might mistake for a complete download.
    $partial = "$CachePath.part"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }

    Write-Detail "downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing -MaximumRedirection 5

    $have = Get-Sha256 -Path $partial
    if ($have -ne $want) {
        Remove-Item -LiteralPath $partial -Force
        throw @"
SHA-256 MISMATCH - refusing to extract.

  url      : $Url
  expected : $want
  actual   : $have

The download has been deleted. Nothing was extracted. Either the manifest pin is
out of date (bump it deliberately, and record where the new digest came from in
checksumSource), or these bytes are not the bytes the publisher shipped. Do not
"fix" this by pasting the actual digest into the manifest without establishing
which of the two it is.
"@
    }

    Move-Item -LiteralPath $partial -Destination $CachePath -Force
    Write-Detail "verified ($($want.Substring(0,12))...)"
    return $CachePath
}

# -- extraction ---------------------------------------------------------------

<#
Applies one artifact's rules to a verified zip and returns the receipt entries for
everything written.

Written files are hashed here, immediately after extraction, from bytes that came
out of an archive whose digest already matched the manifest. That ordering is the
only reason the receipt means anything.
#>
function Expand-ByRules {
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$BinDir,
        [Parameter(Mandatory)][object[]]$Rules
    )

    $written = @{}
    $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entries = @($zip.Entries | Where-Object { $_.Name -ne '' })

        foreach ($rule in $Rules) {
            $matched = 0

            foreach ($entry in $entries) {
                $member = $entry.FullName -replace '\\', '/'
                $relative = $null

                switch ($rule.Kind) {
                    'file' {
                        if ($member -cmatch (ConvertTo-GlobRegex $rule.Src)) { $relative = $rule.Dst }
                    }
                    'flat' {
                        if ($member -cmatch (ConvertTo-GlobRegex $rule.Src)) {
                            $leaf = $member.Substring($member.LastIndexOf('/') + 1)
                            $relative = if ($rule.Dst -eq '.') { $leaf } else { "$($rule.Dst)/$leaf" }
                        }
                    }
                    'tree' {
                        $prefix = "$($rule.Src)/"
                        if ($member.StartsWith($prefix, [StringComparison]::Ordinal)) {
                            $rest = $member.Substring($prefix.Length)
                            # An archive member is attacker-controlled input; a
                            # ".." inside one is never legitimate.
                            if ($rest -split '/' -contains '..') {
                                throw "archive member '$member' contains '..'"
                            }
                            $relative = if ($rule.Dst -eq '.') { $rest } else { "$($rule.Dst)/$rest" }
                        }
                    }
                }

                if ($null -eq $relative) { continue }
                $matched++

                if ($rule.Kind -eq 'file' -and $matched -gt 1) {
                    throw "extract rule 'file:$($rule.Src)=>$($rule.Dst)' matched more than one archive member; the manifest must select exactly one"
                }

                $target = Resolve-UnderRoot -Root $BinDir -Relative $relative
                $parent = Split-Path -Parent $target
                if (-not (Test-Path -LiteralPath $parent)) {
                    New-Item -ItemType Directory -Path $parent -Force | Out-Null
                }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)

                $written[$relative] = [pscustomobject]@{
                    path   = $relative
                    size   = (Get-Item -LiteralPath $target).Length
                    sha256 = Get-Sha256 -Path $target
                }
            }

            if ($matched -eq 0) {
                throw "extract rule '$($rule.Kind):$($rule.Src)=>$($rule.Dst)' matched no archive member; the upstream layout has changed and the manifest needs updating"
            }
        }
    } finally {
        $zip.Dispose()
    }

    return @($written.Values | Sort-Object -Property path)
}

<#
Installs an unarchived artifact: the download IS the binary, so it is copied
straight to its destination. The digest was already checked against the manifest,
and the Go verifier re-checks this file against the manifest directly rather than
via the receipt, which is why an artifact like node.exe stays verifiable even if
the receipt itself is what got rewritten.
#>
function Install-BareBinary {
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$BinDir,
        [Parameter(Mandatory)][string]$Destination
    )

    $target = Resolve-UnderRoot -Root $BinDir -Relative $Destination
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $ArchivePath -Destination $target -Force

    return @([pscustomobject]@{
        path   = $Destination
        size   = (Get-Item -LiteralPath $target).Length
        sha256 = Get-Sha256 -Path $target
    })
}

# -- receipt ------------------------------------------------------------------

function Read-Receipt {
    param([Parameter(Mandatory)][string]$BinDir)

    $path = Join-Path $BinDir $ReceiptName
    if (-not (Test-Path -LiteralPath $path)) { return @{} }
    try {
        $doc = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    } catch {
        Write-Detail "existing $ReceiptName is unreadable; it will be rebuilt"
        return @{}
    }
    if ($doc.schema -ne $ReceiptSchema) { return @{} }

    $byName = @{}
    foreach ($a in @($doc.artifacts)) { $byName[$a.name] = $a }
    return $byName
}

<#
Writes the receipt.

Out-File and Set-Content in Windows PowerShell 5.1 emit a UTF-8 BOM, and Go's
encoding/json refuses a document that starts with one. Writing through
UTF8Encoding($false) is not a style preference; it is the difference between a
receipt the service can read and one it rejects at every boot.
#>
function Write-Receipt {
    param(
        [Parameter(Mandatory)][string]$BinDir,
        [Parameter(Mandatory)][hashtable]$Artifacts
    )

    $ordered = @($Artifacts.Keys | Sort-Object | ForEach-Object { $Artifacts[$_] })
    $doc = [pscustomobject]@{
        schema      = $ReceiptSchema
        generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        artifacts   = $ordered
    }

    $json = $doc | ConvertTo-Json -Depth 6
    $path = Join-Path $BinDir $ReceiptName
    [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
    Write-Detail "wrote $path"
}

<#
Reports whether an artifact is already correctly installed, so a re-run is a
no-op rather than another few hundred megabytes of extraction. The check is the
same one the Go verifier performs: right version, right archive digest, and every
recorded file present at the recorded size and hash.
#>
function Test-AlreadyInstalled {
    param(
        [Parameter(Mandatory)][string]$BinDir,
        [Parameter(Mandatory)][object]$Artifact,
        [AllowNull()][object]$Recorded
    )

    if ($null -eq $Recorded) { return $false }
    if ($Recorded.version -ne $Artifact.version) { return $false }
    if ($Recorded.sha256.ToLowerInvariant() -ne $Artifact.sha256.ToLowerInvariant()) { return $false }
    if (@($Recorded.files).Count -eq 0) { return $false }

    foreach ($f in @($Recorded.files)) {
        $full = Join-Path $BinDir ($f.path -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $full).Length -ne $f.size) { return $false }
        if ((Get-Sha256 -Path $full) -ne $f.sha256.ToLowerInvariant()) { return $false }
    }
    return $true
}

# -- main ---------------------------------------------------------------------

try {
    # $PSScriptRoot is not reliably populated while param() defaults are being
    # evaluated in Windows PowerShell 5.1, so the manifest default is resolved
    # here instead -- where it is always correct -- rather than in the param block.
    if ([string]::IsNullOrWhiteSpace($Manifest)) {
        $Manifest = Join-Path $PSScriptRoot 'binaries.json'
    }
    if (-not (Test-Path -LiteralPath $Manifest)) {
        throw "manifest not found: $Manifest"
    }

    Write-Step "manifest $Manifest"
    $doc = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
    if ($doc.schema -ne 1) {
        throw "manifest schema $($doc.schema) is not understood by this script (expected 1)"
    }

    foreach ($dir in @($BinDir, $CacheDir)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
    # NOTE: this script deliberately does not touch ACLs: `neubitvms-svc install`
    # seals the whole data root, bin included.
    Write-Step "installing into $BinDir"
    Write-Detail "cache $CacheDir"

    $receipt = Read-Receipt -BinDir $BinDir

    # powershell.exe -File passes every argument as a plain string, so
    # "-Only nats,node" arrives as ONE element rather than two. CI invokes the
    # script that way, so the comma is split here instead of being a trap that
    # silently selects nothing and exits successfully having installed half a
    # stack.
    $wanted = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $known  = @($doc.artifacts | ForEach-Object { $_.name })
    $unknown = @($wanted | Where-Object { $_ -notin $known })
    if ($unknown.Count -gt 0) {
        throw "-Only names artifacts that are not in the manifest: $($unknown -join ', ') (manifest has: $($known -join ', '))"
    }

    $selected = @($doc.artifacts | Where-Object { $wanted.Count -eq 0 -or $wanted -contains $_.name })
    if ($selected.Count -eq 0) {
        throw "no artifacts selected"
    }

    foreach ($a in $selected) {
        Write-Step "$($a.name) $($a.version)  [$($a.licence), checksum: $($a.checksumSource)]"

        if (-not $Force -and (Test-AlreadyInstalled -BinDir $BinDir -Artifact $a -Recorded $receipt[$a.name])) {
            Write-Detail 'already installed and intact; skipping'
            continue
        }

        if (-not $a.url.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
            throw "artifact '$($a.name)' has a non-https url; vendored binaries must be fetched over TLS"
        }

        $rules = Get-ExtractRules -Archive $a.archive -Spec $a.extractGlob

        # The cache filename embeds the digest, so two pins of the same artifact
        # can coexist and a stale entry can never masquerade as a current one.
        $leaf      = ($a.url -split '/')[-1] -replace '[^A-Za-z0-9\.\-_]', '_'
        $cachePath = Join-Path $CacheDir "$($a.sha256.Substring(0,16))-$leaf"
        $archive   = Get-VerifiedArchive -Url $a.url -Sha256 $a.sha256 -CachePath $cachePath

        switch ($a.archive) {
            'zip' {
                $files = Expand-ByRules -ArchivePath $archive -BinDir $BinDir -Rules $rules
            }
            'none' {
                $files = Install-BareBinary -ArchivePath $archive -BinDir $BinDir -Destination $rules[0].Dst
            }
            default {
                # tar.gz is accepted by the manifest schema for the Linux and macOS
                # manifests that will follow, but nothing on Windows ships as one
                # and an untested extraction path is worse than an honest refusal.
                throw "artifact '$($a.name)' has archive kind '$($a.archive)', which this Windows fetch script does not implement (only 'zip' and 'none')"
            }
        }

        Write-Detail "installed $(@($files).Count) file(s)"
        $receipt[$a.name] = [pscustomobject]@{
            name    = $a.name
            version = $a.version
            sha256  = $a.sha256.ToLowerInvariant()
            files   = @($files)
        }
    }

    Write-Receipt -BinDir $BinDir -Artifacts $receipt

    Write-Step 'done'
    Write-Detail "receipt: $(Join-Path $BinDir $ReceiptName)"
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'FETCH FAILED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
    exit 1
}
