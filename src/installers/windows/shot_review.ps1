# The review page is taller than its box, and the section the operator
# called badly formatted (TRUST AND SECURITY) is below the fold. So:
# page down through the rich edit and capture each screenful.
#
# Only the installer's own window rectangle is captured, never the
# desktop. Nothing is installed -- the process is killed on the review
# page, before Install is ever pressed.
param([string]$Exe, [string]$Dir, [int]$Pages = 8)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$p = Start-Process -FilePath $Exe -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $p.Refresh()
  if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle; break }
}
if ($h -eq [IntPtr]::Zero) { "no window" | Out-File "$Dir\err.txt"; $p.Kill(); exit 1 }
Start-Sleep -Seconds 3
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 700

# The rich edit, by class name, so the log says what was actually found.
$rich = [IntPtr]::Zero
$names = New-Object System.Collections.ArrayList
$cb = [W+EnumProc]{
  param($c, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetClassName($c, $sb, 256)
  [void]$names.Add($sb.ToString())
  if ($sb.ToString() -like "RichEdit*" -and $script:rich -eq [IntPtr]::Zero) { $script:rich = $c }
  return $true
}
[void][W]::EnumChildWindows($h, $cb, [IntPtr]::Zero)
($names -join ", ") | Out-File "$Dir\classes.txt"

function Shot($n) {
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc(); [void][W]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save("$Dir\page$n.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Shot 0
if ($rich -ne [IntPtr]::Zero) {
  for ($n = 1; $n -lt $Pages; $n++) {
    # WM_VSCROLL, SB_PAGEDOWN
    [void][W]::SendMessage($rich, 0x0115, [IntPtr]3, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 500
    Shot $n
  }
} else { "no rich edit found" | Out-File "$Dir\err.txt" }
Start-Sleep -Milliseconds 300
try { $p.Kill() } catch {}
"done" | Out-File "$Dir\done.txt"
