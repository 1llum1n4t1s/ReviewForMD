# Web Loading Assist拡張機能パッケージ生成スクリプト (Windows PowerShell版)

Write-Host "拡張機能パッケージを生成中..." -ForegroundColor Cyan
Write-Host ""

# スクリプトのディレクトリをカレントディレクトリに設定
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# 古いZIPファイルを削除
if (Test-Path "WebLoadingAssist.zip") {
    Remove-Item "WebLoadingAssist.zip" -Force
    Write-Host "既存のZIPファイルを削除しました" -ForegroundColor Yellow
}

# 一時ディレクトリを作成
$tempDir = "temp-build"
if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

# 必要なファイルをコピー
Write-Host "必要なファイルをコピー中..." -ForegroundColor Yellow

Copy-Item "manifest.json" -Destination $tempDir
Copy-Item "src" -Destination $tempDir -Recurse
Copy-Item "icons" -Destination $tempDir -Recurse

# 不要なファイルを除外
Get-ChildItem -Path $tempDir -Recurse -Include "*.DS_Store", "*.swp", "*~" | Remove-Item -Force

# ZIPファイルを作成
Write-Host "ZIPファイルを作成中..." -ForegroundColor Cyan
Compress-Archive -Path "$tempDir/*" -DestinationPath "WebLoadingAssist.zip" -Force

# 一時ディレクトリを削除
Remove-Item $tempDir -Recurse -Force

if (Test-Path "WebLoadingAssist.zip") {
    Write-Host "ZIPファイルを作成しました: WebLoadingAssist.zip" -ForegroundColor Green
    Write-Host ""
    Write-Host "ファイルサイズ:" -ForegroundColor Cyan
    $fileSize = (Get-Item "WebLoadingAssist.zip").Length
    $fileSizeMB = [math]::Round($fileSize / 1MB, 2)
    Write-Host "   $fileSizeMB MB" -ForegroundColor White
    Write-Host ""
    Write-Host "パッケージが正常に作成されました!" -ForegroundColor Green
} else {
    Write-Host "ZIPファイルの作成に失敗しました" -ForegroundColor Red
    exit 1
}
