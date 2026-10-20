# 验证 WMI 显存探测是否可靠（用于决定启动参数里的驻留档位）
# 输出：显卡名 + AdapterRAM 字节值 + 折算 GB + 是否为 4GB 截断特征值
Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
  ForEach-Object {
    $gb = 0
    if ($_.AdapterRAM) { $gb = [math]::Round($_.AdapterRAM / 1GB, 2) }
    $trunc = ($gb -gt 3.9 -and $gb -lt 4.2)
    Write-Output ("NAME=" + $_.Name + " | AdapterRAM=" + $_.AdapterRAM + " | GB=" + $gb + " | trunc4G=" + $trunc)
  }
