# Web Draw — 生成扩展图标 (16/48/128 PNG)
# 用法: powershell -ExecutionPolicy Bypass -File make-icons.ps1
$dir = Join-Path $PSScriptRoot "icons"
New-Item -ItemType Directory -Force $dir | Out-Null

Add-Type -AssemblyName System.Drawing

foreach ($s in @(16, 48, 128)) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # 蓝色圆角方块背景
  $rect = New-Object System.Drawing.RectangleF([float]($s * 0.06), [float]($s * 0.06), [float]($s * 0.88), [float]($s * 0.88))
  $r = [float]($s * 0.30)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
  $path.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
  $path.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 47, 123, 255))
  $g.FillPath($brush, $path)

  # 白色笔痕(两个圆帽线段)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 255, 255), [float]($s * 0.10))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawLine($pen, [float]($s * 0.24), [float]($s * 0.70), [float]($s * 0.50), [float]($s * 0.30))
  $g.DrawLine($pen, [float]($s * 0.50), [float]($s * 0.30), [float]($s * 0.74), [float]($s * 0.62))

  $g.Dispose()
  $out = Join-Path $dir ("icon{0}.png" -f $s)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("OK: {0}" -f $out)
}
