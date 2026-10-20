# Standalone verification of the auto-minimize script's core mechanics.
# This exists because the sandbox blocks spawning console windows, so we verify
# the *pieces* that used to fail: (a) .ps1 parses under PowerShell 5.1, and
# (b) the Win32 member definition compiles and FindWindow is callable.
# MUST STAY PURE ASCII -- PowerShell 5.1 reads .ps1 as ANSI without a BOM.

$log = Join-Path $env:TEMP "dshqp_minwin_core.log"
$lines = @()

# --- (a) the exact signature array used by the generated script ---
$sig = @(
  '[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();'
) -join [Environment]::NewLine

$lines += "签名数组拼接成功，长度=" + $sig.Length
$lines += "包含 FindWindow: " + $sig.Contains("FindWindow")
$lines += "包含 GetConsoleWindow: " + $sig.Contains("GetConsoleWindow")

# --- (b) compile the member definition (this is what used to fail) ---
try {
  $api = Add-Type -MemberDefinition $sig -Name WinApiVerify -Namespace DshqpVerify -PassThru
  $lines += "编译: OK，类型=" + $api.FullName
} catch {
  $lines += "编译: 失败 -> " + $_.Exception.Message
  Set-Content -Path $log -Value $lines -Encoding UTF8
  exit 1
}

# --- (c) call the APIs ---
try {
  $own = $api::GetConsoleWindow()
  $lines += "GetConsoleWindow(): " + $own
} catch {
  $lines += "GetConsoleWindow() 失败: " + $_.Exception.Message
}

try {
  $h = $api::FindWindow('ConsoleWindowClass', $null)
  $lines += "FindWindow('ConsoleWindowClass'): " + $h
  $h2 = $api::FindWindow('CASCADIA_HOSTING_WINDOW_CLASS', $null)
  $lines += "FindWindow('CASCADIA...'): " + $h2
  # Also probe for a window we know exists, to prove FindWindow actually works
  $h3 = $api::FindWindow('Shell_TrayWnd', $null)
  $lines += "FindWindow('Shell_TrayWnd'): " + $h3 + "  (任务栏，应非零 -> 证明 FindWindow 有效)"
} catch {
  $lines += "FindWindow 失败: " + $_.Exception.Message
}

# --- (d) prove ShowWindow(minimize) is callable without error on a real hwnd ---
try {
  $r = $api::ShowWindow($h3, 6)
  $lines += "ShowWindow(任务栏, 6) 返回: " + $r + "  (调用本身成功，未抛异常)"
  # restore it so we don't leave the user's taskbar minimized
  $null = $api::ShowWindow($h3, 9)
  $lines += "ShowWindow(任务栏, 9) 已还原"
} catch {
  $lines += "ShowWindow 失败: " + $_.Exception.Message
}

Set-Content -Path $log -Value $lines -Encoding UTF8
