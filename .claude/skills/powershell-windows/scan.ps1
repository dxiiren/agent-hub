#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Pattern scan for the PowerShell traps listed in the powershell-windows agent. Exits 1 on any finding.

.DESCRIPTION
    Not a parser for most rules - every hit is a line to READ, not an automatic fix. With no
    arguments it scans every *.ps1 under the repo root (skipping .git, node_modules, vendor).

    Rules: NATIVE_SHADOW (a function named like a native command), BOM_WRITE (Out-File or
    Set-Content -Encoding UTF8, or [Text.Encoding]::UTF8 handed to a writer), JSON_DEPTH
    (ConvertTo-Json without -Depth), NON_ASCII (any non-ASCII character, 5.1 files), FILE_BOM (the .ps1
    itself starts with a BOM), UNPAREN_LOGIC (a cmdlet call directly after if ( and before
    -and / -or), PERSONAL_PATH (C:\Users\<name>, either slash), PS51_PARSE (a file that must run
    on Windows PowerShell 5.1 fails the 5.1 parser), MISSING_FILE (a path that does not exist).
    Block comments (help text like this one) and whole-line comments are skipped.

    Which files must run on 5.1: initial-setup.ps1 (it bootstraps a machine that may not have
    pwsh 7 yet) plus any file passed after -As51. Every other .ps1 is assumed to run on pwsh 7
    (init.ps1, setup.ps1, tools\*, the Pester suite). justfile recipe LINES run on 5.1 too, but
    they are not .ps1 files - review them by hand against the agent's 5.1-vs-7 checklist.
#>
# ValueFromRemainingArguments: with a plain [string[]] parameter, `pwsh -File scan.ps1
# a.ps1 b.ps1` binds only the FIRST file and silently drops the rest.
param(
    [string[]] $As51 = @(),
    [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Path
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $Path) {
    $Path = @(Get-ChildItem -LiteralPath $repo -Recurse -File -Filter *.ps1 |
            Where-Object { $_.FullName -notmatch '[\\/](\.git|node_modules|vendor)[\\/]' } |
            Where-Object { $_.FullName -ne $PSCommandPath } |
            ForEach-Object { $_.FullName })
}

$natives = 'git', 'ssh', 'php', 'docker', 'npm', 'npx', 'node', 'just', 'curl', 'tar', 'robocopy', 'python', 'uv', 'gh', 'claude', 'pwsh', 'powershell', 'where', 'sort', 'winget', 'java', 'javac', 'dotnet', 'composer', 'scp', 'plink'
$findings = New-Object System.Collections.Generic.List[string]

function Add-Finding([string] $file, [int] $line, [string] $rule, [string] $text) {
    $rel = $file.Replace($repo + '\', '').Replace($repo + '/', '')
    $findings.Add(('{0}:{1}  {2}  {3}' -f $rel, $line, $rule, $text.Trim()))
}

$ps51 = Get-Command powershell.exe -ErrorAction SilentlyContinue
$as51Full = @($As51 | Where-Object { $_ } | ForEach-Object { (Resolve-Path -LiteralPath $_).ProviderPath })

foreach ($file in $Path) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Add-Finding $file 0 'MISSING_FILE' 'no such file - nothing scanned'
        continue
    }
    # Test-Path resolves against PowerShell's location, [IO.File] against the process's - they
    # differ after a Set-Location, so hand [IO.File] the absolute path.
    $file = (Resolve-Path -LiteralPath $file).ProviderPath
    # A file that must run on 5.1 also gets the 5.1-only rules and the real 5.1 parser.
    $is51 = (((Split-Path -Leaf $file) -eq 'initial-setup.ps1') -and ((Split-Path -Parent $file) -eq $repo)) -or ($as51Full -contains $file)
    $bytes = [IO.File]::ReadAllBytes($file)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Add-Finding $file 1 'FILE_BOM' 'file starts with a UTF-8 BOM'
    }
    $lines = [IO.File]::ReadAllLines($file)
    $inBlock = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]; $n = $i + 1
        # Skip <# ... #> comment blocks (help text) and whole-line # comments.
        if ($inBlock) { if ($l -match '#>') { $inBlock = $false }; continue }
        if ($l -match '^\s*<#') { if ($l -notmatch '#>') { $inBlock = $true }; continue }
        if ($l.TrimStart().StartsWith('#')) { continue }
        $m = [regex]::Match($l, '(?i)^\s*function\s+(?:global:|script:|local:|private:)?([\w-]+)')
        if ($m.Success -and ($natives -contains $m.Groups[1].Value.ToLower())) { Add-Finding $file $n 'NATIVE_SHADOW' $l }
        # -Encoding utf8BOM writes a BOM on both engines; plain UTF8 writes one only on 5.1
        # (pwsh 7's utf8 is BOM-less). Never flags utf8NoBOM.
        $encRe = '(?i)((Out-File|Set-Content|Add-Content)\b.*-Encoding[:\s]\s*|\bEncoding\s*=\s*)[''"]?({0})(?![\w])'
        if ($l -match ($encRe -f 'UTF8BOM')) { Add-Finding $file $n 'BOM_WRITE' $l }
        elseif ($is51 -and ($l -match ($encRe -f 'UTF8'))) { Add-Finding $file $n 'BOM_WRITE' $l }
        # [IO.File]::WriteAllText($p, $t, [Text.Encoding]::UTF8) also writes EF BB BF on both shells.
        elseif ($l -match '(?i)\[(System\.)?Text\.Encoding\]::UTF8\b(?!\s*\.\s*Get(Bytes|String|ByteCount|CharCount|Chars)\b)') { Add-Finding $file $n 'BOM_WRITE' $l }
        if ($l -match 'ConvertTo-Json(?![^|]*-Depth)') { Add-Finding $file $n 'JSON_DEPTH' $l }
        # 5.1 reads a BOM-less file as the ANSI code page: non-ASCII there is mojibake or a parse error.
        if ($is51 -and ($l -match '[^\x00-\x7F]')) { Add-Finding $file $n 'NON_ASCII' $l }
        # A Verb-Noun cmdlet right after if/elseif ( followed by -and/-or, allowing one level of
        # nested parentheses in its arguments: if (Test-Path (Join-Path $a 'x') -and $b).
        if ($l -match '(?i)\b(if|elseif)\s*\(\s*[a-z]+-[a-z]\w*\b(?:[^()]|\([^()]*\))*?\s-(and|or)\b') { Add-Finding $file $n 'UNPAREN_LOGIC' $l }
        if ($l -match '(?i)C:[\\/]Users[\\/](?!Public)[A-Za-z]') { Add-Finding $file $n 'PERSONAL_PATH' $l }
    }

    # Ask the REAL 5.1 parser, not a regex. ParseFile only parses - it never runs the file. The
    # path travels in an environment variable on purpose: with -Command, extra arguments are
    # APPENDED to the command text, so passing the path as an argument EXECUTES the file being
    # checked (it did, once, while this scanner was written).
    if ($is51) {
        if (-not $ps51) {
            Add-Finding $file 0 'PS51_PARSE' 'UNVERIFIED - powershell.exe (5.1) not on PATH'
        } else {
            $probe = '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS_SCAN_51_FILE, [ref]$null, [ref]$e); foreach ($x in $e) { "{0}: {1}" -f $x.Extent.StartLineNumber, $x.Message }'
            $env:PS_SCAN_51_FILE = $file
            $out = & powershell.exe -NoProfile -NonInteractive -Command $probe 2>&1
            Remove-Item Env:PS_SCAN_51_FILE -ErrorAction SilentlyContinue
            foreach ($o in @($out)) {
                $s = "$o"
                if ($s -match '^(\d+): (.*)$') { Add-Finding $file ([int]$Matches[1]) 'PS51_PARSE' $Matches[2] }
                elseif ($s.Trim()) { Add-Finding $file 0 'PS51_PARSE' $s }
            }
        }
    }
}

Write-Host ("scanned {0} file(s), {1} finding(s)" -f @($Path).Count, $findings.Count)
$findings | ForEach-Object { Write-Host "  $_" }
if ($findings.Count -gt 0) { exit 1 }
exit 0
