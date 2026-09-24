# win-tune.ps1 —— 把这台「只用来编译/跑测试」的 Windows ARM64 虚拟机瘦到最小开销。
#
# 为什么要手动跑一次：vmrun 起的进程是 **Medium 完整性**（管理员组是 deny-only），
# 停服务、改 Defender、换电源计划都要提权，而 UAC 在服务会话里只会挂着等人点。
#
# 跑法（在虚拟机控制台里，Win+X → 终端(管理员)）：
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   Z:\tools\win-tune.ps1
#
# 全部可逆：每一项都在注释里写了怎么还原。再跑一次是幂等的。

$ErrorActionPreference = 'Continue'

function Kill-Service([string]$name, [string]$why) {
  $s = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $s) { return }
  Write-Host ("[svc] {0,-16} {1}" -f $name, $why)
  Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
  Set-Service -Name $name -StartupType Disabled -ErrorAction SilentlyContinue
}

# ---- 1. 后台服务（还原：Set-Service <名字> -StartupType Automatic）----
Kill-Service WSearch      '索引：会把整棵源码树反复读一遍'
Kill-Service SysMain      'Superfetch：预读，在 4GB 机器上纯属抢内存'
Kill-Service DiagTrack    '遥测'
Kill-Service dmwappushservice '遥测推送'
Kill-Service WerSvc       '错误报告'
Kill-Service Spooler      '打印'
Kill-Service wuauserv     'Windows 更新（要装更新时再开回来）'
Kill-Service BITS         '后台传输，更新的搬运工'
Kill-Service DoSvc        '传递优化：会占网络与磁盘'
Kill-Service MapsBroker   '地图'
Kill-Service WpnService   '推送通知'
Kill-Service TabletInputService '触摸键盘'
Kill-Service RetailDemo   '零售演示'
Kill-Service Fax          '传真'
Kill-Service PhoneSvc     '电话'
Kill-Service XblAuthManager 'Xbox'
Kill-Service XblGameSave  'Xbox'
Kill-Service XboxNetApiSvc 'Xbox'
Kill-Service edgeupdate   'Edge 自动更新'
Kill-Service edgeupdatem  'Edge 自动更新'
Kill-Service MicrosoftEdgeElevationService 'Edge 提权服务'
Kill-Service CDPUserSvc   '连接设备平台'
Kill-Service OneSyncSvc   '邮件/日历同步'
Kill-Service lfsvc        '定位'
Kill-Service SensorService '传感器'
Kill-Service SharedAccess '网络共享'
Kill-Service SSDPSRV      'UPnP 发现'
Kill-Service upnphost     'UPnP 主机'
Kill-Service WbioSrvc     '生物识别'
Kill-Service SCardSvr     '智能卡'
Kill-Service TrkWks       '分布式链接跟踪：跟着文件改名写日志'
Kill-Service DPS          '诊断策略'
Kill-Service WdiSystemHost '诊断系统宿主'
Kill-Service diagnosticshub.standardcollector.service '诊断采集'
Kill-Service PcaSvc       '程序兼容助手'
Kill-Service defragsvc    '碎片整理'
Kill-Service SDRSVC       '备份'
Kill-Service swprv        '卷影复制'
Kill-Service VSS          '卷影复制'

# ---- 2. Defender：实时扫描是这台机器上最大的一块开销 ----
# 篡改保护开着时 -DisableRealtimeMonitoring 会被拒（那是设计如此），所以两手都做：
# 先加排除项（永远允许），再试着关实时扫描。
# 还原：Remove-MpPreference -ExclusionPath …；Set-MpPreference -DisableRealtimeMonitoring $false
$exPaths = @('C:\OmniVM', 'C:\nodecache', 'Z:\', 'C:\Program Files\nodejs', "$env:LOCALAPPDATA\Temp")
foreach ($p in $exPaths) {
  try { Add-MpPreference -ExclusionPath $p -ErrorAction Stop; Write-Host "[def] 排除 $p" }
  catch { Write-Host "[def] 排除 $p 失败：$($_.Exception.Message)" }
}
foreach ($p in @('node.exe', 'cmd.exe', 'tar.exe', 'git.exe')) {
  try { Add-MpPreference -ExclusionProcess $p -ErrorAction Stop; Write-Host "[def] 排除进程 $p" } catch {}
}
try {
  Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction Stop
  Write-Host '[def] 实时扫描已关'
} catch { Write-Host '[def] 关实时扫描被拒（篡改保护）——排除项已经生效，够用' }
try {
  Set-MpPreference -MAPSReporting 0 -SubmitSamplesConsent 2 -DisableBlockAtFirstSeen $true `
    -ScanScheduleDay 8 -DisableCatchupFullScan $true -DisableCatchupQuickScan $true -ErrorAction Stop
  Write-Host '[def] 云查/首见阻断/计划扫描已关'
} catch {}

# ---- 3. 计划任务：维护、碎片整理、遥测那一堆 ----
# 还原：Enable-ScheduledTask -TaskPath … -TaskName …
$taskPaths = @(
  '\Microsoft\Windows\Application Experience\',
  '\Microsoft\Windows\Customer Experience Improvement Program\',
  '\Microsoft\Windows\DiskDiagnostic\',
  '\Microsoft\Windows\Defrag\',
  '\Microsoft\Windows\Maintenance\',
  '\Microsoft\Windows\Windows Error Reporting\',
  '\Microsoft\Windows\UpdateOrchestrator\',
  '\Microsoft\Windows\WindowsUpdate\',
  '\Microsoft\Windows\Autochk\',
  '\Microsoft\Windows\Feedback\Siuf\',
  '\Microsoft\Windows\Power Efficiency Diagnostics\',
  '\Microsoft\Windows\MemoryDiagnostic\'
)
foreach ($tp in $taskPaths) {
  Get-ScheduledTask -TaskPath $tp -ErrorAction SilentlyContinue |
    ForEach-Object {
      Disable-ScheduledTask -TaskPath $_.TaskPath -TaskName $_.TaskName -ErrorAction SilentlyContinue | Out-Null
      Write-Host "[task] $($_.TaskName)"
    }
}

# ---- 4. 电源与视觉：别降频、别做动画 ----
# 还原：powercfg /s SCHEME_BALANCED
powercfg /s SCHEME_MIN 2>$null   # 高性能
powercfg /change standby-timeout-ac 0 2>$null
powercfg /change monitor-timeout-ac 0 2>$null
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects' `
  -Name VisualFXSetting -Value 2 -ErrorAction SilentlyContinue   # 2 = 最佳性能
Write-Host '[pwr] 高性能 + 不休眠 + 关动画'

# ---- 5. 文件系统：少写元数据 ----
# 还原：fsutil behavior set disablelastaccess 2
fsutil behavior set disablelastaccess 1 | Out-Null
fsutil behavior set disable8dot3 1 | Out-Null
Write-Host '[fs] 关最后访问时间 + 关 8.3 短名'

# ---- 6. 用户会话里的常驻（OneDrive / Edge 预载 / 小组件）----
foreach ($p in @('OneDrive', 'msedge', 'MicrosoftEdgeUpdate', 'Widgets', 'WidgetService',
                 'StartMenuExperienceHost', 'SearchApp', 'Teams', 'ms-teams')) {
  Get-Process -Name $p -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name OneDrive -ErrorAction SilentlyContinue
Write-Host '[usr] 关常驻 + 去掉 OneDrive 自启'

# ---- 7. node 的编译缓存：同一份源码第二次起就不重新编译 ----
[Environment]::SetEnvironmentVariable('NODE_COMPILE_CACHE', 'C:\nodecache', 'Machine')
New-Item -ItemType Directory -Force -Path C:\nodecache | Out-Null
Write-Host '[node] NODE_COMPILE_CACHE=C:\nodecache（机器级，新进程生效）'

Write-Host ''
Write-Host '完事。建议重启一次让停掉的服务彻底不起：shutdown /r /t 0'

