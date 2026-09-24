# 在 VMware Fusion 的 Windows 11 ARM64 里跑 Omni

主机 macOS（Apple Silicon）+ Fusion 26.0.1，客户机 Windows 11 ARM64（Build 26200.8037，账号 `clover`），
目标是让客户机里的 Node 跑 `/Users/wurui/Train/Omni`。

配套工具：`tools/vmomni.py`（Typer 写的 CLI）。编译器那一侧的账记在
`docs/notes/windows-arm64-c-backend.md`，这一份只管**怎么把东西弄进那台客户机、怎么在里头跑**。

两个密码都**不在源码里**（这一份进了仓库）：

- VM 是加密的，`vmrun` 每条命令都要 `-vp` —— 从 `VMOMNI_VMX_PASS` 或钥匙串取
  （Fusion 自己存的那条，服务名就是 vmx 的完整路径）
- 客户机账号的密码 —— 从 `VMOMNI_GUEST_PASS` 或钥匙串取，存一次就好：
  `security add-generic-password -s vmomni-guest -a clover -w '那个密码'`

别的都能用 `VMOMNI_*` 覆盖（`VMX` / `HOST_DIR` / `GUEST_USER` / `GUEST_DIR` /
`SHARE` / `DRIVE` / `HOST_USER` / `HOST_PASS`），默认值是这台机器上的那一套。

## 一、先说结论：HGFS 共享文件夹这条路是死的

不是配置没配对，是这个组合不支持：

- Broadcom 官方文档明写 *"Shared Folder is not supported for Windows 11 ARM GOS on Apple Silicon hosts."*
- 客户机里实测：`\\vmware-host\Shared Folders` 报「找不到网络路径」；`C:\Windows\System32\drivers\` 下只有
  `vmxnet3.sys` 等，没有 `vmhgfs*.sys`；网络提供程序顺序是 `RDPNP,P9NP,LanmanWorkstation,webclient`，没有 HGFS 项。
- 对比 Fusion 自带的两个 Tools 安装包：x86 的 `windows.iso` 里有整套 `vmhgfs.sys/.inf/.cat/dll`，
  ARM64 的 `isoimages/arm64/windows.iso` 里一个都没有——驱动根本没随 ARM 版 Tools 发。

`vmrun addSharedFolder` / `enableSharedFolders` 会成功返回，也会往 vmx 写 `sharedFolder0.*`，但客户机侧永远看不到。
**别被它的成功返回码骗了。**

所以改走两条链路，一条实时、一条离线兜底。

## 二、链路 A：SMB 实时挂载（主机共享 → 客户机 Z:）

客户机网卡是桥接的（当前 IP `192.168.1.93`，主机同网段 IP 用 `ipconfig getifaddr en0` 取），
所以走标准 Windows 文件共享即可。按你的要求没有改动网络配置。

```bash
python3 vmomni.py smb enable          # sudo：开 smbd + 把 Omni 目录做成共享点（需交互输密码）
python3 vmomni.py smb mount           # 客户机里 net use Z: \\<主机IP>\Omni，持久化
python3 vmomni.py guest node --cwd Z:\\ -- src/cli.js --help
python3 vmomni.py smb disable         # 用完关掉
```

要知道的三件事：

- 客户机到主机的网络路径是通的，已实测：客户机 `ping 192.168.1.32`（主机 en0）2ms、0 丢包。
  也就是说这条链路差的只是主机那边 445 没开。
- `smb enable` 需要 sudo，**我没有你的 sudo 口令，所以 enable/mount 这两步没有实测过**，命令序列是
  `launchctl enable system/com.apple.smbd` → `kickstart -k` → `sharing -a … -S Omni -s 001 -g 000`，
  三步都是可逆的，`smb disable` 原路撤掉。
- smbd 一开就在**所有网卡**上监听 445，同一 WiFi 下别的机器也能看到这台主机。默认我把来宾访问关了
  （`-g 000`），客户机挂载时要用 macOS 账号口令认证；`--guest-access` 可以打开，但同网段任何人都能读写 Omni，不建议。
- WiFi 一抖 SMB 就会掉，`net use` 的 Z: 会变成断开状态，重新 `smb mount` 即可。这也是为什么要有链路 B。

## 三、链路 B：vmrun 离线同步（完全不碰网络）

`vmrun` 的 guest 操作走 VMCI（虚拟机总线），**和 WiFi、IP、SSH 全都无关**，网断了照样能用。
做法是把源码打包推到客户机本地盘 `C:\OmniVM` 再跑。

```bash
python3 vmomni.py vm up               # 开机并等 Tools 就绪
python3 vmomni.py guest push --clean  # 打包(排除 .git/dist/缓存，约 8.5MB) → 推送 → 客户机解包
python3 vmomni.py guest node -- src/cli.js --help
python3 vmomni.py guest node --timeout 1200 -- tests/run.js
python3 vmomni.py guest pull 'C:\OmniVM\out.txt'   # 取结果回主机
```

已实测跑通：客户机 Node `v26.7.0`（`C:\Program Files\nodejs\node.exe`），
`node src/cli.js --help` 正常输出，中文不乱码（bat 里统一 `chcp 65001`，回传按 UTF-8 解码）。

代价：不是实时的，主机改完代码要重新 `guest push`。8.5MB 的包推送+解包大约几秒。

**但量过之后这条路没有速度理由**（2026-09-24，`node src/cli.js --help` 跑三趟取最小值）：

- 客户机本地盘 `C:\OmniVM`：333ms（三趟 534/333/452）
- 客户机 SMB 共享 `Z:\`：**214ms**（三趟 367/287/214）
- 主机 macOS 同一条命令：120ms

SMB 反而比客户机本地盘快 —— 所以「推代码进虚拟机」只在网络断掉时才用，日常直接在 `Z:` 上干。

## 三之二、虚拟机瘦身（已做）

原配置在这台 8 核 / 8GB 的主机上过肥，改完 `--help` 从 7.7s 掉到 0.2-0.5s：

- `numvcpus` 2 → 4（`cpuid.coresPerSocket` 同步改 4）
- `mks.enable3d` TRUE → FALSE，`svga.graphicsMemoryKB` **8388608（8GB！）→ 262144**
- `sound.present`、`ehci.present`、`sata0:1.present`（挂着的安装 ISO）→ FALSE
- 内存不再落文件、不做页共享：`mainMem.useNamedFile=FALSE`、`MemTrimRate=0`、
  `sched.mem.pshare.enable=FALSE`、`prefvmx.minVmMemPct=100`
- `memsize` 保持 4096：主机只有 8GB，再往上加是让主机换页，得不偿失
- 跑法改成无头（`vmomni vm up --no-gui`），不渲染 MKS

原 vmx 备份在 `Windows 11 64-bit Arm.vmwarevm/Windows 11 64-bit Arm.vmx.bak-1623`。

**还差一步，需要你在虚拟机里点一次**：停服务、Defender 排除、电源计划都要管理员权限，
而 vmrun 起的进程是 Medium 完整性（管理员组 deny-only），UAC 在服务会话里只会挂着等人点
（试过，卡到超时）。脚本已经放好：虚拟机控制台里 Win+X → 终端(管理员) →
`Set-ExecutionPolicy -Scope Process Bypass -Force; Z:\tools\win-tune.ps1`，跑完重启一次。


## 四、工具速查

```
vmomni.py doctor                 一次体检：Fusion/锁/电源/Tools/Node/HGFS/SMB
vmomni.py vm status|up|down|unlock
vmomni.py guest probe            客户机环境探测（Node、HGFS、Z:、本地副本）
vmomni.py guest run -- <cmd>     在客户机跑一条 cmd 命令并回显
vmomni.py guest node -- <args>   在客户机跑 node（--cwd 选 C:\OmniVM 或 Z:\）
vmomni.py guest push|pull
vmomni.py smb status|enable|mount|unmount|disable
```

依赖 typer：`/Users/wurui/.venv/bin/python3 vmomni.py …`（该 venv 里是 typer 0.20）。

可覆盖的环境变量：`VMOMNI_VMX`、`VMOMNI_HOST_DIR`、`VMOMNI_GUEST_USER`、`VMOMNI_GUEST_PASS`、
`VMOMNI_GUEST_DIR`、`VMOMNI_SHARE`、`VMOMNI_DRIVE`、`VMOMNI_BRIDGE`、`VMOMNI_VMX_PASS`。

## 五、踩过的坑

**VM 是加密的，vmrun 每条命令都要 `-vp`。** 密码不是客户机密码，Fusion 把它存在钥匙串里，
服务名就是 vmx 的完整路径：`security find-generic-password -s "<vmx路径>" -a $USER -w`。
工具已自动取，取不到就设 `VMOMNI_VMX_PASS`。

**`Error: The file is already in use`。** 上次非正常退出（vmx 里 `cleanShutdown = "FALSE"`）留下了
`*.lck` 锁目录，而持锁的 vmware-vmx 进程早没了。`vmomni.py vm unlock` 会先确认没有 vmware-vmx 进程再删锁。
本次是用 Fusion 界面打开 VM 绕过去的（界面会自己处理陈旧锁）。

**`The specified guest user must be logged in interactively`。** 加了 `-interactive`/`-activeWindow` 才会要求
客户机有人登录在桌面。不加这两个参数，程序在服务上下文里跑，客户机停在登录界面也能执行——工具走的就是这条。

**`Error: A program could not run on the guest operating system`。** 别把带 `&`、括号、重定向的长命令直接塞给
`runProgramInGuest`，引号层层转义很容易炸。工具统一把脚本落成 `.bat` 推进去再 `cmd /c` 跑，输出重定向到文件后回传。

**bat 里的括号会吃掉脚本。** 早先版本把整段脚本包在 `( … ) > out` 里做重定向，结果 `node -e "…writeFileSync(…)"`
里的 `)` 直接把括号块截断，命令静默不执行。现在改成两层：inner.bat 放原始脚本，wrapper.bat 只写
`call inner.bat > out 2>&1`。

**SSH 不通不代表虚拟机有问题。** 当前 `192.168.1.93:22` ping 不通、22 端口也不开（你给的
`192.168.18.225` 是另一个 WiFi 网段的旧地址）。链路 B 完全不依赖这些。

**vmx 里残留了 `sharedFolder0/1.*` 几行。** 是测 HGFS 时 `addSharedFolder` 写进去的，
`maxNum = "0"` 且驱动不存在，纯惰性配置，不影响运行。想彻底清掉要在**关机状态**下手工删这几行。
