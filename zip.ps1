# ReviewForMD Chrome / Firefox パッケージ生成スクリプト (Windows PowerShell版)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir "temp-build"))
$chromeDir = Join-Path $buildRoot "chrome"
$firefoxDir = Join-Path $buildRoot "firefox"
$chromeArchive = Join-Path $scriptDir "ReviewForMD.zip"
$firefoxArchive = Join-Path $scriptDir "ReviewForMD-firefox.zip"

if ([IO.Path]::GetDirectoryName($buildRoot) -ne $scriptDir -or [IO.Path]::GetFileName($buildRoot) -ne "temp-build") {
    throw "一時ディレクトリがリポジトリ直下の temp-build ではありません: $buildRoot"
}

Write-Host "Chrome / Firefox 拡張機能パッケージを生成中..." -ForegroundColor Cyan

foreach ($archive in @($chromeArchive, $firefoxArchive)) {
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
}
if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
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
            Remove-Item -Recurse -Force
    }

    Compress-Archive -Path (Join-Path $chromeDir "*") -DestinationPath $chromeArchive -Force
    Compress-Archive -Path (Join-Path $firefoxDir "*") -DestinationPath $firefoxArchive -Force
} finally {
    if (Test-Path -LiteralPath $buildRoot) {
        Remove-Item -LiteralPath $buildRoot -Recurse -Force
    }
}

foreach ($archive in @($chromeArchive, $firefoxArchive)) {
    if (-not (Test-Path -LiteralPath $archive)) {
        throw "ZIPファイルの作成に失敗しました: $archive"
    }
    $sizeKb = [math]::Round((Get-Item -LiteralPath $archive).Length / 1KB, 2)
    Write-Host "作成: $archive ($sizeKb KB)" -ForegroundColor Green
}
