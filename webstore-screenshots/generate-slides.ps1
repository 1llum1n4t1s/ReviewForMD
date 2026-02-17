Add-Type -AssemblyName System.Drawing

$W = 1280
$H = 800

# Colors
$green   = [System.Drawing.Color]::FromArgb(45, 164, 78)    # #2DA44E
$darkBg  = [System.Drawing.Color]::FromArgb(36, 41, 47)     # #24292F
$white   = [System.Drawing.Color]::White
$lightBg = [System.Drawing.Color]::FromArgb(246, 248, 250)  # #F6F8FA
$gray    = [System.Drawing.Color]::FromArgb(87, 96, 106)    # #57606A
$blue    = [System.Drawing.Color]::FromArgb(0, 120, 212)    # #0078D4

$fontTitle   = New-Object System.Drawing.Font("Segoe UI", 42, [System.Drawing.FontStyle]::Bold)
$fontSub     = New-Object System.Drawing.Font("Segoe UI", 22, [System.Drawing.FontStyle]::Regular)
$fontHeading = New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Bold)
$fontBody    = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Regular)
$fontSmall   = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Regular)
$fontCode    = New-Object System.Drawing.Font("Consolas", 16, [System.Drawing.FontStyle]::Regular)
$fontIcon    = New-Object System.Drawing.Font("Segoe UI", 36, [System.Drawing.FontStyle]::Bold)
$fontNum     = New-Object System.Drawing.Font("Segoe UI", 48, [System.Drawing.FontStyle]::Bold)

$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center

$sfLeft = New-Object System.Drawing.StringFormat
$sfLeft.Alignment = [System.Drawing.StringAlignment]::Near
$sfLeft.LineAlignment = [System.Drawing.StringAlignment]::Center

# ============================================================
# Screenshot 02 - Copy Demo
# ============================================================
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

# Background: white
$g.Clear($white)

# Top green bar
$g.FillRectangle((New-Object System.Drawing.SolidBrush($green)), 0, 0, $W, 160)
$g.DrawString("Markdown", $fontTitle, (New-Object System.Drawing.SolidBrush($white)), [System.Drawing.RectangleF]::new(0, 20, $W, 70), $sf)
$g.DrawString([char]0x2192 + " Clipboard", $fontSub, (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 255, 255, 255))), [System.Drawing.RectangleF]::new(0, 90, $W, 50), $sf)

# Left side - Before (PR page mockup)
$leftX = 60
$mockY = 200
$g.FillRectangle((New-Object System.Drawing.SolidBrush($lightBg)), $leftX, $mockY, 520, 340)
$g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(208, 215, 222), 2)), $leftX, $mockY, 520, 340)

$g.DrawString("Pull Request #42", $fontHeading, (New-Object System.Drawing.SolidBrush($darkBg)), ($leftX + 20), ($mockY + 20))

# Comment boxes
$commentY = $mockY + 80
foreach ($text in @("reviewer1: LGTM!", "reviewer2: Approved")) {
    $g.FillRectangle((New-Object System.Drawing.SolidBrush($white)), ($leftX + 20), $commentY, 480, 50)
    $g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(208, 215, 222), 1)), ($leftX + 20), $commentY, 480, 50)
    $g.DrawString($text, $fontSmall, (New-Object System.Drawing.SolidBrush($gray)), [System.Drawing.RectangleF]::new(($leftX + 30), $commentY, 460, 50), $sfLeft)
    $commentY += 70
}

# Green button mockup
$g.FillRectangle((New-Object System.Drawing.SolidBrush($green)), ($leftX + 20), ($commentY + 20), 200, 45)
$roundBrush = New-Object System.Drawing.SolidBrush($white)
$g.DrawString([char]0x2714 + " Copy All as MD", $fontSmall, $roundBrush, [System.Drawing.RectangleF]::new(($leftX + 20), ($commentY + 20), 200, 45), $sf)

# Arrow in the middle
$arrowBrush = New-Object System.Drawing.SolidBrush($green)
$g.DrawString([char]0x27A1, (New-Object System.Drawing.Font("Segoe UI Symbol", 60, [System.Drawing.FontStyle]::Bold)), $arrowBrush, [System.Drawing.RectangleF]::new(580, 300, 120, 100), $sf)

# Right side - Markdown output
$rightX = 700
$g.FillRectangle((New-Object System.Drawing.SolidBrush($darkBg)), $rightX, $mockY, 520, 340)

$mdLines = @(
    "# PR #42 Fix auth bug",
    "",
    "## Body",
    "Updated login flow...",
    "",
    "## Review Comments",
    "### Comment 1",
    "**Author:** reviewer1",
    "> LGTM!"
)
$lineY = $mockY + 15
foreach ($line in $mdLines) {
    $c = if ($line.StartsWith("#")) { [System.Drawing.Color]::FromArgb(130, 200, 255) } else { [System.Drawing.Color]::FromArgb(200, 200, 200) }
    $f = if ($line.StartsWith("#")) { $fontSmall } else { $fontCode }
    $g.DrawString($line, $f, (New-Object System.Drawing.SolidBrush($c)), ($rightX + 20), $lineY)
    $lineY += 30
}

# Bottom tagline
$g.DrawString("PR + Review Comments", $fontHeading, (New-Object System.Drawing.SolidBrush($darkBg)), [System.Drawing.RectangleF]::new(0, 580, $W, 50), $sf)
$g.DrawString([char]0x2192 + " Clean Markdown", $fontHeading, (New-Object System.Drawing.SolidBrush($green)), [System.Drawing.RectangleF]::new(0, 630, $W, 50), $sf)

# Footer
$g.DrawString("github.com/1llum1n4t1s/ReviewForMD", $fontSmall, (New-Object System.Drawing.SolidBrush($gray)), [System.Drawing.RectangleF]::new(0, 740, $W, 40), $sf)

$g.Dispose()
$bmp.Save("C:\Users\szk\Work\ReviewForMD\webstore-screenshots\screenshot-02-copy-success.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "screenshot-02 saved"

# ============================================================
# Screenshot 03 - Platform Support
# ============================================================
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$g.Clear($white)

# Top bar
$g.FillRectangle((New-Object System.Drawing.SolidBrush($darkBg)), 0, 0, $W, 160)
$g.DrawString("Multi-Platform", $fontTitle, (New-Object System.Drawing.SolidBrush($white)), [System.Drawing.RectangleF]::new(0, 20, $W, 70), $sf)
$g.DrawString("GitHub & Azure DevOps", $fontSub, (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 200, 200))), [System.Drawing.RectangleF]::new(0, 90, $W, 50), $sf)

# GitHub card
$cardW = 480
$cardH = 350
$cardY = 220

$g.FillRectangle((New-Object System.Drawing.SolidBrush($lightBg)), 80, $cardY, $cardW, $cardH)
$g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(208, 215, 222), 2)), 80, $cardY, $cardW, $cardH)

# GitHub icon circle
$circleX = 80 + ($cardW / 2) - 40
$g.FillEllipse((New-Object System.Drawing.SolidBrush($darkBg)), $circleX, ($cardY + 30), 80, 80)
$g.DrawString("GH", (New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Bold)), (New-Object System.Drawing.SolidBrush($white)), [System.Drawing.RectangleF]::new($circleX, ($cardY + 30), 80, 80), $sf)

$g.DrawString("GitHub", $fontHeading, (New-Object System.Drawing.SolidBrush($darkBg)), [System.Drawing.RectangleF]::new(80, ($cardY + 130), $cardW, 40), $sf)

$ghFeatures = @("github.com", "GitHub Enterprise")
$fY = $cardY + 190
foreach ($feat in $ghFeatures) {
    $g.DrawString([char]0x2713 + " " + $feat, $fontBody, (New-Object System.Drawing.SolidBrush($gray)), [System.Drawing.RectangleF]::new(160, $fY, 320, 40), $sfLeft)
    $fY += 50
}

# Azure DevOps card
$g.FillRectangle((New-Object System.Drawing.SolidBrush($lightBg)), 720, $cardY, $cardW, $cardH)
$g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(208, 215, 222), 2)), 720, $cardY, $cardW, $cardH)

$circleX2 = 720 + ($cardW / 2) - 40
$g.FillEllipse((New-Object System.Drawing.SolidBrush($blue)), $circleX2, ($cardY + 30), 80, 80)
$g.DrawString("AD", (New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Bold)), (New-Object System.Drawing.SolidBrush($white)), [System.Drawing.RectangleF]::new($circleX2, ($cardY + 30), 80, 80), $sf)

$g.DrawString("Azure DevOps", $fontHeading, (New-Object System.Drawing.SolidBrush($darkBg)), [System.Drawing.RectangleF]::new(720, ($cardY + 130), $cardW, 40), $sf)

$adFeatures = @("dev.azure.com", "*.visualstudio.com", "Custom Domain")
$fY = $cardY + 190
foreach ($feat in $adFeatures) {
    $g.DrawString([char]0x2713 + " " + $feat, $fontBody, (New-Object System.Drawing.SolidBrush($gray)), [System.Drawing.RectangleF]::new(800, $fY, 320, 40), $sfLeft)
    $fY += 50
}

# Footer
$g.DrawString("github.com/1llum1n4t1s/ReviewForMD", $fontSmall, (New-Object System.Drawing.SolidBrush($gray)), [System.Drawing.RectangleF]::new(0, 740, $W, 40), $sf)

$g.Dispose()
$bmp.Save("C:\Users\szk\Work\ReviewForMD\webstore-screenshots\screenshot-03-popup.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "screenshot-03 saved"

# ============================================================
# Screenshot 04 - Features Overview
# ============================================================
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$g.Clear($white)

# Top bar
$g.FillRectangle((New-Object System.Drawing.SolidBrush($green)), 0, 0, $W, 140)
$g.DrawString("Features", $fontTitle, (New-Object System.Drawing.SolidBrush($white)), [System.Drawing.RectangleF]::new(0, 30, $W, 80), $sf)

# 4 feature cards in 2x2 grid
$features = @(
    @{ num = "1"; title = "One-Click Copy"; desc = "Copy all PR reviews`nwith a single button" },
    @{ num = "2"; title = "Markdown Output"; desc = "Clean, structured MD`nready to paste anywhere" },
    @{ num = "3"; title = "Multi-Platform"; desc = "GitHub & Azure DevOps`nincl. custom domains" },
    @{ num = "4"; title = "Per-Comment Copy"; desc = "Copy individual comments`nfor flexible use" }
)

$cW = 540
$cH = 240
$positions = @(
    @{ x = 60;  y = 190 },
    @{ x = 680; y = 190 },
    @{ x = 60;  y = 470 },
    @{ x = 680; y = 470 }
)

for ($i = 0; $i -lt 4; $i++) {
    $f = $features[$i]
    $p = $positions[$i]

    # Card background
    $g.FillRectangle((New-Object System.Drawing.SolidBrush($lightBg)), $p.x, $p.y, $cW, $cH)
    $g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(208, 215, 222), 2)), $p.x, $p.y, $cW, $cH)

    # Number circle
    $numX = $p.x + 30
    $numY = $p.y + ($cH / 2) - 35
    $g.FillEllipse((New-Object System.Drawing.SolidBrush($green)), $numX, $numY, 70, 70)
    $g.DrawString($f.num, $fontNum, (New-Object System.Drawing.SolidBrush($white)), [System.Drawing.RectangleF]::new($numX, $numY, 70, 70), $sf)

    # Title
    $g.DrawString($f.title, $fontHeading, (New-Object System.Drawing.SolidBrush($darkBg)), ($p.x + 120), ($p.y + 40))

    # Description
    $descLines = $f.desc -split "``n"
    $dY = $p.y + 100
    foreach ($dl in $descLines) {
        $g.DrawString($dl, $fontBody, (New-Object System.Drawing.SolidBrush($gray)), ($p.x + 120), $dY)
        $dY += 35
    }
}

# Footer
$g.DrawString("Free & Open Source  |  github.com/1llum1n4t1s/ReviewForMD", $fontSmall, (New-Object System.Drawing.SolidBrush($gray)), [System.Drawing.RectangleF]::new(0, 740, $W, 40), $sf)

$g.Dispose()
$bmp.Save("C:\Users\szk\Work\ReviewForMD\webstore-screenshots\screenshot-04-features.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "screenshot-04 saved"

Write-Host "All slides generated!"
