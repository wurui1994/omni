// src/core/lang/c.js —— C 前端那条腿的插件外壳（ADR-0021 的 S4）
//
// 与另外几门同一条规矩：**不 import cli.js**。这一份装的是"C 源码怎么变成 MIR"那一段，
// 以及它自己的**系统头怎么找**（SDK 根、`/usr/include`、随包带的那一份）—— 那是 C 特有的事，
// 别的语言一格都用不上。
//
// 写目标文件（cObj / relaSeq / ehFrameOf）**不**在这里：那是链接那一摊（以后的 omni-native），
// 与"C 这门语言"是两回事 —— 它只是 cMir 的一个下游。

import { OmniError } from '../source/diag.js';
import { join, dirname } from '../host/path.js';
import { env, exists, isDir, installDir, mtimeMs, readText, spawn, stderr } from '../host/native.js';
import { C_INCLUDE_DIR } from '../runtime/c_runtime.js';
import { lowerC, lowerCNative, declsOfC } from '../frontend-c/tccgen.js';
import { Cpp } from '../frontend-c/tccpp.js';
import { verifyMir } from '../mir/verify.js';

/* SDK 根找一次就记住（一趟里 spawn xcrun 那一下是几十毫秒，而系统头每个文件都要问一遍）。
   跟着 sdkRoot 一起住在这儿：它是这门语言"上哪找系统头"的状态，不是驱动的状态。 */
let sdkRootCache;

export function sdkRoot() {
  if (sdkRootCache !== undefined) return sdkRootCache;
  const roots = [];
  const fromEnv = env('SDKROOT');
  if (fromEnv !== undefined && fromEnv !== '') roots.push(fromEnv);
  roots.push('/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk');
  roots.push('/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform'
    + '/Developer/SDKs/MacOSX.sdk');
  for (const r of roots) {
    if (isDir(join(r, 'usr', 'include'))) {
      sdkRootCache = r;
      return r;
    }
  }
  let out = '';
  try {
    const [code, so] = spawn('xcrun', ['--show-sdk-path'], 'c');
    if (code === 0) out = so.trim();
  } catch {
    out = '';
  }
  sdkRootCache = out !== '' && isDir(out) ? out : null;
  return sdkRootCache;
}

export function sdkUsrInclude() {
  const r = sdkRoot();
  if (r === null) return null;
  const p = join(r, 'usr', 'include');
  return isDir(p) ? p : null;
}

/** SDK 的 `usr/lib` —— `-l` 找库的那一格，与 `tcc_add_macos_sdkpath` 找的同一处。 */
export function sdkUsrLib() {
  const r = sdkRoot();
  if (r === null) return null;
  const p = join(r, 'usr', 'lib');
  return isDir(p) ? p : null;
}

/**
 * C 前端的系统头目录，与 tcc 的 `sysinclude_paths` 同一形状：**自带那一份在前**
 * （tcc 的 `{B}/include`，我们是 `src/include` —— 位置与 `RUNTIME_DIR` 同一手法：
 * 相对程序镜像固定两级上去，于是不依赖当前工作目录），**本机 SDK 的
 * `/usr/include` 在后**（第八十八片）。`-isystem` 给的排在这两段前头，
 * `-nostdinc` 把这两段一起掐掉。
 *
 * `libDir` 给了就**换掉**自带那一份（`libDir/include`）—— 那是 tcc 的 `-B`
 * （`tcc_lib_path`）：tcc 里 `{B}/include` 就是自带那一份的位置，不是多一条。
 * SDK 那一段照留（tcc 的 `CONFIG_TCC_SYSINCLUDEPATHS` 也不受 `-B` 影响）。
 *
 * 自带那一份**先按数据目录找**（`dataDir('include', 'stdbool.h')`，与 `RUNTIME_DIR`
 * 同一条规矩），找不着才退回源码树里的相对位置。少了这一格，**装好的**编译器
 * （`dist/omni`、自举的 N1）一编 C 就是
 * `share/runtime/omni.h:19: error: include file 'stdbool.h' not found` ——
 * `installDir()/../../include` 在源码树里是 `src/include`，在 dist 布局里什么都不是。
 * 第一百三十八片量到的（`OMNI_CC=self` 的第 2 阶段）。
 */
export function cSysInclude(libDir) {
  const out = [libDir === undefined ? C_INCLUDE_DIR : join(libDir, 'include')];
  const sdk = sdkUsrInclude();
  if (sdk !== null) out.push(sdk);
  /* **Linux（与别的没有 SDK 那一套的宿主）那几处**（第一百四十七片）：
   * `sdkUsrInclude` 是问 `xcrun` 的，只有 macOS 答得出来 —— 在别处它回 null，
   * 于是这张表只剩自带那一份，`#include <stdio.h>` 当场找不着
   * （量出来的：x86_64 Arch 容器里 `omni build bench/fib.omni` 停在
   * `src/runtime/omni.h:15: error: include file 'stdio.h' not found`）。
   *
   * 顺序照 clang / tcc 的默认：`/usr/local/include` 在前、多架构那一层
   * （Debian/Ubuntu 的 `/usr/include/<triple>`）居中、`/usr/include` 在最后。
   * **只放真存在的**：这张表每 include 一次就要走一遍，摆一堆不存在的路径只是白试
   * （与 `cFrameworks` 同一条规矩）。macOS 上这三处一般都不存在，所以那条腿一个字不变。 */
  for (const p of ['/usr/local/include', '/usr/include/x86_64-linux-gnu',
    '/usr/include/aarch64-linux-gnu', '/usr/include']) {
    if (isDir(p)) out.push(p);
  }
  return out;
}

/**
 * **framework 的头文件目录**（macOS，ADR-0022 的 J4d）。clang 的 `-F` 那张表。
 *
 * `#include <OpenGL/gl.h>` 在苹果那边不是"某个目录下的 OpenGL/gl.h"，而是
 * `<F>/OpenGL.framework/Headers/gl.h`。量出来的：`<GLFW/glfw3.h>` 第 237 行 include 的
 * 正是 `<OpenGL/gl.h>` —— 少了这张表，一份真的 GLFW 头连预处理都过不去。
 *
 * SDK 里那一份在前、系统那两处在后（与 clang 的默认顺序一样）。不存在的目录不放进来：
 * 这张表每 include 一次就要走一遍，放一堆不存在的路径只是白试。
 */
export function cFrameworks() {
  const out = [];
  const r = sdkRoot();
  if (r !== null) {
    const p = join(r, 'System', 'Library', 'Frameworks');
    if (isDir(p)) out.push(p);
  }
  for (const p of ['/Library/Frameworks', '/System/Library/Frameworks']) {
    if (isDir(p)) out.push(p);
  }
  return out;
}

/**
 * 一个候选路径读得着就回内容，读不着回 `null`（`Cpp` 那格 `readFile` 要的就是这个约定）。
 *
 * **不能写成 `try { readText(p) } catch { return null }`** —— 那样只在 node 上成立。
 * try/catch 本身两条腿都有（C 那边降成「待决异常槽」，`omni_js_pending()` 那一套），
 * 差的是**宿主读文件失败走的不是那条路**：`omni_js_host.c:146` 打的是 `omni_errorf`
 * （致命，当场收摊），而 node 上 `readFileSync` 抛的是一个真异常、接得住。于是症状是
 * **自己编出来的编译器再去编 C** 时死在头一个候选上：
 *
 *   omni: runtime error: ENOENT: cannot read '<工作目录>/omni.h'
 *
 * 而那个候选本来就该落空 —— `#include "omni.h"` 先找源文件同目录、再走 `-I`。
 * 这一格是 `omni bootstrap` 在 `OMNI_CC=self` 下第 2 阶段（N2 = N1 build）挂掉的原因，
 * 第一百三十八片量到的。`exists` 是纯查询，两条腿上都不抛。
 *
 * 「读失败该是可接住的异常而不是致命错误」那处**两条腿的不对称**还欠着，记在这儿；
 * 这一格不靠它 —— 探测存在性本来就比"抛了再接"便宜。
 *
 * **读过的内容按路径记一份**（第一百三十九片，量出来的）：一趟里同一份头会被读很多遍 ——
 * 20 份运行时各 `#include "omni.h"`，那条链再往下是 SDK 的 stdio/stdlib/string 一族。
 * 在一个进程里编那 20 份，`readFileUtf8` 占了 CPU 的 **15%**（1518ms 的样本里 223ms）。
 * 记一份之后同一个进程里第二次就是查表。**按 mtime 复核**，所以 REPL 那种长住的进程里
 * 改了头文件也算得对（一次 stat ~1µs，比读+解码一份 100KB 的头便宜两个数量级）。
 */
const FILE_TEXT = new Map();

function readOrNull(p) {
  if (!exists(p)) return null;
  const m = mtimeMs(p);
  const hit = FILE_TEXT.get(p);
  if (hit !== undefined && hit.mtime === m) return hit.text;
  const text = readText(p);
  FILE_TEXT.set(p, { mtime: m, text });
  return text;
}

/**
 * 一份 `.c` -> MIR（ADR-0017 第六刀）。宿主回调与 `cppText` 同一套。
 * 良构检查在这里做完 —— 前端刚长出来，让 verifier 先骂比让解释器崩掉好查。
 *
 * `tgt`（`{arch, os}`）只管**预定义宏**：这条腿读的是**这台机器真的**系统头，
 * 而头文件按 `__x86_64__` / `__linux__` 分支。少这一格的代价在 x86_64 容器里量到了：
 * `omni c run x.c` 报 `/usr/include/gnu/stubs.h:7: error: include file
 * 'gnu/stubs-32.h' not found`（预定义说自己是 arm64-osx，glibc 的头于是走 32 位那支）。
 *
 * 这条腿的 **ABI** 仍旧是那个虚拟目标（`long double` = double、`wchar_t` = int、
 * `char` 有符号），由 `lowerC` 自己钉住 —— 见那儿的注。
 */
export function cMir(path, incs, defs, args, sysIncs, tgt) {
  const { mod, warnings } = lowerC(path, readText(path), {
    readFile: readOrNull,
    includeDirs: incs,
    sysIncludeDirs: sysIncs ?? cSysInclude(),
    dirname,
    join,
    arch: tgt?.arch,
    os: tgt?.os,
  }, defs.map(([name, body]) => ({ name, body })), args);
  for (const w of warnings) stderr(`${w}\n`);
  const errs = verifyMir(mod);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  return mod;
}

/**
 * 登记（ADR-0021 的 S4）：C 这门语言交给驱动的那几格本事。
 *
 * 驱动**不许**直接 `import { cMir }` —— 只要还有一条直连，摇树就把这门语言整条拽进核心，
 * "核心不带 C 前端"就是空话（量出来的：--builtins min 只省 96 KB）。所以按名字给。
 * `.c` 不登记成"语言"：它由 `omni c` 那一组命令驱动（obj / tcc / mir 各有各的产物），
 * 不走"按扩展名认 -> 出 OIR"那条路。
 */
/**
 * 一份 `.c` -> 预处理后的文本。**格式与 `tcc -E` 逐字节相同**（ADR-0017 第五刀）：
 * 默认带 GCC 那种 `# 行号 "文件"` 的行标，`-P` 一族把它换掉或关掉。
 * 文件 IO 在这里，预处理器自己只认一个 `readFile` 回调 —— 于是 REPL 那一路可以把
 * 内存里的几份 `.h` 直接喂进去，测试也不必碰 fs。
 */
export function cppText(path, incs, defs, dflag, pflag, deps, sysIncs, incls, verbose, tgt, skipMissing) {
  const cpp = new Cpp({
    readFile: readOrNull,
    includeDirs: incs,
    /* 自己那一格直接调本地函数 —— 不绕 cap()：这一份独立成插件时 `cap` 不在它的作用域里
       （量出来是 `unresolved function 'cap'`），而"C 的系统头在哪"本来就是它自己的事。 */
    sysIncludeDirs: sysIncs ?? cSysInclude(),
    dirname,
    join,
    /* 目标（`--arch` / `--os`）：预定义宏那一整张表按它分（第一百二十九片）。
     * `__x86_64__` 与 `__linux__` 一变，头文件就走另一支 —— 于是「拿哪个 tcc 当尺子」
     * 这件事在命令行上说得出来。 */
    arch: tgt?.arch,
    os: tgt?.os,
  });
  /* `-dD` = 3、`-dM` = 7（tcc 的 `dflag`）。拨在装预定义**之前** —— `-dD`/`-dM` 要印的
   * 头一批就是预定义那几行，攒行的开关得先开（见 tccpp.js 的 `cmdlineDump`）。
   * `ppOnly` 同理：命令行那一层出的警告，前头那个空行也得算进输出里。 */
  cpp.dflag = dflag ?? 0;
  cpp.ppOnly = true;
  /* `--skip-missing-includes`：找不到的头当空文件（每份记一条警告）。默认关着 ——
   * 开着的时候输出就**不再**与 `tcc -E` 逐字节相同了，所以这一格必须由命令行明说。 */
  cpp.skipMissingIncludes = skipMissing === true;
  cpp.installPredefs(path);
  /* `-include`：开工前先读的那几份（压在主文件上面的 `<command line>` 那一层）。 */
  if (incls !== undefined) cpp.cmdlineIncls = incls;
  /* `-v` 的那一格：2 = 每开一个文件印一行 `->`，3 = 连试不开的也印（`nf`）。 */
  cpp.verbose = verbose ?? 0;
  /* `-D` 与 `-U` 共用一条顺序（宏体 `null` = `#undef`）。 */
  for (const [name, body] of defs) {
    if (body === null) cpp.undefine(name);
    else cpp.define(name, body);
  }
  /* `-P` 那一格（tcc 的 `Pflag`）：0 = `# 行号 "文件"`、1 = 不印、2 = `#line`、11 = `-P10`。 */
  cpp.Pflag = pflag ?? 0;
  /* `-M` 一族：把读过的头记下来（`genDeps`），`-M`/`-MD` 连系统头一起记。 */
  if (deps !== undefined) {
    cpp.genDeps = true;
    cpp.includeSysDeps = deps.sys === true;
    cpp.targetDeps.push(path);   // 主文件在最前（tcc 是 `tcc_add_file_internal` 加的）
  }
  const out = cpp.preprocessToText(path, readText(path));  for (const w of cpp.warnings) stderr(`${w}\n`);
  if (deps !== undefined) deps.list = cpp.targetDeps;
  return out;
}

/**
 * `.c` -> **原生** MIR（`omni c obj` 那条路）。与 `cMir` 的差别只有一个：走 `lowerCNative`，
 * 出来的 MIR 没有线性内存，地址就是真地址。
 *
 * 读文件、预处理、降级都在这一门语言里 —— 驱动只递参数、拿 `{ mod, warnings }`。
 */
export function cMirNative(path, opts, defs) {
  return lowerCNative(path, readText(path), {
    readFile: readOrNull,
    includeDirs: opts.includeDirs,
    sysIncludeDirs: opts.sysIncludeDirs,
    frameworkDirs: opts.frameworkDirs ?? cFrameworks(),
    dirname,
    join,
    arch: opts.arch,
    os: opts.os,
    /* `-finstrument-functions`（第一百五十片第三格）：每个函数进出各插一次
     * `__cyg_profile_func_enter/exit`。`omni run x.c --profile cc` 那一趟要它 ——
     * 于是 `.c` 输入上「精确的调用次数与自用时间」不再要外部编译器。 */
    instrument: opts.instrument === true,
  }, defs.map(([name, body]) => ({ name, body })));
}

/**
 * **一份 C 头文件里声明了哪些函数**（ADR-0022 的 J4d：`import "libfoo.dylib" with "foo.h"`）。
 *
 * 与 `cMirNative` 同一个前端、同一套 include 路径 —— 不外挂 tcc、也不另写一个 C 解析器。
 * 回 `{decls, skipped, consts, constSkipped}`：收得下的那些带 C_ABI 的词，收不下的带一句
 * 为什么（一个真头文件里总有几条落不进那七个词，不能让其中一条把整次 import 弄失败）。
 *
 * `opts.text` 那一路是给**系统头**用的（`import "libm" with "math.h"`）：那种头不在 `-I`
 * 的目录里、也不在源码旁边，找它的规则就是 C 前端自己那条 include 搜索路径。所以那一路
 * 不读文件，而是把一份合出来的 `#include <math.h>` 递进来；`path` 只当"这段文本在哪儿"
 * 用（`__FILE__` 与相对 include 的起点）。
 */
export function cDeclsOf(path, opts, defs) {
  return declsOfC(path, opts.text === undefined ? readText(path) : opts.text, {
    readFile: readOrNull,
    includeDirs: opts.includeDirs,
    sysIncludeDirs: opts.sysIncludeDirs,
    frameworkDirs: opts.frameworkDirs ?? cFrameworks(),
    dirname,
    join,
    arch: opts.arch,
    os: opts.os,
  }, (defs ?? []).map(([name, body]) => ({ name, body })));
}

export function registerCLang(api) {
  api.registerCap('c.toMir', cMir);
  api.registerCap('c.sysInclude', cSysInclude);
  api.registerCap('c.usrLib', sdkUsrLib);
  api.registerCap('c.preprocess', cppText);
  api.registerCap('c.toMirNative', cMirNative);
  api.registerCap('c.declsOf', cDeclsOf);
}
