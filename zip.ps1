# ReviewForMD Chrome / Firefox パッケージ生成スクリプト (Windows PowerShell版)


# 検証済みの作業対象だけを標準APIで削除する。
function Remove-LocalWorkItem {
    param([string[]]$LiteralPath, [string]$AllowedRoot, [switch]$IgnoreMissing, [switch]$AllowLeafJunction)
    if ([string]::IsNullOrWhiteSpace($AllowedRoot) -or -not [IO.Path]::IsPathRooted($AllowedRoot)) { throw 'Cleanup root must be absolute.' }
    $boundary = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    foreach ($target in $LiteralPath) {
        if ([string]::IsNullOrWhiteSpace($target) -or -not [IO.Path]::IsPathRooted($target)) { throw 'Cleanup target must be absolute.' }
        $resolved = [IO.Path]::GetFullPath($target)
        if (-not $resolved.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup target is outside the allowed root.' }
        $ancestor = $resolved
        while ($ancestor) {
            if (Test-Path -LiteralPath $ancestor) {
                $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not ($AllowLeafJunction -and $ancestor -eq $resolved -and $item.LinkType -eq 'Junction')) { throw 'Cleanup path contains a reparse point.' }
            }
            $ancestor = Split-Path $ancestor -Parent
        }
        if (-not (Test-Path -LiteralPath $resolved)) { if ($IgnoreMissing) { continue }; throw "Cleanup target is missing: $resolved" }
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        $leafLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        if ($item.PSIsContainer -and -not $leafLink) {
            if (@(Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Cleanup directory contains a reparse point.' }
        }
        Remove-Item -LiteralPath $resolved -Recurse:($item.PSIsContainer -and -not $leafLink) -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $resolved) { throw "Cleanup target remains: $resolved" }
    }
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$tempRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir "temp-build"))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot "package"))
$chromeDir = Join-Path $buildRoot "chrome"
$firefoxDir = Join-Path $buildRoot "firefox"
$chromeArchive = Join-Path $scriptDir "ReviewForMD.zip"
$firefoxArchive = Join-Path $scriptDir "ReviewForMD-firefox.zip"

if ([IO.Path]::GetDirectoryName($tempRoot) -ne $scriptDir -or [IO.Path]::GetDirectoryName($buildRoot) -ne $tempRoot -or [IO.Path]::GetFileName($buildRoot) -ne "package") {
    throw "梱包ディレクトリがリポジトリ直下の temp-build/package ではありません: $buildRoot"
}

Write-Host "Chrome / Firefox 拡張機能パッケージを生成中..." -ForegroundColor Cyan

foreach ($archive in @($chromeArchive, $firefoxArchive)) {
    if (Test-Path -LiteralPath $archive) {
         Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($archive)) -AllowedRoot $PSScriptRoot
    }
}
if (Test-Path -LiteralPath $buildRoot) {
     Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($buildRoot)) -AllowedRoot $PSScriptRoot
}

try {
    foreach ($directory in @($chromeDir, $firefoxDir)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $scriptDir "src") -Destination $directory -Recurse
        Copy-Item -LiteralPath (Join-Path $scriptDir "icons") -Destination $directory -Recurse
    }

    Copy-Item -LiteralPath (Join-Path $scriptDir "manifest.json") -Destination (Join-Path $chromeDir "manifest.json")
    & node (Join-Path $scriptDir "scripts\create-firefox-manifest.mjs") `
        (Join-Path $scriptDir "manifest.json") `
        (Join-Path $firefoxDir "manifest.json")
    if ($LASTEXITCODE -ne 0) {
        throw "Firefox manifest の生成に失敗しました"
    }

    foreach ($directory in @($chromeDir, $firefoxDir)) {
        Get-ChildItem -LiteralPath $directory -Recurse -Force |
            Where-Object { $_.Name -eq ".DS_Store" -or $_.Name -like ".env*" -or $_.Name -like "*.env" -or $_.Name -like "*.swp" -or $_.Name -like "*~" } |
            Sort-Object FullName -Descending |
            ForEach-Object {  Remove-LocalWorkItem -LiteralPath $_.FullName -AllowedRoot $PSScriptRoot -IgnoreMissing }
    }

    Compress-Archive -Path (Join-Path $chromeDir "*") -DestinationPath $chromeArchive -Force
    Compress-Archive -Path (Join-Path $firefoxDir "*") -DestinationPath $firefoxArchive -Force
} finally {
    if (Test-Path -LiteralPath $buildRoot) {
         Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($buildRoot)) -AllowedRoot $PSScriptRoot
    }
}

foreach ($archive in @($chromeArchive, $firefoxArchive)) {
    if (-not (Test-Path -LiteralPath $archive)) {
        throw "ZIPファイルの作成に失敗しました: $archive"
    }
    $sizeKb = [math]::Round((Get-Item -LiteralPath $archive).Length / 1KB, 2)
    Write-Host "作成: $archive ($sizeKb KB)" -ForegroundColor Green
}
