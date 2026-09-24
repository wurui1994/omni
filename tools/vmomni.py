#!/usr/bin/env python3
"""vmomni —— 在 VMware Fusion 的 Windows 11 ARM64 客户机里跑 /Users/wurui/Train/Omni。

背景：Fusion 在 Apple Silicon + Windows 11 ARM 客户机上不支持 HGFS 共享文件夹
（Tools 里没有 vmhgfs 驱动），所以 \\\\vmware-host\\Shared Folders 走不通。这里提供两条链路：

  1. smb  —— 主机开 SMB 共享，客户机 net use Z: 挂载，实时读写（需要 sudo 授权一次）
  2. sync —— 纯 vmrun（VMCI 通道，不依赖网络/WiFi）打包推送到客户机本地盘 C:\\OmniVM

所有 guest 操作都通过 vmrun 的 VMCI 通道，WiFi 断了也能用。
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

import typer

VMRUN = "/Applications/VMware Fusion.app/Contents/Public/vmrun"
VMX = os.environ.get(
    "VMOMNI_VMX",
    "/Users/wurui/Virtual Machines.localized/Windows 11 64-bit Arm.vmwarevm/Windows 11 64-bit Arm.vmx",
)
HOST_DIR = Path(os.environ.get("VMOMNI_HOST_DIR", "/Users/wurui/Train/Omni"))
BRIDGE = Path(os.environ.get("VMOMNI_BRIDGE", "/Users/wurui/.vmbridge"))
GUEST_USER = os.environ.get("VMOMNI_GUEST_USER", "clover")
GUEST_DIR = os.environ.get("VMOMNI_GUEST_DIR", r"C:\OmniVM")
SHARE_NAME = os.environ.get("VMOMNI_SHARE", "Omni")
DRIVE = os.environ.get("VMOMNI_DRIVE", "Z:")
HOST_USER = os.environ.get("VMOMNI_HOST_USER", os.environ.get("USER", ""))
HOST_PASS = os.environ.get("VMOMNI_HOST_PASS", "")
# 推送时跳过的目录：产物、缓存、git 历史，省掉 500 多 MB
EXCLUDES = [".git", "dist", ".omni-cache", ".omni-build", ".playwright-cli", "node_modules"]

app = typer.Typer(add_completion=False, help=__doc__)
vm_app = typer.Typer(help="虚拟机电源与状态")
guest_app = typer.Typer(help="客户机内执行、探测、文件传输")
smb_app = typer.Typer(help="SMB 实时挂载链路（需要 sudo 开一次主机文件共享）")
app.add_typer(vm_app, name="vm")
app.add_typer(guest_app, name="guest")
app.add_typer(smb_app, name="smb")


def sh(cmd: list[str], check: bool = False, quiet: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess:
    if not quiet:
        typer.secho("$ " + " ".join(shlex.quote(c) for c in cmd), fg=typer.colors.BRIGHT_BLACK)
    return subprocess.run(cmd, capture_output=True, text=True, check=check, timeout=timeout)


def vmx_password() -> str:
    """VM 是加密的，vmrun 每次都要密码。优先环境变量，其次 Fusion 存进钥匙串的那条。"""
    if os.environ.get("VMOMNI_VMX_PASS"):
        return os.environ["VMOMNI_VMX_PASS"]
    r = sh(["security", "find-generic-password", "-s", VMX, "-a", os.environ.get("USER", ""), "-w"])
    if r.returncode != 0 or not r.stdout.strip():
        raise typer.BadParameter(
            "取不到 VM 加密密码：钥匙串里没有对应条目，请设 VMOMNI_VMX_PASS 环境变量"
        )
    return r.stdout.strip()


def guest_pass() -> str:
    """客户机账号的密码。**不写在源码里**（这份要进仓库）：环境变量优先，其次钥匙串。

    存一次就好：
        security add-generic-password -s vmomni-guest -a clover -w '那个密码'
    或者每趟给一次：
        VMOMNI_GUEST_PASS=… tools/vmomni.py guest probe
    """
    if os.environ.get("VMOMNI_GUEST_PASS"):
        return os.environ["VMOMNI_GUEST_PASS"]
    r = sh(["security", "find-generic-password", "-s", "vmomni-guest", "-a", GUEST_USER, "-w"])
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout.strip()
    raise typer.BadParameter(
        f"取不到客户机 '{GUEST_USER}' 的密码。两条路：\n"
        f"  security add-generic-password -s vmomni-guest -a {GUEST_USER} -w '密码'\n"
        f"  或者 VMOMNI_GUEST_PASS=密码 再跑一次"
    )


def vmrun(*args: str, guest: bool = False, quiet: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess:
    cmd = [VMRUN, "-T", "fusion", "-vp", vmx_password()]
    if guest:
        cmd += ["-gu", GUEST_USER, "-gp", guest_pass()]
    cmd += list(args)
    return sh(cmd, quiet=quiet, timeout=timeout)


def vmx_running() -> bool:
    r = sh([VMRUN, "-T", "fusion", "list"])
    return VMX in r.stdout


def require_running() -> None:
    if not vmx_running():
        typer.secho("虚拟机没在运行，先 `vmomni vm up`", fg=typer.colors.RED)
        raise typer.Exit(2)


def guest_bat(script: str, timeout: int = 900, smb: bool = False, subdir: str = "") -> tuple[int, str]:
    """把一段 cmd 脚本塞进客户机跑掉，输出经 UTF-8 回传。

    两层 bat：inner 装原始脚本，wrapper 只负责 `call inner > out`。
    重定向不能直接套在 inner 外面加括号——脚本里出现 `)`（比如 node -e 的代码）会把括号块截断。

    smb=True 时先在本次登录会话里认证 UNC 再 pushd 过去：vmrun 的非交互进程跑在服务会话，
    看不到交互登录时 `net use` 映射的盘符，所以每次都要自己挂一遍。
    """
    BRIDGE.mkdir(parents=True, exist_ok=True)
    tag = f"{os.getpid()}"
    out_guest = rf"C:\Users\{GUEST_USER}\vmomni-{tag}.out"
    inner_guest = rf"C:\Users\{GUEST_USER}\vmomni-{tag}-inner.bat"
    wrap_guest = rf"C:\Users\{GUEST_USER}\vmomni-{tag}.bat"
    if smb:
        unc = rf"\\{host_ip_for_guest()}\{SHARE_NAME}"
        cred = f" /user:{HOST_USER} {HOST_PASS}" if HOST_PASS else ""
        script = (f"net use {unc}{cred} >nul 2>&1\npushd {unc}{subdir}\n"
                  f"if errorlevel 1 (echo SMB-MOUNT-FAILED & exit /b 9)\n" + script + "\npopd")
    inner = "@echo off\r\nchcp 65001 >nul\r\n" + script.replace("\n", "\r\n") + "\r\n"
    wrapper = f"@echo off\r\ncall {inner_guest} > {out_guest} 2>&1\r\nexit /b %errorlevel%\r\n"
    hosts = []
    for text in (inner, wrapper):
        with tempfile.NamedTemporaryFile("w", suffix=".bat", dir=BRIDGE, delete=False, newline="") as f:
            f.write(text)
            hosts.append(f.name)
    try:
        for host_file, guest_file in zip(hosts, (inner_guest, wrap_guest)):
            cp = vmrun("copyFileFromHostToGuest", VMX, host_file, guest_file, guest=True)
            if cp.returncode != 0:
                return cp.returncode, cp.stderr + cp.stdout
        run = vmrun("runProgramInGuest", VMX, r"C:\Windows\System32\cmd.exe", "/c", wrap_guest, guest=True, timeout=timeout)
        back = BRIDGE / f"vmomni-{tag}.out"
        vmrun("copyFileFromGuestToHost", VMX, out_guest, str(back), guest=True)
        text = back.read_text("utf-8", errors="replace") if back.exists() else ""
        for leftover in (out_guest, inner_guest, wrap_guest):
            vmrun("deleteFileInGuest", VMX, leftover, guest=True)
        return run.returncode, text
    finally:
        for host_file in hosts:
            os.unlink(host_file)


# ---------------------------------------------------------------- vm


@vm_app.command("status")
def vm_status() -> None:
    """电源状态、Tools 状态、客户机 IP。"""
    running = vmx_running()
    typer.echo(f"vmx      : {VMX}")
    typer.echo(f"power    : {'running' if running else 'off'}")
    if running:
        typer.echo(f"tools    : {vmrun('checkToolsState', VMX).stdout.strip()}")
        typer.echo(f"guest ip : {vmrun('getGuestIPAddress', VMX).stdout.strip()}")
    locks = list(Path(VMX).parent.glob("*.lck"))
    typer.echo(f"locks    : {len(locks)} 个" + (" （虚拟机没跑还有锁 → vmomni vm unlock）" if locks and not running else ""))


@vm_app.command("up")
def vm_up(
    gui: bool = typer.Option(True, help="用 Fusion 界面启动；False 则 vmrun nogui 无头启动"),
    wait_tools: int = typer.Option(240, help="等 VMware Tools 就绪的秒数上限"),
) -> None:
    """开机并等到 Tools 可用（Tools 就绪后 vmrun 的 guest 操作才可用）。"""
    if vmx_running():
        typer.echo("已在运行")
    elif gui:
        sh(["open", "-a", "VMware Fusion", str(Path(VMX).parent)], quiet=False)
    else:
        r = vmrun("start", VMX, "nogui", quiet=False)
        if r.returncode != 0:
            typer.secho(r.stderr.strip() or r.stdout.strip(), fg=typer.colors.RED)
            typer.echo("提示：`The file is already in use` 多半是上次没干净关机留下的锁 → vmomni vm unlock")
            raise typer.Exit(2)
    import time

    deadline = time.time() + wait_tools
    while time.time() < deadline:
        if vmx_running() and vmrun("checkToolsState", VMX).stdout.strip() == "running":
            typer.secho("Tools 就绪：" + vmrun("getGuestIPAddress", VMX).stdout.strip(), fg=typer.colors.GREEN)
            return
        time.sleep(10)
    typer.secho("超时：Tools 还没报 running（可能停在登录界面之前，可继续等）", fg=typer.colors.YELLOW)


@vm_app.command("down")
def vm_down(hard: bool = typer.Option(False, help="硬关机；默认走客户机正常关机")) -> None:
    """关机。"""
    r = vmrun("stop", VMX, "hard" if hard else "soft", quiet=False)
    typer.echo((r.stdout + r.stderr).strip() or "已下发关机")


@vm_app.command("unlock")
def vm_unlock() -> None:
    """清掉上次非正常退出留下的 *.lck 锁目录（会先确认没有 vmware-vmx 进程）。"""
    if sh(["pgrep", "-f", "vmware-vmx"]).returncode == 0:
        typer.secho("还有 vmware-vmx 进程在跑，拒绝删锁", fg=typer.colors.RED)
        raise typer.Exit(2)
    import shutil

    for lck in Path(VMX).parent.glob("*.lck"):
        shutil.rmtree(lck)
        typer.echo(f"removed {lck.name}")
    typer.secho("锁已清理", fg=typer.colors.GREEN)


# ---------------------------------------------------------------- guest


@guest_app.command("probe")
def guest_probe() -> None:
    """探一遍客户机环境：账号、Node、HGFS 有没有、Z: 挂没挂。"""
    require_running()
    code, out = guest_bat(
        "whoami\nver\necho ===NODE===\nnode -v\nwhere node\n"
        "echo ===HGFS===\nif exist \"\\\\vmware-host\\Shared Folders\" (echo hgfs-ok) else (echo hgfs-absent)\n"
        f"echo ==={DRIVE}===\nif exist {DRIVE}\\ (dir {DRIVE}\\package.json) else (echo drive-not-mounted)\n"
        f"echo ===LOCAL===\nif exist {GUEST_DIR} (dir {GUEST_DIR}\\package.json) else (echo local-copy-absent)\n"
        "echo ===NETUSE===\nnet use"
    )
    typer.echo(out)
    raise typer.Exit(0)


@guest_app.command("run", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def guest_run(ctx: typer.Context, cwd: str = typer.Option(GUEST_DIR, help="客户机工作目录"),
              smb: bool = typer.Option(False, "--smb", help="在 SMB 共享（主机目录）里跑，而不是客户机本地副本"),
              subdir: str = typer.Option("", help="--smb 时共享内的子目录，如 \\tests"),
              timeout: int = typer.Option(900, help="秒数上限")) -> None:
    """在客户机跑一条 cmd 命令并回显输出：vmomni guest run -- dir C:\\"""
    require_running()
    cmdline = " ".join(ctx.args)
    if not cmdline:
        raise typer.BadParameter("给一条命令，例如： guest run -- node -v")
    code, out = guest_bat(cmdline if smb else f"cd /d {cwd}\n{cmdline}", timeout=timeout, smb=smb, subdir=subdir)
    typer.echo(out)
    raise typer.Exit(code)


@guest_app.command("node", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def guest_node(
    ctx: typer.Context,
    cwd: str = typer.Option(GUEST_DIR, help=f"在哪跑：{GUEST_DIR}（本地副本）或 {DRIVE}\\（SMB 挂载）"),
    smb: bool = typer.Option(False, "--smb", help="在 SMB 共享（主机目录）里跑"),
    subdir: str = typer.Option("", help="--smb 时共享内的子目录"),
    timeout: int = typer.Option(900, help="秒数上限"),
) -> None:
    """在客户机用 node 跑 Omni：vmomni guest node -- src/cli.js --help"""
    require_running()
    args = " ".join(ctx.args) or "-v"
    body = f"node {args}\necho ===EXIT=%errorlevel%==="
    code, out = guest_bat(body if smb else f"cd /d {cwd}\n{body}", timeout=timeout, smb=smb, subdir=subdir)
    typer.echo(out)
    raise typer.Exit(code)


@guest_app.command("push")
def guest_push(
    clean: bool = typer.Option(False, help="先清空客户机目标目录再解包"),
    include_dist: bool = typer.Option(False, help="连 dist 产物一起推（默认跳过，省 400MB）"),
) -> None:
    """把主机 Omni 源码打包推到客户机本地盘（不依赖网络，走 VMCI）。"""
    require_running()
    BRIDGE.mkdir(parents=True, exist_ok=True)
    tgz = BRIDGE / "omni-src.tgz"
    excludes = [e for e in EXCLUDES if not (include_dist and e == "dist")]
    cmd = ["tar", "czf", str(tgz), "-C", str(HOST_DIR)] + [f"--exclude=./{e}" for e in excludes] + ["."]
    r = sh(cmd, quiet=False)
    if r.returncode != 0:
        typer.secho(r.stderr, fg=typer.colors.RED)
        raise typer.Exit(2)
    size = tgz.stat().st_size / 1e6
    typer.echo(f"打包完成 {size:.1f} MB → 推送中…")
    guest_tgz = rf"C:\Users\{GUEST_USER}\omni-src.tgz"
    cp = vmrun("copyFileFromHostToGuest", VMX, str(tgz), guest_tgz, guest=True)
    if cp.returncode != 0:
        typer.secho((cp.stderr + cp.stdout).strip(), fg=typer.colors.RED)
        raise typer.Exit(2)
    script = (
        (f"if exist {GUEST_DIR} rmdir /s /q {GUEST_DIR}\n" if clean else "")
        + f"if not exist {GUEST_DIR} mkdir {GUEST_DIR}\n"
        + f"tar -xzf {guest_tgz} -C {GUEST_DIR}\n"
        + f"echo untar-exit=%errorlevel%\ndir {GUEST_DIR}\\package.json"
    )
    code, out = guest_bat(script)
    typer.echo(out)
    typer.secho(f"已同步到 {GUEST_DIR}" if code == 0 else "解包失败", fg=typer.colors.GREEN if code == 0 else typer.colors.RED)


@guest_app.command("kill")
def guest_kill(
    names: str = typer.Option("node.exe", help="逗号分隔的进程名"),
) -> None:
    """杀掉客户机里跑飞的进程。

    为什么单开一格：`guest run` 在主机侧超时之后，**客户机里那个进程还在跑** ——
    vmrun 只是不再等它。踩过一次：一趟超时的 `emit c` 留下的 node.exe 把四个 vCPU
    占满，之后每条 guest 命令都跟着超时，看起来像「虚拟机挂了」。
    """
    require_running()
    script = "\n".join(f"taskkill /f /im {n.strip()}" for n in names.split(",") if n.strip())
    code, out = guest_bat(script + "\ntasklist | findstr /i \"node\"", timeout=300)
    typer.echo(out)


@guest_app.command("pull")
def guest_pull(
    guest_path: str = typer.Argument(..., help=r"客户机里的文件，如 C:\OmniVM\out.txt"),
    dest: Path = typer.Argument(None, help="主机落地路径，默认放 bridge 目录"),
) -> None:
    """从客户机取一个文件回主机。"""
    require_running()
    BRIDGE.mkdir(parents=True, exist_ok=True)
    target = dest or BRIDGE / guest_path.replace("\\", "/").rsplit("/", 1)[-1]
    r = vmrun("copyFileFromGuestToHost", VMX, guest_path, str(target), guest=True)
    if r.returncode != 0:
        typer.secho((r.stderr + r.stdout).strip(), fg=typer.colors.RED)
        raise typer.Exit(2)
    typer.secho(f"→ {target}", fg=typer.colors.GREEN)


# ---------------------------------------------------------------- smb


def host_ip_for_guest() -> str:
    """客户机眼里的主机地址：客户机是桥接的，所以就是主机在同一网段那张网卡的 IP。"""
    guest = vmrun("getGuestIPAddress", VMX).stdout.strip()
    prefix = guest.rsplit(".", 1)[0] + "."
    for dev in ("en0", "en1", "en2", "bridge100"):
        ip = sh(["ipconfig", "getifaddr", dev]).stdout.strip()
        if ip.startswith(prefix):
            return ip
    return sh(["ipconfig", "getifaddr", "en0"]).stdout.strip()


@smb_app.command("status")
def smb_status() -> None:
    """主机 SMB 服务、共享点、以及客户机侧挂载状态。"""
    listening = "445" in sh(["bash", "-c", "netstat -an | grep -E '\\.445 ' | head -1"]).stdout
    typer.echo(f"smbd listening : {listening}")
    shares = sh(["sharing", "-l"]).stdout
    typer.echo(f"share {SHARE_NAME!r}  : {'已配置' if SHARE_NAME in shares else '未配置'}")
    typer.echo(f"host ip        : {host_ip_for_guest() if vmx_running() else '(VM 未运行)'}")


@smb_app.command("enable")
def smb_enable(
    yes: bool = typer.Option(False, "--yes", help="不再二次确认"),
    guest_access: bool = typer.Option(False, help="允许来宾免密访问（不建议：同网段任何人都能读写）"),
) -> None:
    """开启主机文件共享并把 Omni 目录做成共享点（需要 sudo，会交互要密码）。

    注意：smbd 一开就在所有网卡上监听 445，同一 WiFi 下的其他机器也能看到这台主机。
    用完建议 `vmomni smb disable`。
    """
    if not yes:
        typer.echo(f"将执行：开启 smbd + 共享 {HOST_DIR} 为 //{SHARE_NAME}"
                   + ("（来宾免密）" if guest_access else "（需 macOS 账号口令认证）"))
        typer.confirm("继续？", abort=True)
    steps = [
        ["sudo", "launchctl", "enable", "system/com.apple.smbd"],
        ["sudo", "launchctl", "kickstart", "-k", "system/com.apple.smbd"],
        ["sudo", "sharing", "-a", str(HOST_DIR), "-S", SHARE_NAME, "-n", SHARE_NAME,
         "-s", "001", "-g", "001" if guest_access else "000"],
    ]
    for step in steps:
        typer.secho("$ " + " ".join(step), fg=typer.colors.BRIGHT_BLACK)
        r = subprocess.run(step)
        if r.returncode != 0:
            typer.secho("这一步失败了，后面的没执行", fg=typer.colors.RED)
            raise typer.Exit(2)
    smb_status()


@smb_app.command("disable")
def smb_disable(keep_share: bool = typer.Option(False, help="只停服务，保留共享点配置")) -> None:
    """关掉主机文件共享（并默认移除 Omni 共享点）。"""
    if not keep_share:
        subprocess.run(["sudo", "sharing", "-r", SHARE_NAME])
    subprocess.run(["sudo", "launchctl", "disable", "system/com.apple.smbd"])
    subprocess.run(["sudo", "launchctl", "kill", "TERM", "system/com.apple.smbd"])
    typer.secho("已关闭", fg=typer.colors.GREEN)


@smb_app.command("mount")
def smb_mount(
    host_user: str = typer.Option(lambda: os.environ.get("USER", ""), help="macOS 账号名"),
    host_pass: str = typer.Option(None, prompt="macOS 账号密码（回车留空=来宾访问）", hide_input=True),
    host_ip: str = typer.Option(None, help="主机 IP，默认按客户机网段自动判断"),
) -> None:
    """在客户机把共享挂成 Z:（持久化，重启后自动恢复）。"""
    require_running()
    ip = host_ip or host_ip_for_guest()
    cred = f"/user:{host_user} {host_pass}" if host_pass else ""
    code, out = guest_bat(
        f"net use {DRIVE} /delete /y >nul 2>&1\n"
        f"net use {DRIVE} \\\\{ip}\\{SHARE_NAME} {cred} /persistent:yes\n"
        f"echo ===EXIT=%errorlevel%===\ndir {DRIVE}\\package.json"
    )
    typer.echo(out.replace(host_pass, "***") if host_pass else out)
    if code != 0 or "package.json" not in out:
        typer.secho("挂载没成：先确认 `vmomni smb status` 里 smbd 在听、客户机能 ping 通主机", fg=typer.colors.YELLOW)
        raise typer.Exit(2)
    typer.secho(f"{DRIVE} 已挂载 → \\\\{ip}\\{SHARE_NAME}", fg=typer.colors.GREEN)


@smb_app.command("unmount")
def smb_unmount() -> None:
    """卸掉客户机的 Z:。"""
    require_running()
    _, out = guest_bat(f"net use {DRIVE} /delete /y")
    typer.echo(out)


@app.command("doctor")
def doctor() -> None:
    """一次性体检：Fusion、锁、电源、Tools、Node、HGFS、SMB、两条链路可用性。"""
    typer.echo(f"vmrun          : {'ok' if Path(VMRUN).exists() else '缺失'}")
    typer.echo(f"host dir       : {HOST_DIR} {'ok' if HOST_DIR.is_dir() else '缺失'}")
    vm_status()
    if vmx_running() and vmrun("checkToolsState", VMX).stdout.strip() == "running":
        code, out = guest_bat("node -v\nif exist \"\\\\vmware-host\\Shared Folders\" (echo hgfs-ok) else (echo hgfs-absent)")
        typer.echo("guest node/hgfs:\n" + out.strip())
    smb_status()


if __name__ == "__main__":
    app()
