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
import { env, isDir, installDir, readText, spawn, stderr } from '../host/native.js';
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
 */
export function cSysInclude(libDir) {
  const out = [libDir === undefined ? join(installDir(), '..', '..', 'include')
    : join(libDir, 'include')];
  const sdk = sdkUsrInclude();
  if (sdk !== null) out.push(sdk);
  return out;
}

/**
 * 一份 `.c` -> MIR（ADR-0017 第六刀）。宿主回调与 `cppText` 同一套。
 * 良构检查在这里做完 —— 前端刚长出来，让 verifier 先骂比让解释器崩掉好查。
 */
export function cMir(path, incs, defs, args, sysIncs) {
  const { mod, warnings } = lowerC(path, readText(path), {
    readFile: (p) => {
      try {
        return readText(p);
      } catch {
        return null;
      }
    },
    includeDirs: incs,
    sysIncludeDirs: sysIncs ?? cSysInclude(),
    dirname,
    join,
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
export function cppText(path, incs, defs, dflag, pflag, deps, sysIncs, incls, verbose, tgt) {
  const cpp = new Cpp({
    readFile: (p) => {
      try {
        return readText(p);
      } catch {
        return null;
      }
    },
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
    readFile: (p) => {
      try {
        return readText(p);
      } catch {
        return null;
      }
    },
    includeDirs: opts.includeDirs,
    sysIncludeDirs: opts.sysIncludeDirs,
    dirname,
    join,
    arch: opts.arch,
    os: opts.os,
  }, defs.map(([name, body]) => ({ name, body })));
}

/**
 * **一份 C 头文件里声明了哪些函数**（ADR-0022 的 J4d：`import "libfoo.dylib" with "foo.h"`）。
 *
 * 与 `cMirNative` 同一个前端、同一套 include 路径 —— 不外挂 tcc、也不另写一个 C 解析器。
 * 回 `{decls, skipped}`：收得下的那些带 C_ABI 的词，收不下的带一句为什么
 * （一个真头文件里总有几条落不进那七个词，不能让其中一条把整次 import 弄失败）。
 */
export function cDeclsOf(path, opts, defs) {
  return declsOfC(path, readText(path), {
    readFile: (p) => {
      try {
        return readText(p);
      } catch {
        return null;
      }
    },
    includeDirs: opts.includeDirs,
    sysIncludeDirs: opts.sysIncludeDirs,
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
