# win-slim.ps1 —— 把这台只用来编译/跑测试的 Windows ARM64 虚拟机的**磁盘占用**压到最小。
#
# 和 win-tune.ps1 的分工：那份只停服务、调电源，全部可逆；这份会**卸组件、删文件**，
# 其中 DISM /ResetBase、卸 Edge、删 WinRE 属于不可逆（要还原就得重装或回滚整台机器）。
#
# 保底不动的东西（脚本里没有一行碰它们）：
#   explorer / DWM / Themes（UI）、Dhcp / Dnscache / NlaSvc / netprofm / LanmanWorkstation（网络与 Z: 盘）
#   VMTools（vmrun 的 VMCI 通道，断了就只能从控制台操作）、sshd（你手工进来的那条路）
#   CryptSvc / KeyIso / VaultSvc（凭据，SSH 与 SMB 认证要）、Winmgmt（脚本里的 WMI 查询要）
#   BFE / mpssvc（防火墙）、Program Files\nodejs
#
# 跑法：在 SSH 会话里（sshd 给管理员的是未过滤的 High 令牌，够用）：
#   powershell -nop -ExecutionPolicy Bypass -File C:\Users\clover\win-slim.ps1
# 或者从控制台的「终端(管理员)」跑 Z:\tools\win-slim.ps1。
#
# 耗时以 CompactOS 那步为主，整趟大概 20~50 分钟。日志：C:\Users\clover\win-slim.log

$ErrorActionPreference = 'Continue'
Start-Transcript -Path 'C:\Users\clover\win-slim.log' -Force | Out-Null

function Used() { return [math]::Round((Get-PSDrive C).Used / 1GB, 2) }
function Step([string]$label) {
  $script:mark = Used
  Write-Host ("=== {0}  (当前 {1}GB)" -f $label, $script:mark)
}
function Done() {
  $d = [math]::Round(($script:mark - (Used)) * 1024)
  Write-Host ("    省下 {0}MB，现在 {1}GB" -f $d, (Used))
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '这个令牌不是管理员（High）。vmrun 起的进程就是这样，请从 SSH 或控制台的管理员终端跑。'
  Stop-Transcript | Out-Null
  exit 1
}
Write-Host ("开工，C: 已用 {0}GB，剩 {1}GB" -f (Used), [math]::Round((Get-PSDrive C).Free / 1GB, 2))

# ---- 1. Edge / WebView2 / EdgeUpdate：Program Files (x86) 里最大的一块（约 5GB）----
# 代价：机器里就没浏览器了，依赖 WebView2 的小组件、部分设置页会打不开。测试机不需要。
Step 'Edge 与 WebView2'
foreach ($svc in 'edgeupdate', 'edgeupdatem', 'MicrosoftEdgeElevationService') {
  Stop-Service $svc -Force -EA SilentlyContinue
  Set-Service $svc -StartupType Disabled -EA SilentlyContinue
}
Get-Process msedge, msedgewebview2, MicrosoftEdgeUpdate -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
$setups = @(
  @{ root = 'C:\Program Files (x86)\Microsoft\Edge\Application'; extra = @() },
  @{ root = 'C:\Program Files (x86)\Microsoft\EdgeCore'; extra = @() },
  @{ root = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'; extra = @('--msedgewebview') }
)
foreach ($s in $setups) {
  Get-ChildItem -LiteralPath $s.root -Recurse -Filter setup.exe -EA SilentlyContinue | ForEach-Object {
    $uargs = @('--uninstall', '--system-level', '--force-uninstall') + $s.extra
    Write-Host ("    " + $_.FullName + " " + ($uargs -join ' '))
    & $_.FullName @uargs 2>&1 | Out-Null
  }
}
& 'C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe' /uninstall 2>&1 | Out-Null
Start-Sleep 5
Remove-Item 'C:\Program Files (x86)\Microsoft\Edge*' -Recurse -Force -EA SilentlyContinue
Remove-Item 'C:\Users\clover\AppData\Local\Microsoft\Edge*' -Recurse -Force -EA SilentlyContinue
Remove-Item 'C:\ProgramData\Microsoft\EdgeUpdate' -Recurse -Force -EA SilentlyContinue
Done
# ---- 2. 商店应用：白名单以外全删（用户已装 + 系统预置两份）----
# 白名单是壳与运行库：少了它们开始菜单、设置、任务栏会残。Explorer 本身不是 appx，不受影响。
Step '商店应用'
$keep = @(
  'Microsoft.VCLibs', 'Microsoft.NET.Native', 'Microsoft.UI.Xaml', 'Microsoft.WindowsAppRuntime',
  'Microsoft.WindowsTerminal', 'MicrosoftWindows.Client', 'Microsoft.Windows.ShellExperienceHost',
  'Microsoft.Windows.StartMenuExperienceHost', 'Microsoft.Windows.Search',
  'windows.immersivecontrolpanel', 'Microsoft.AAD.BrokerPlugin', 'Microsoft.AccountsControl',
  'Microsoft.CredDialogHost', 'Microsoft.LockApp', 'Microsoft.Win32WebViewHost',
  'Microsoft.Windows.Apprep.ChxApp', 'Microsoft.Windows.AssignedAccessLockApp',
  'Microsoft.Windows.CallingShellApp', 'Microsoft.Windows.CapturePicker',
  'Microsoft.Windows.ContentDeliveryManager', 'Microsoft.Windows.OOBENetworkConnectionFlow',
  'Microsoft.Windows.PeopleExperienceHost', 'Microsoft.Windows.PinningConfirmationDialog',
  'Microsoft.Windows.SecureAssessmentBrowser', 'Microsoft.Windows.XGpuEjectDialog',
  'Microsoft.XboxGameCallableUI', 'Windows.CBSPreview', 'Windows.PrintDialog',
  'NcsiUwpApp', 'MicrosoftWindows.UndockedDevKit', 'Microsoft.DesktopAppInstaller'
)
function Keeper($n) { foreach ($k in $keep) { if ($n -like "$k*") { return $true } }; return $false }
foreach ($p in Get-AppxPackage -AllUsers) {
  if (-not (Keeper $p.Name)) {
    Write-Host ("    - " + $p.Name)
    Remove-AppxPackage -Package $p.PackageFullName -AllUsers -EA SilentlyContinue
  }
}
foreach ($p in Get-AppxProvisionedPackage -Online) {
  if (-not (Keeper $p.DisplayName)) {
    Remove-AppxProvisionedPackage -Online -PackageName $p.PackageName -EA SilentlyContinue | Out-Null
  }
}
Done

# ---- 3. 可选功能与能力：语音、手写、OCR、人脸、WMP、远程桌面那一堆 ----
Step '可选功能'
$capDrop = 'Language.Handwriting', 'Language.OCR', 'Language.Speech', 'Language.TextToSpeech',
'Hello.Face', 'App.StepsRecorder', 'App.Support.QuickAssist', 'MathRecognizer',
'Media.WindowsMediaPlayer', 'Browser.InternetExplorer', 'Print.Fax.Scan', 'XPS.Viewer',
'App.Prints.PrintManagement', 'Microsoft.Windows.Notepad', 'Microsoft.Windows.MSPaint',
'Microsoft.Windows.PowerShell.ISE', 'Microsoft.Windows.WordPad', 'OneCoreUAP.OneSync'
foreach ($c in Get-WindowsCapability -Online | Where-Object { $_.State -eq 'Installed' }) {
  foreach ($d in $capDrop) {
    if ($c.Name -like "$d*") {
      Write-Host ("    - " + $c.Name)
      Remove-WindowsCapability -Online -Name $c.Name -EA SilentlyContinue | Out-Null
    }
  }
}
$featDrop = 'Printing-Foundation-Features', 'Printing-PrintToPDFServices-Features',
'WorkFolders-Client', 'MSRDC-Infrastructure', 'SmbDirect', 'MediaPlayback',
'WindowsMediaPlayer', 'Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform',
'HypervisorPlatform', 'Containers-DisposableClientVM', 'MicrosoftWindowsPowerShellV2Root',
'MicrosoftWindowsPowerShellV2', 'Windows-Defender-ApplicationGuard', 'Recall'
foreach ($f in $featDrop) {
  $st = Get-WindowsOptionalFeature -Online -FeatureName $f -EA SilentlyContinue
  if ($st -and $st.State -eq 'Enabled') {
    Write-Host ("    - " + $f)
    Disable-WindowsOptionalFeature -Online -FeatureName $f -NoRestart -Remove -EA SilentlyContinue | Out-Null
  }
}
Done
# ---- 4. 服务：win-tune 之外再关一批（磁盘/内存都省）----
# 这里只点名，不做扫荡；上面「保底不动」那几个不在列里。还原：Set-Service <名> -StartupType Automatic
Step '再关一批服务'
$svcDrop = 'UsoSvc', 'WaaSMedicSvc', 'InstallService', 'wisvc', 'Audiosrv', 'AudioEndpointBuilder',
'bthserv', 'BthAvctpSvc', 'BluetoothUserService', 'StiSvc', 'WiaRpc', 'PrintNotify',
'PrintWorkflowUserSvc', 'PrintDeviceConfigurationService', 'WMPNetworkSvc', 'RemoteRegistry',
'RemoteAccess', 'SessionEnv', 'TermService', 'UmRdpService', 'seclogon', 'WlanSvc', 'WwanSvc',
'icssvc', 'NcbService', 'CscService', 'WalletService', 'FrameServer', 'FrameServerMonitor',
'ScDeviceEnum', 'WFDSConMgrSvc', 'tzautoupdate', 'autotimesvc', 'GraphicsPerfSvc', 'dcsvc',
'embeddedmode', 'WEPHOSTSVC', 'SEMgrSvc', 'DusmSvc', 'DsSvc', 'PimIndexMaintenanceSvc',
'UnistoreSvc', 'UserDataSvc', 'MessagingService', 'DevicePickerUserSvc', 'DevicesFlowUserSvc',
'WinRM', 'Wecsvc', 'SensorDataService', 'SensrSvc', 'shpamsvc', 'SharedRealitySvc',
'WpcMonSvc', 'wlidsvc', 'WSearch', 'SysMain', 'DiagTrack', 'DPS', 'WdiServiceHost',
'WdiSystemHost', 'Spooler', 'Fax', 'MapsBroker', 'lfsvc', 'SCardSvr', 'WbioSrvc'
foreach ($n in $svcDrop) {
  # 用户级服务（名字带 _xxxxx 后缀的那种）要按模板名匹配
  foreach ($s in Get-Service -Name "$n*" -EA SilentlyContinue) {
    Stop-Service $s.Name -Force -EA SilentlyContinue
    Set-Service $s.Name -StartupType Disabled -EA SilentlyContinue
  }
}
Write-Host ("    停掉/禁用 " + $svcDrop.Count + " 组")
Done

# ---- 5. 恢复环境、保留存储、页面文件、系统还原 ----
Step '恢复分区与页面文件'
& reagentc.exe /disable 2>&1 | Out-String | Write-Output      # 还原：reagentc /enable（需要 Winre.wim 还在）
Remove-Item 'C:\Recovery\WindowsRE' -Recurse -Force -EA SilentlyContinue
Remove-Item 'C:\$WinREAgent' -Recurse -Force -EA SilentlyContinue
& dism.exe /Online /Set-ReservedStorageState /State:Disabled 2>&1 | Out-String | Write-Output
# 页面文件钉成 1536MB：4GB 内存 + 我们的编译进程，关掉反而容易 OOM
$cs = Get-WmiObject Win32_ComputerSystem
if ($cs.AutomaticManagedPagefile) { $cs.AutomaticManagedPagefile = $false; $cs.Put() | Out-Null }
$pf = Get-WmiObject Win32_PageFileSetting -EA SilentlyContinue
if ($pf) { $pf.InitialSize = 1536; $pf.MaximumSize = 1536; $pf.Put() | Out-Null }
else {
  Set-WmiInstance -Class Win32_PageFileSetting `
    -Arguments @{ Name = 'C:\pagefile.sys'; InitialSize = 1536; MaximumSize = 1536 } -EA SilentlyContinue | Out-Null
}
& powercfg.exe /h off
Disable-ComputerRestore -Drive 'C:\' -EA SilentlyContinue
& vssadmin.exe delete shadows /all /quiet 2>&1 | Out-String | Write-Output
Done

# ---- 6. Defender 的病毒库与扫描缓存（下次更新会重新下）----
Step 'Defender 库'
Set-MpPreference -DisableRealtimeMonitoring $true -EA SilentlyContinue
& 'C:\Program Files\Windows Defender\MpCmdRun.exe' -RemoveDefinitions -All 2>&1 | Out-Null
Remove-Item 'C:\ProgramData\Microsoft\Windows Defender\Scans\History\*' -Recurse -Force -EA SilentlyContinue
Done
# ---- 7. 缓存、日志、安装包残留 ----
Step '缓存与日志'
foreach ($p in @(
    'C:\Windows\SoftwareDistribution\Download\*',
    'C:\ProgramData\Microsoft\Windows\DeliveryOptimization\Cache\*',
    'C:\ProgramData\Package Cache\*',
    'C:\ProgramData\Microsoft\Search\Data\*',
    'C:\ProgramData\Microsoft\Windows\WER\*',
    'C:\Windows\Installer\$PatchCache$\*',
    'C:\Windows\Logs\*',
    'C:\Windows\Temp\*',
    'C:\Windows\SystemTemp\*',
    'C:\Windows\Prefetch\*',
    'C:\Windows\LiveKernelReports\*',
    'C:\Windows\Downloaded Program Files\*',
    'C:\Windows\WinSxS\Temp\*',
    'C:\Windows\WinSxS\Backup\*',
    'C:\Windows\Panther\*',
    'C:\Windows\memory.dmp',
    'C:\Windows\Minidump\*',
    'C:\Users\clover\AppData\Local\Temp\*',
    'C:\Users\clover\AppData\Local\CrashDumps\*',
    'C:\$Recycle.Bin'
  )) {
  Remove-Item -Path $p -Recurse -Force -EA SilentlyContinue
}
& wevtutil.exe el | ForEach-Object { & wevtutil.exe cl "$_" 2>$null }   # 清事件日志
Done

# ---- 8. WinSxS：清掉被取代的组件（/ResetBase 之后已装更新不能再卸载）----
Step 'WinSxS 组件清理'
& dism.exe /online /cleanup-image /startcomponentcleanup /resetbase 2>&1 | Out-String | Write-Output
Done

# ---- 9. CompactOS：把系统二进制就地压缩（可逆：compact /CompactOS:never）----
# 这是单项最大的一块，通常 2~4GB；CPU 换磁盘，测试机上值得。慢，十几到几十分钟。
Step 'CompactOS 压缩'
& compact.exe /CompactOS:always 2>&1 | Select-Object -Last 3 | Out-String | Write-Output
Done

# ---- 10. 把空闲块 retrim（宿主那边还要在 Fusion 里做一次「清理虚拟机」才收得回）----
Step 'ReTrim'
Optimize-Volume -DriveLetter C -ReTrim -EA SilentlyContinue
Done

Write-Host ''
Write-Host ("收工：C: 已用 {0}GB，剩 {1}GB" -f (Used), [math]::Round((Get-PSDrive C).Free / 1GB, 2))
Write-Host '建议重启一次：shutdown /r /t 0。重启后确认 UI、网络、Z: 盘、node 都还在。'
Stop-Transcript | Out-Null
