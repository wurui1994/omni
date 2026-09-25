/**
 * **LLVM 这一档**（`--cc clang` / `--cc clang-cl` / `--cc clang++`）在 Windows 上要做的事，
 * 比 MSVC 那一档少一件、多一件。
 *
 *  1. **少的那件：环境不用配。** `cl.exe` 离开开发者命令行连 `stdio.h` 都打不开，所以
 *     `cli/msvc.js` 得自己把 `INCLUDE`/`LIB` 算出来。clang 不用 —— 它自己会找 MSVC 与
 *     Windows SDK（默认目标就是 `x86_64-pc-windows-msvc`）。这不是推断，是量的：
 *     普通 ssh 会话（没有 vcvars、`INCLUDE`/`LIB` 都是空的）里
 *       "C:\Program Files\LLVM\bin\clang.exe"    cc_probe.c -o a.exe   -> 跑起来打印 hi 42
 *       "C:\Program Files\LLVM\bin\clang-cl.exe" cc_probe.c /Fe:b.exe  -> 同上
 *     所以这一档**一格环境变量都不设**：设了反而会盖掉 clang 自己挑的那套。
 *
 *  2. **多的那件：它可能不在 PATH 上。** LLVM 的安装器「加不加 PATH」是装的时候勾的，
 *     不勾就是不在 —— 这台机器上 `where clang` / `where clang-cl` 全是
 *     `INFO: Could not find files for the given pattern(s).`，而 `C:\Program Files\LLVM\bin`
 *     下一整套都在（clang 23.1.2）。于是跟 MSVC 那一档一样：**PATH 只是第一条线索，不是唯一
 *     一条** —— 注册表、默认安装位置、VS 自带的那份（`VC\Tools\Llvm`）都要看。
 *
 * 开关那一头分两种方言，按名字定：`clang`/`clang++` 吃 GNU 说法（跟整棵编译器里拼的一样，
 * 只要滤掉几格 Windows 上没有的），`clang-cl` 吃 `cl` 说法（直接借 `cli/msvc.js` 的
 * `msvcArgs`，它本来就是「GNU -> cl」那台翻译机）。
 */

/** `--cc` 这一格说的是不是 LLVM：三个名字，或者直接指着其中一份 exe。 */
export function isClang(cc) {
  return clangWant(cc) !== null;
}

/** `clang-cl` 那一格（`cl` 方言）。 */
export function isClangCl(cc) {
  return clangWant(cc) === 'clang-cl';
}

/**
 * `--cc` 那一格要的是哪一份 exe（不是 LLVM 就 `null`）。
 * 直接给路径时也按**basename**认方言：`D:\llvm\bin\clang-cl.exe` 还是 `cl` 说法。
 */
export function clangWant(cc) {
  if (!cc) return null;
  const b = String(cc).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
  if (b === 'clang' || b === 'clang-cl' || b === 'clang++') return b;
  return null;
}

/* ------------------------------------------------------------------ 找人 */

/** `<dir>\<name>.exe` 在不在。 */
function inDir(io, dir, name) {
  if (!dir) return null;
  const p = io.join(dir, `${name}.exe`);
  return io.exists(p) ? p : null;
}

/** 问一格注册表的**默认值**（`/ve`）。LLVM 的安装器把根写在这儿。 */
function regDefault(io, key) {
  const r = io.spawn('reg', ['query', key, '/ve'], 'c');
  if (r[0] !== 0) return null;
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(String(r[1] ?? ''));
  return m === null ? null : m[1].trim().replace(/\\$/, '');
}

/** VS 自带的那份 LLVM（VS 安装器里勾「适用于 Windows 的 C++ Clang 工具集」那一格）。 */
function vsLlvmDirs(io, vsRoots) {
  const out = [];
  for (const root of vsRoots) {
    const base = io.join(root, 'VC', 'Tools', 'Llvm');
    /* 新版是 `Llvm\x64\bin` 与 `Llvm\ARM64\bin`，老版只有 `Llvm\bin`（32 位那份）。 */
    for (const sub of ['x64', 'ARM64', 'bin']) {
      out.push(sub === 'bin' ? io.join(base, 'bin') : io.join(base, sub, 'bin'));
    }
  }
  return out;
}

/**
 * **找 LLVM**。次序是「明说的 > PATH > 注册表 > 默认位置 > VS 自带」，每一步都说得出是
 * 从哪儿来的（`from`），找不到就把看过的地方一起报出来。
 *
 * `io` 跟 `cli/msvc.js` 那份是同一套宿主格子；`vsRoots` 是 MSVC 那一档已经找出来的 VS 安装
 * 根（没有就空数组）—— 两档共用一次扫的结果，不重复问 vswhere。
 */
export function clangFind(io, cc, vsRoots) {
  const want = clangWant(cc) ?? 'clang';
  const looked = [];

  /* 0. 明说的那一格：`OMNI_CLANG=<...\bin>` 给目录，或者直接给 exe 的全路径。
   *    机器上装了好几套 LLVM（VS 自带一份、官方安装包一份）、要钉住一套时用。 */
  const pinned = io.env('OMNI_CLANG');
  if (pinned) {
    looked.push(pinned);
    if (io.exists(pinned) && !io.isDir(pinned)) {
      return { exe: pinned, want, from: 'OMNI_CLANG' };
    }
    const p = inDir(io, pinned, want);
    if (p !== null) return { exe: p, want, from: 'OMNI_CLANG' };
  }

  /* 0'. `--cc` 本身就是一条路径（`--cc "C:\Program Files\LLVM\bin\clang.exe"`）。 */
  if (/[\\/]/.test(String(cc)) && io.exists(cc)) {
    return { exe: cc, want, from: '--cc 给的路径' };
  }

  /* 1. PATH 上有就用它 —— 这台机器上没有（装的时候没勾 PATH），但装了的机器上这是最该用的
   *    那一份（外面已经选好的那套工具链）。 */
  const w = io.spawn('where', [`${want}.exe`], 'c');
  if (w[0] === 0 && String(w[1] ?? '').trim()) {
    const first = String(w[1]).split(/\r?\n/)[0].trim();
    if (first && io.exists(first)) return { exe: first, want, from: 'PATH' };
  }
  looked.push(`PATH（where ${want}.exe）`);

  /* 2. 注册表：官方安装包把根写在 `HKLM\SOFTWARE[\WOW6432Node]\LLVM\LLVM` 的默认值上。 */
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\LLVM\\LLVM', 'HKLM\\SOFTWARE\\LLVM\\LLVM']) {
    const root = regDefault(io, key);
    if (root === null || root === '') continue;
    looked.push(root);
    const p = inDir(io, io.join(root, 'bin'), want);
    if (p !== null) return { exe: p, want, from: `注册表（${key}）` };
  }

  /* 3. 默认位置。`LOCALAPPDATA` 那两条是「只给当前用户装」那一档。 */
  const dirs = [];
  for (const base of [io.env('ProgramFiles'), io.env('ProgramFiles(x86)'), io.env('LOCALAPPDATA')]) {
    if (!base) continue;
    dirs.push(io.join(base, 'LLVM', 'bin'));
    dirs.push(io.join(base, 'Programs', 'LLVM', 'bin'));
  }
  /* 4. VS 自带的那份（PATH 与注册表都没有时，机器上往往还有这一份）。 */
  dirs.push(...vsLlvmDirs(io, vsRoots ?? []));
  for (const d of dirs) {
    looked.push(d);
    const p = inDir(io, d, want);
    if (p !== null) return { exe: p, want, from: `装在默认位置（${d}）` };
  }

  return { exe: null, want, from: null, looked };
}

/* ------------------------------------------------------------ 翻开关 */

/** `AMD64` / `ARM64` / `x86` 折成 LLVM 三元组里那一格。 */
function llvmArch(a) {
  const s = String(a || '').toLowerCase();
  if (s === 'arm64' || s === 'aarch64') return 'aarch64';
  if (s === 'x86' || s === 'i386' || s === 'ia32') return 'i686';
  return 'x86_64';
}

/**
 * 交叉那一格：clang 一份 exe 打所有目标，靠 `--target=` 说。**只在目标与宿主不一样时给**
 * —— 给了就等于把 clang 自己挑的那套默认（`x86_64-pc-windows-msvc`）覆盖掉，同架构时
 * 不必多此一举。`clang-cl` 认同一个开关。
 */
export function clangTargetArgs(hostArch, targetArch) {
  if (!targetArch) return [];
  const h = llvmArch(hostArch);
  const t = llvmArch(targetArch);
  return h === t ? [] : [`--target=${t}-pc-windows-msvc`];
}

/**
 * **GNU 说法 -> clang 在 Windows 上吃的说法**。绝大多数开关原样过去（整棵编译器里拼的就是
 * GNU 说法，clang 的 driver 认），要动的只有几格：
 *
 *   `-lm` `-lpthread` `-ldl`  这三样在 Windows 上没有对应的库：数学函数在 UCRT 里、线程在
 *                             kernel32 里。留着就是 `lld-link: could not open 'm.lib'`。
 *   `-fPIC` `-rdynamic`       PE 的 DLL 本来就位置无关；没有「把符号全导出去」这一格。
 *                             （clang 只会喊一句 `argument unused`，但那句会淹掉真正的话。）
 *   `-undefined dynamic_lookup`  Windows 上没有「留着不解析」这回事 —— 当场报错而不是悄悄丢，
 *                             理由与 `msvcArgs` 里同一格一样（任务 #6 还没定）。
 *
 * `-finstrument-functions` **不在要滤的那一格里**：clang 认它，`--profile cc|stub` 这一档
 * 在 clang 上是通的（`msvcArgs` 里那句「先用 `--cc clang`」说的就是这儿）。
 */
export function clangArgs(argv, io, opts) {
  const o = opts ?? {};
  /* `-D_USE_MATH_DEFINES`：Windows 上头是 UCRT 的 `<math.h>`，它只在这一格开着时才给
   * `M_PI`/`M_E` 那一族（严格说它们不是 C 标准的一部分，别的 libc 默认给）。量到的是
   *   omni_r3.c:1320: error: use of undeclared identifier 'M_PI'
   * 这是"这条腿的方言"，所以摆在这儿，不是去改运行时那几份 .c。 */
  const out = ['-D_USE_MATH_DEFINES'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-lm' || a === '-lpthread' || a === '-ldl') continue;
    if (a === '-fPIC' || a === '-rdynamic') continue;
    if (a === '-undefined') {
      const v = argv[++i];
      throw io.fail(`Windows 上没有 \`-undefined ${v}\`：PE 的 DLL 不能留未解析符号。`
        + '插件那一档要么给导入库、要么走延迟加载（任务 #6 还没定）');
    }
    out.push(a);
  }
  if (o.target !== undefined) out.unshift(...o.target);
  /* **自带 libc 那一档**：`-nostdlibinc` 只掐掉「系统与 CRT 的头」，clang 自己那几个
   * freestanding 头（`stddef.h` / `stdarg.h` / `limits.h` / `float.h`）还留着 —— 那正是
   * 我们要的分工：`size_t` / `va_list` 归编译器，`stdio.h` / `string.h` 归我们的 sysroot。
   * （MSVC 那一档没有这个开关，所以那边得自己在 `sysroot/win32/cc-include` 里补三个头。）
   *
   * **我们那套头往哪儿找不在这儿说**（`cli.js` 的 `selfIncArgs` 递 `-I`）：libc 自己那几份
   * `.c` 要的是另一套内部头，它们也走这条路 —— 在这儿加就等于把公开那套头塞给它们。
   *
   * 链接那一头与 msvc 同一套：不带 CRT、入口是我们的 `_start`。 */
  if (o.selfLibc === true) {
    out.push('-nostdlibinc');
    if (!argv.includes('-c')) {
      /* 链接那一头与 msvc 那一档**同一套**（见 `msvcArgs` 里同一格）：不带 CRT、入口是我们的
       * `_start`、栈留够。`libcmt.lib` 只为 `__chkstk` 那一格（纯汇编的 chkstk.obj，不带
       * CRT 启动代码）—— 少了它量到的是 `lld-link: error: undefined symbol: __chkstk`。
       * 库名走 `-Wl,` 原样递给 lld-link（它把非开关的参数当输入文件）。 */
      out.push('-nostdlib', '-Wl,/NODEFAULTLIB', '-Wl,/ENTRY:_start',
        '-Wl,/STACK:0x20000000',
        '-Wl,kernel32.lib', '-Wl,libvcruntime.lib', '-Wl,libcmt.lib');
    }
  }
  return out;
}
