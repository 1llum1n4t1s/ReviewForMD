# Web Loading Assist拡張機能パッケージ生成スクリプト (Windows PowerShell版)

Write-Host "拡張機能パッケージを生成中..." -ForegroundColor Cyan
Write-Host ""

# スクリプトのディレクトリをカレントディレクトリに設定
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptDir

function Resize-Icon {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [int]$Size
    )

    try {
        $absoluteSourcePath = (Resolve-Path -Path $SourcePath -ErrorAction Stop).Path
        $absoluteDestPath = (Resolve-Path -Path (Split-Path -Parent $DestinationPath) -ErrorAction Stop).Path
        $absoluteDestinationPath = Join-Path -Path $absoluteDestPath -ChildPath (Split-Path -Leaf $DestinationPath)

        [System.Reflection.Assembly]::LoadWithPartialName("System.Drawing") | Out-Null

        $image = [System.Drawing.Image]::FromFile($absoluteSourcePath)
        $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.DrawImage($image, 0, 0, $Size, $Size)
        $bitmap.Save($absoluteDestinationPath)
        $graphics.Dispose()
        $bitmap.Dispose()
        $image.Dispose()

        return $true
    } catch {
        Write-Host "エラー: $_" -ForegroundColor Red
        return $false
    }
}

# アイコン生成
Write-Host "アイコンを生成中..." -ForegroundColor Cyan

# icons ディレクトリが存在しない場合は作成
if (-not (Test-Path "./icons")) {
    New-Item -ItemType Directory -Path "./icons" | Out-Null
}

# マスターアイコンが存在するか確認
if (-not (Test-Path "./icons/icon.png")) {
    Write-Host "マスターアイコン (icons/icon.png) が見つかりません" -ForegroundColor Red
    exit 1
}

# 必要なサイズのアイコンを生成
$sizes = @(16, 48, 128)
foreach ($size in $sizes) {
    $outputFile = "./icons/icon-${size}x${size}.png"
    $result = Resize-Icon -SourcePath "./icons/icon.png" -DestinationPath $outputFile -Size $size
    if ($result) {
        Write-Host "  $outputFile を生成しました" -ForegroundColor Green
    } else {
        Write-Host "アイコン生成に失敗しました: $outputFile" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

# 古いZIPファイルを削除
if (Test-Path "./WebLoadingAssist.zip") {
    Remove-Item "./WebLoadingAssist.zip" -Force
    Write-Host "既存のZIPファイルを削除しました" -ForegroundColor Yellow
}

# 一時ディレクトリを作成
$tempDir = "./temp-build"
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
Compress-Archive -Path "$tempDir/*" -DestinationPath "./WebLoadingAssist.zip" -Force

# 一時ディレクトリを削除
Remove-Item $tempDir -Recurse -Force

if (Test-Path "./WebLoadingAssist.zip") {
    Write-Host "ZIPファイルを作成しました: WebLoadingAssist.zip" -ForegroundColor Green
    Write-Host ""
    Write-Host "ファイルサイズ:" -ForegroundColor Cyan
    $fileSize = (Get-Item "./WebLoadingAssist.zip").Length
    $fileSizeMB = [math]::Round($fileSize / 1MB, 2)
    Write-Host "   $fileSizeMB MB" -ForegroundColor White
    Write-Host ""
    Write-Host "パッケージが正常に作成されました!" -ForegroundColor Green
    Pop-Location
} else {
    Write-Host "ZIPファイルの作成に失敗しました" -ForegroundColor Red
    Pop-Location
    exit 1
}