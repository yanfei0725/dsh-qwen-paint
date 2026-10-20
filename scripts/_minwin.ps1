# Minimize the console window after launch.
#
# 2026-10-09: called as a standalone file from .cmd, to avoid the
#   "nested PowerShell quoting inside .cmd" trap.
#
# Lessons from four failed attempts (all measured, kept here so we do not repeat them):
#   1. Do NOT use here-string @'...'@ -- it requires the terminator at column 0
#      AND CRLF line endings. This project writes LF, so the parser treated
#      [DllImport(...)] as a bare expression -> syntax error.
#   2. (Get-Process cmd).MainWindowHandle does NOT find the console window:
#      in a cmd that really had a window it still returned 0. Console windows are
#      owned by conhost / Windows Terminal, not by the cmd.exe process, so
#      looking them up by process name always fails.
#   3. Do NOT hand-write EnumWindows delegates -- that code is itself a syntax
#      risk and produced ParserError (UnexpectedToken). Prefer simple APIs.
#   4. THIS FILE MUST STAY PURE ASCII. PowerShell 5.1 reads .ps1 as ANSI unless a
#      BOM is present; UTF-8 Chinese comments without BOM corrupt the parse and
#      surface as bogus "unexpected token }" errors on unrelated lines.
#      That was the actual root cause of the earlier failures.
#
# Working approach: FindWindow with a fixed Win32 class name and $null title.

$sig = @(
  '[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();'
) -join [Environment]::NewLine

$api = Add-Type -MemberDefinition $sig -Name 'WinApi' -Namespace 'DshqpHelp' -PassThru

$hwnd = [IntPtr]::Zero

# Route 1: we have our own console (when powershell is invoked directly)
$own = $api::GetConsoleWindow()
if ($own -ne [IntPtr]::Zero) { $hwnd = $own }

# Route 2: classic conhost console window
if ($hwnd -eq [IntPtr]::Zero) {
  $h = $api::FindWindow('ConsoleWindowClass', $null)
  if ($h -ne [IntPtr]::Zero) {
    if ($api::IsWindowVisible($h)) { $hwnd = $h }
  }
}

# Route 3: Windows Terminal (default host on Win11)
if ($hwnd -eq [IntPtr]::Zero) {
  $h = $api::FindWindow('CASCADIA_HOSTING_WINDOW_CLASS', $null)
  if ($h -ne [IntPtr]::Zero) {
    if ($api::IsWindowVisible($h)) { $hwnd = $h }
  }
}

$outFile = Join-Path $PSScriptRoot '_minwin_result.txt'

if ($hwnd -ne [IntPtr]::Zero) {
  # 6 = SW_MINIMIZE (collapse to taskbar; user can click it to read logs if needed)
  $null = $api::ShowWindow($hwnd, 6)
  "MINIMIZED_OK hwnd=$hwnd" | Set-Content -Path $outFile
} else {
  "NO_CONSOLE_WINDOW" | Set-Content -Path $outFile
}
