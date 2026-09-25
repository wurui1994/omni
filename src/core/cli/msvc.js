/**
 * **MSVC 这一档**（`--cc msvc`）：把生成的 C 交给 Visual Studio 的 `cl.exe`。
 *
 * 两件事跟别的外部 cc 不同，所以单独一份文件：
 *
 *  1. **它不在 PATH 上**。开发者命令行（vcvars）之外 `where cl` 找不到人，而且就算找到了，
 *     少了 `INCLUDE` / `LIB` 两格它连 `stdio.h` 都打不开。所以这一档要自己把工具链找出来，
 *     再把 vcvars 那套环境变量捞进本进程（`setEnv`）。
 *  2. **开关是另一套方言**：`-o` / `-c` / `-I` / `-l` 那一串是 GNU 的说法，`cl` 认的是
 *     `/Fe:` / `/c` / `/I` / `foo.lib`。整棵编译器里拼的都是 GNU 说法，所以在**交给子进程
 *     之前**翻一次 —— 一个边界函数，不动那六处调用点。
 *
 * 检测是**通用**的，不写死任何一条路径：环境里已经有 -> vswhere -> 按目录形状扫。
 * 版本（2017/2019/2022/18…）、版次（Community/Professional/Enterprise/BuildTools）、
 * 宿主与目标架构（x64 / arm64 / x86，含交叉）都按机器上实际有什么来。
 */

/** `--cc` 这一格说的是不是 MSVC：`msvc` 这个名字，或者直接指着一份 `cl.exe`。 */
export function isMsvc(cc) {
  if (!cc) return false;
  const b = cc.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return b === 'msvc' || b === 'cl' || b === 'cl.exe';
}

/** `AMD64` / `ARM64` / `x86` 这些说法折成 vcvars 认的那三个词。 */
function vcArch(a) {
  const s = String(a || '').toLowerCase();
  if (s === 'arm64' || s === 'aarch64') return 'arm64';
  if (s === 'x86' || s === 'i386' || s === 'ia32') return 'x86';
  return 'x64';
}

/** 宿主架构：`PROCESSOR_ARCHITEW6432` 先说话（32 位进程跑在 64 位机器上那一格）。 */
function hostVcArch(env) {
  return vcArch(env('PROCESSOR_ARCHITEW6432') || env('PROCESSOR_ARCHITECTURE') || 'AMD64');
}

/** `Hostx64` / `Hostarm64` 那一层目录名。 */
function hostDirName(a) {
  return a === 'arm64' ? 'Hostarm64' : a === 'x86' ? 'Hostx86' : 'Hostx64';
}

/**
 * vcvarsall 的参数：宿主与目标一样就一个词，不一样是 `<宿主>_<目标>`。
 * （`x64_arm64` 这种交叉形式是 vcvarsall 自己的写法，不是我们编的。）
 */
export function vcvarsArg(host, target) {
  return host === target ? target : `${host}_${target}`;
}

/* ------------------------------------------------------------------ 找人 */

/** 目录里最大的那个版本号子目录（`VC\Tools\MSVC\14.50.35717` 这一层没有 default.txt 时用）。 */
function newestVersionDir(dirs) {
  const key = (s) => s.split('.').map((x) => Number.parseInt(x, 10) || 0);
  let best = null;
  for (const d of dirs) {
    if (!/^\d+(\.\d+)*$/.test(d)) continue;
    if (best === null) { best = d; continue; }
    const a = key(d); const b = key(best);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0; const y = b[i] || 0;
      if (x !== y) { if (x > y) best = d; break; }
    }
  }
  return best;
}

/**
 * 一份 VS 安装里，`cl.exe` 与 `vcvarsall.bat` 在哪儿。
 * 工具集版本优先读 `Microsoft.VCToolsVersion.default.txt`（安装器写的那格），读不到就挑最大的。
 */
function toolchainIn(root, host, target, io) {
  const bat = io.join(root, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  if (!io.exists(bat)) return null;
  let ver = null;
  const def = io.join(root, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt');
  if (io.exists(def)) ver = io.readText(def).trim();
  const msvcDir = io.join(root, 'VC', 'Tools', 'MSVC');
  if ((ver === null || ver === '') && io.exists(msvcDir)) ver = newestVersionDir(io.readDir(msvcDir));
  if (ver === null || ver === '') return null;
  const cl = io.join(msvcDir, ver, 'bin', hostDirName(host),
    target === 'arm64' ? 'arm64' : target === 'x86' ? 'x86' : 'x64', 'cl.exe');
  return { root, bat, ver, cl, clExists: io.exists(cl) };
}

/** vswhere 自己也可能不在（老的独立 Build Tools）：两个 Program Files 都看一眼。 */
function vswherePath(io) {
  for (const base of [io.env('ProgramFiles(x86)'), io.env('ProgramFiles'), 'C:\\Program Files (x86)']) {
    if (!base) continue;
    const p = io.join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (io.exists(p)) return p;
  }
  return null;
}

/** 按目录形状扫（vswhere 没有时的兜底）：`<PF>\Microsoft Visual Studio\<年份|大版本>\<版次>`。 */
function scanRoots(io) {
  const out = [];
  for (const base of [io.env('ProgramFiles'), io.env('ProgramFiles(x86)')]) {
    if (!base) continue;
    const vsBase = io.join(base, 'Microsoft Visual Studio');
    if (!io.exists(vsBase)) continue;
    for (const year of io.readDir(vsBase)) {
      const yDir = io.join(vsBase, year);
      if (!io.isDir(yDir)) continue;
      for (const ed of io.readDir(yDir)) {
        const r = io.join(yDir, ed);
        if (io.isDir(r)) out.push(r);
      }
    }
  }
  return out;
}

/**
 * **找工具链**。次序是「已经有的 > 问安装器 > 按形状扫」，每一步都说得出是从哪儿来的
 * （`from`），出错时把找过的地方一起报出来 —— 这类环境问题最费时间的就是"它到底看了哪儿"。
 *
 * `io` 是宿主那几格（`env` / `exists` / `readDir` / `readText` / `isDir` / `spawn` / `join`），
 * 从外面递进来：这样这份文件能在别的腿上（以及测试里）用假的 io 跑。
 */
export function msvcFind(io, target) {
  const host = hostVcArch(io.env);
  const tgt = vcArch(target || host);
  const looked = [];

  /* 0. 明说的那一格：`OMNI_MSVC_CL=<...\cl.exe>`。机器上装了好几套、要钉住一套时用。 */
  const pinned = io.env('OMNI_MSVC_CL');
  if (pinned && io.exists(pinned)) {
    return { cl: pinned, bat: null, host, target: tgt, from: 'OMNI_MSVC_CL' };
  }

  /* 1. 已经在开发者命令行里：`INCLUDE`/`LIB` 都在，且 `cl` 找得到 —— 那就别再跑一遍 vcvars
   *    （省 1~2 秒，也尊重外面已经选好的那套工具集）。 */
  if (io.env('INCLUDE') && io.env('LIB')) {
    const w = io.spawn('where', ['cl.exe'], 'c');
    if (w[0] === 0 && w[1].trim()) {
      const first = w[1].split(/\r?\n/)[0].trim();
      if (first) return { cl: first, bat: null, host, target: tgt, from: '当前环境（vcvars 已经生效）' };
    }
  }

  /* 2. 问安装器。`-products *` 才看得见 BuildTools，`-prerelease` 才看得见 Preview；
   *    先按目标架构要 VC.Tools 那个组件，要不到就退回"任何一份装了 VC 的"。 */
  const vw = vswherePath(io);
  if (vw !== null) {
    looked.push(vw);
    const comp = tgt === 'arm64'
      ? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
      : 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64';
    const tries = [
      ['-products', '*', '-prerelease', '-requires', comp, '-property', 'installationPath', '-format', 'value'],
      ['-products', '*', '-prerelease', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath', '-format', 'value'],
      ['-products', '*', '-prerelease', '-property', 'installationPath', '-format', 'value'],
    ];
    for (const argv of tries) {
      const r = io.spawn(vw, argv, 'c');
      if (r[0] !== 0) continue;
      /* vswhere 按版本从新到旧排，可我们要的是"能编出这个目标"的那份 —— 逐份看 cl 在不在。 */
      for (const line of r[1].split(/\r?\n/)) {
        const root = line.trim();
        if (!root) continue;
        const t = toolchainIn(root, host, tgt, io);
        if (t !== null && t.clExists) {
          return { cl: t.cl, bat: t.bat, host, target: tgt, ver: t.ver, root, from: `vswhere（${root}）` };
        }
        if (t !== null) looked.push(t.cl);
      }
    }
  }

  /* 3. 兜底：按目录形状扫。老的独立 Build Tools 没带 vswhere。 */
  for (const root of scanRoots(io)) {
    looked.push(root);
    const t = toolchainIn(root, host, tgt, io);
    if (t !== null && t.clExists) {
      return { cl: t.cl, bat: t.bat, host, target: tgt, ver: t.ver, root, from: `扫目录（${root}）` };
    }
  }
  return { cl: null, bat: null, host, target: tgt, from: null, looked };
}

/**
 * 机器上所有的 VS 安装根。`cli/clang.js` 要它去找 VS 自带的那份 LLVM
 * （`<root>\VC\Tools\Llvm\x64\bin`）—— 两档共用这一次扫，不各问一遍 vswhere。
 */
export function vsRoots(io) {
  const out = [];
  const vw = vswherePath(io);
  if (vw !== null) {
    const r = io.spawn(vw, ['-products', '*', '-prerelease',
      '-property', 'installationPath', '-format', 'value'], 'c');
    if (r[0] === 0) {
      for (const line of String(r[1] ?? '').split(/\r?\n/)) {
        const s = line.trim();
        if (s !== '' && !out.includes(s)) out.push(s);
      }
    }
  }
  for (const root of scanRoots(io)) if (!out.includes(root)) out.push(root);
  return out;
}

/* ------------------------------------------------ 把 vcvars 那套环境算出来 */

/** 问一格注册表值。`reg.exe` 是普通程序（不是 cmd），argv 里带空格由宿主正常引。 */
function regQuery(io, key, name) {
  const r = io.spawn('reg', ['query', key, '/v', name], 'c');
  if (r[0] !== 0) return null;
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(String(r[1] ?? ''));
  return m === null ? null : m[1].trim();
}

/** Windows SDK 10 的根。注册表先说（32/64 两处），再退回默认位置。 */
function sdkRoot(io) {
  const out = [];
  for (const k of ['HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows Kits\\Installed Roots']) {
    const v = regQuery(io, k, 'KitsRoot10');
    if (v !== null && v !== '') out.push(v.replace(/\\$/, ''));
  }
  for (const base of [io.env('ProgramFiles(x86)'), io.env('ProgramFiles')]) {
    if (base) out.push(io.join(base, 'Windows Kits', '10'));
  }
  for (const p of out) {
    if (io.isDir(io.join(p, 'Include'))) return p;
  }
  return null;
}

/** SDK 里最新那一版（`Include/<ver>/um/windows.h` 在的那一版才算）。 */
function sdkVersion(io, root) {
  const dirs = io.readDir(io.join(root, 'Include')).filter(
    (d) => io.exists(io.join(root, 'Include', d, 'um', 'windows.h')),
  );
  return newestVersionDir(dirs);
}

/**
 * **不跑 vcvarsall，自己把那三格算出来**。
 *
 * 为什么不跑：`vcvarsall.bat` 只能由 `cmd` 起，而 `cmd` 的命令行解析与宿主的 argv 引法
 * 对不上 —— 量到两次：路径里的正斜杠被当成开关（退出码 1、一句话不说），折成反斜杠之后
 * 引号又被宿主转义成 `\"`，cmd 报
 *   \`'\\"C:\\Program Files\\…\\vcvarsall.bat\\"' is not recognized as an internal or external command\`
 * node 那侧要 \`windowsVerbatimArguments\` 才能原样递，而那一格不在我们的宿主 ABI 里。
 *
 * 而这三格本来就是**算得出来的**（vcvarsall 自己也是这么拼的）：
 *   INCLUDE = VC 工具集的 include + SDK 的 ucrt/shared/um/winrt
 *   LIB     = VC 工具集的 lib/<目标> + SDK 的 ucrt/um 的 <目标>
 *   PATH    += VC 的 bin/Host<宿主>/<目标>（\`cl.exe\` 要它旁边那几个 dll）+ SDK 的 bin
 * 顺带省掉每趟 1~2 秒，也不必存那份环境缓存。
 */
export function msvcEnv(io, found, opts) {
  if (found.bat === null) return {};          // 已经在开发者命令行里，什么都不用加
  const looked = [];
  const root = found.root;
  const ver = found.ver;
  if (!root || !ver) throw io.fail('--cc msvc：找到了 cl.exe 却说不出它属于哪一份安装');
  const vcTools = io.join(root, 'VC', 'Tools', 'MSVC', ver);
  const tgtLibDir = found.target === 'arm64' ? 'arm64' : found.target === 'x86' ? 'x86' : 'x64';

  const inc = [];
  const lib = [];
  const path = [];
  const add = (arr, p) => { looked.push(p); if (io.isDir(p)) arr.push(p); };

  add(inc, io.join(vcTools, 'include'));
  add(lib, io.join(vcTools, 'lib', tgtLibDir));
  add(path, io.join(vcTools, 'bin', hostDirName(found.host), tgtLibDir));
  /* 交叉编时 \`cl.exe\` 自己是宿主架构的程序，它旁边那几个 dll 在宿主那一档里 —— 两处都加。 */
  add(path, io.join(vcTools, 'bin', hostDirName(found.host), found.host === 'arm64' ? 'arm64' : 'x64'));

  const sdk = sdkRoot(io);
  if (sdk === null) {
    throw io.fail(`--cc msvc：找不到 Windows SDK（看过：${looked.join('；')}）——`
      + ' VS 安装器里勾一下「Windows 11 SDK」');
  }
  const sv = sdkVersion(io, sdk);
  if (sv === null) throw io.fail(`--cc msvc：${sdk}\\Include 下没有一版带 um\\windows.h 的 SDK`);
  /* **自带 libc 那一档只要编译器自己那几个头**（stdarg.h / vadefs.h / intrin.h）——
   * UCRT 与 um 那两套里也有 stdio.h/stdlib.h，跟我们 sysroot 里那一份撞名字，
   * 而 `INCLUDE` 是一条全局的表，撞上了就说不清用的是谁那一份。 */
  const selfLibc = opts !== undefined && opts.selfLibc === true;
  if (selfLibc) {
    for (const part of ['um']) add(lib, io.join(sdk, 'Lib', sv, part, tgtLibDir));
    const oldPath = io.env('PATH') ?? '';
    return {
      INCLUDE: inc.join(';'),
      LIB: lib.join(';'),
      PATH: `${path.join(';')};${oldPath}`,
    };
  }
  for (const part of ['ucrt', 'shared', 'um', 'winrt', 'cppwinrt']) {
    add(inc, io.join(sdk, 'Include', sv, part));
  }
  for (const part of ['ucrt', 'um']) {
    add(lib, io.join(sdk, 'Lib', sv, part, tgtLibDir));
  }
  add(path, io.join(sdk, 'bin', sv, found.host === 'arm64' ? 'arm64' : 'x64'));

  if (inc.length < 2 || lib.length < 2) {
    throw io.fail('--cc msvc：VC 工具集或 SDK 的目录不全，凑不出 INCLUDE/LIB。看过：\n  '
      + looked.join('\n  '));
  }
  const old = io.env('PATH') ?? '';
  return {
    INCLUDE: inc.join(';'),
    LIB: lib.join(';'),
    PATH: `${path.join(';')};${old}`,
    /* 说清是怎么来的（\`-v\` 里印一行）。 */
    __from: `算出来的（VC ${ver} + SDK ${sv}）`,
  };
}

/* ------------------------------------------------------------ 翻开关 */

/**
 * GNU 说法 -> `cl` 说法。**只在交给子进程之前翻一次**，上游那六处调用点一个字都不用改。
 *
 * 几格是有意丢掉的，不是漏了：
 *   `-fPIC`            Windows 上 DLL 本来就是位置无关的，没有这一格
 *   `-pthread`         线程在 kernel32 里，不用另接
 *   `-lm`              数学函数在 UCRT 里
 *   `-std=c99`         MSVC 只给 c11/c17；它的默认 C 模式已经吃得下我们发的那些
 *   `-fno-omit-frame-pointer`  x64 上回溯靠的是 unwind 表不是帧指针链（`/Oy-` 在 x64 上没有）
 *
 * 两格是**当场报错**而不是悄悄丢：`-finstrument-functions`（MSVC 对应的是 `/Gh /GH` 加
 * `_penter`/`_pexit`，符号名与签名都不一样，得先在运行时那边补上那对钩子）、
 * `-undefined dynamic_lookup`（Windows 上没有"留着不解析"这回事，插件要导入库或延迟加载）。
 *
 * `opts` 那几格：
 *   `selfLibc`  自带 libc（`--libc self`）：不带 CRT 链、入口是我们的 `_start`
 *   `clangCl`   这一趟其实是 `clang-cl`（`cli/clang.js` 借这台翻译机）。它吃的是同一套
 *               `cl` 方言，差别只在**它比 cl 认得多**：`-finstrument-functions` 这种
 *               clang 自己的开关原样递就行，不必当场报错。
 *   `extra`     先塞在最前面的几格（`--target=…` 那一类）
 */
export function msvcArgs(argv, io, opts) {
  /* 第三格从前是个 boolean（`selfLibc`），现在是一袋 —— 两种都认，省得漏改调用点。 */
  const o = (opts === undefined || typeof opts === 'boolean') ? { selfLibc: opts === true } : opts;
  const selfLibc = o.selfLibc === true;
  const clangCl = o.clangCl === true;
  /* `/utf-8`：我们的源码（含运行时那几份头）是**不带 BOM 的 UTF-8**，而 `cl` 默认按本机
   * ANSI 页读 —— 简体中文机器上就是 936，于是每条中文注释都被读坏，接着编出一堆假语法错：
   *   omni_js_obj.h(1266): error C2001: newline in constant
   *   omni_js_obj.h(1267): error C3872: 'U+24': this character is not allowed in an identifier
   *   omni_js_obj.h(1267): error C2061: syntax error: identifier '鐨$js_obj_defs'
   * 那个 `鐨` 就是 UTF-8 字节按 936 解出来的。
   *
   * `/std:c11`：`omni.h` 用的是 C11 的 `_Thread_local`（GNU 两家都认），而 `cl` 的默认
   * C 模式认的是 `__declspec(thread)`，报 `C2054: expected '(' to follow '_Thread_local'`。 */
  /* `/D_USE_MATH_DEFINES`：MSVC 的 `<math.h>` 只在这一格开着的时候才给 `M_PI`/`M_E`
   * 那一族（C 标准里它们确实不是标准的一部分，别的 libc 默认给）。量到的是
   *   omni_r3.c(1320): error: use of undeclared identifier 'M_PI'
   * 摆在这儿而不是运行时那几份头里：这是"这台 cc 的方言"，不是我们的代码要改。 */
  const cl = ['/nologo', '/utf-8', '/std:c11', '/D_USE_MATH_DEFINES', ...(o.extra ?? [])];
  const inputs = [];
  const link = [];
  let out = null;
  let compileOnly = false;
  let shared = false;
  let debug = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-o') { out = next(); continue; }
    if (a === '-c') { compileOnly = true; continue; }
    if (a === '-shared') { shared = true; continue; }
    if (a === '-I') { cl.push('/I', next()); continue; }
    if (a.startsWith('-I') && a.length > 2) { cl.push('/I', a.slice(2)); continue; }
    if (a === '-L') { link.push(`/LIBPATH:${next()}`); continue; }
    if (a.startsWith('-L') && a.length > 2) { link.push(`/LIBPATH:${a.slice(2)}`); continue; }
    if (a.startsWith('-D')) { cl.push(`/D${a.slice(2)}`); continue; }
    if (a === '-include') { cl.push('/FI', next()); continue; }
    if (a === '-O2' || a === '-O3') { cl.push('/O2'); continue; }
    if (a === '-O1' || a === '-Os') { cl.push('/O1'); continue; }
    if (a === '-O0') { cl.push('/Od'); continue; }
    if (a === '-g') { debug = true; continue; }
    if (a === '-w') { cl.push('/w'); continue; }
    if (a === '-Wall' || a === '-Wextra') { cl.push('/W3'); continue; }
    if (a.startsWith('-std=')) continue;
    if (a === '-ffp-contract=off') { cl.push('/fp:precise'); continue; }
    if (a === '-fPIC' || a === '-pthread' || a === '-fno-omit-frame-pointer'
      || a === '-rdynamic' || a.startsWith('-fvisibility')) continue;
    if (a === '-lm' || a === '-lpthread' || a === '-ldl') continue;
    if (a === '-undefined') {
      const v = next();
      throw io.fail(`MSVC 上没有 \`-undefined ${v}\`：Windows 的 DLL 不能留未解析符号。`
        + '插件那一档要么给导入库、要么走延迟加载（任务 #6 还没定）');
    }
    if (a === '-finstrument-functions') {
      /* clang-cl 认这一格（它就是 clang），原样递过去。 */
      if (clangCl) { cl.push(a); continue; }
      /* `cl` 的对应物是 `/Gh`（进）与 `/GH`（出）：每个函数进出各调一次 `_penter`/`_pexit`。
       * 那一对**要我们自己提供**（不在任何库里），而且必须保住所有易失寄存器 ——
       * 见 `runtime/omni_prof_msvc_x64.asm` 与 cli.js 的 `msvcInstrObjs`（那份 .obj 由
       * 工具链自带的 ml64 汇出来、跟着一起链）。 */
      cl.push('/Gh', '/GH');
      continue;
    }
    if (a.startsWith('-Wl,')) { link.push(...a.slice(4).split(',')); continue; }
    if (a.startsWith('-l')) { inputs.push(`${a.slice(2)}.lib`); continue; }
    if (a.startsWith('-')) { cl.push(a); continue; }   // 认不出来的原样递（多半是路径）
    inputs.push(a);
  }
  if (debug) cl.push('/Zi');
  if (shared) cl.push('/LD');
  if (compileOnly) cl.push('/c');
  const args = [...cl, ...inputs];
  if (out !== null) {
    /* `/Fo:` 是目标文件、`/Fe:` 是可执行/动态库。`/Fd:` 一起给：不给的话 `/Zi` 会把
     * 调试信息全写进当前目录的 `vc140.pdb`，并行编几份时互相踩。 */
    args.push(compileOnly ? `/Fo:${out}` : `/Fe:${out}`);
    if (debug) args.push(`/Fd:${out}.pdb`);
  }
  if (selfLibc === true) {
    /* **要 push 到 args**：`cl` 那个数组在上面 `const args = [...cl, ...inputs]` 的时候
     * 就已经被拷走了，往它里头再塞等于扔掉 —— 上一版就是这么把 `/GS-` 丢了，量到的是
     * 一堆 `unresolved external symbol __GSHandlerCheck`。 */
    args.push('/GS-');
    /* clang-cl 这一档：系统头不是靠 `INCLUDE` 进来的（是 clang 自己找 MSVC 找出来的），
     * 掐掉它要用 **`/X`** —— 量过三种写法：
     *   `-nostdlibinc`        clang-cl: warning: unknown argument ignored（**它不认**）
     *   `/X`                  stdio.h 找不到了 = 生效
     *   `/clang:-nostdlibinc` 也生效
     * 取 `/X`（它就是 cl 的同名开关，方言一致）。它只掐系统与 CRT 的头：clang 自己那几个
     * freestanding 头（stddef/stdarg/limits/float）还在 —— 量过，`/X` 之下那四个照样编得过。
     * 这正是我们要的分工：`size_t`/`va_list` 归编译器，`stdio.h`/`string.h` 归我们的 sysroot。 */
    if (clangCl) args.push('/X');
    if (!compileOnly) {
      link.push('/NODEFAULTLIB', '/ENTRY:_start', 'kernel32.lib', 'libvcruntime.lib', 'libcmt.lib',   /* libcmt 只为 __chkstk 那一格（纯汇编，不带 CRT 启动） */
        '/STACK:0x20000000');
    }
  }
  if (link.length > 0) args.push('/link', ...link);
  return args;
}
