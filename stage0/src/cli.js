#!/usr/bin/env node
// Omni stage0 — 命令行入口
//
//   omni run     f.omni      解析 -> OIR -> JS -> 进程内执行（这就是「直接解析执行」在 JS 宿主上的形态）
//   omni run-c   f.omni      解析 -> OIR -> C -> cc -> 执行
//   omni emit-js f.omni      打印生成的 JS
//   omni emit-c  f.omni      打印生成的 C
//   omni build   f.omni -o a 生成原生可执行文件
//   omni ast/oir f.omni      打印中间结果（调试用）

import {
  writeText, readText, exists, readDir, mtimeMs, fileSize, mkdirAll, rename,
  args as procArgs, env, stdout, stderr, setExitCode, spawn, evalJs, hasJsEngine, nowMs,
  cwd, installDir, isDir, writeBinary, readBinary,
} from './host/native.js';
import { join, basename, dirname, isAbsolute, resolve } from './host/path.js';
import { hash16 } from './host/hash.js';
import { linkJs } from './frontend-js/link.js';
import { lowerJs } from './frontend-js/lower.js';import { lowerWat } from './frontend-wat/lower.js';
import { lowerAsy } from './frontend-asy/lower.js';
import { asyUnitModules } from './frontend-asy/link.js';
import { parseAsyBuiltins } from './frontend-asy/types.js';
import { lowerJnc } from './frontend-jnc/lower.js';
import { Cpp } from './frontend-c/tccpp.js';
import { lowerC, lowerCNative } from './frontend-c/tccgen.js';
import { genModule as genArm64 } from './arm64/from_mir.js';
import { genModule as genX64 } from './x64/from_mir.js';
import { writeObject } from './link/macho.js';
import { writeObject as writeElfObject } from './link/elf.js';
import { mergeObjects as mergeElfObjects } from './link/elf_merge.js';
import { peLoad, PE_GUI } from './link/pe_load.js';
import { peWrite } from './link/pe_link.js';
import { elfExe } from './link/elf_exe.js';
import { machoExe, isMachoBinary } from './link/macho_exe.js';
import { readSexpr } from './sexpr/read.js';
import { lowerCoreSexpr } from './sexpr/lower.js';
import { printSexpr } from './sexpr/print.js';
import { readGrammar } from './glr/grammar.js';
import { buildTable, dumpTable, tableText, tableFromText, TABLE_FORMAT } from './glr/table.js';
import { lexText } from './glr/lex.js';
import { glrParse } from './glr/driver.js';
import { lowerToMir } from './mir/from_oir.js';
import { printMir } from './mir/print.js';
import { verifyMir } from './mir/verify.js';
import { dumpBytes } from './mir/bytes.js';
import { IncrCache, compileIncremental, incrReport } from './incr/cache.js';
import { Diagnostics, OmniError, SourceFile } from './source/diag.js';
import { check } from './hir/check.js';
import { pruneFuncs } from './hir/prune.js';
import { cAbiLibs } from './hir/c_abi.js';
import { emitJs, emitJsFunc, emitJsRuntimeModule } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';
import { emitLlvm } from './backend-llvm/emit.js';
import { emitSpirv } from './backend-spirv/emit.js';
import { RUNTIME_DIR, JIT_DIR, runtimeSources } from './runtime/c_runtime.js';
import { loadProgram, MODE_BY_EXT } from './module/load.js';
import { startRepl } from './repl.js';
import { interpret } from './interp/eval.js';
import { interpretMir, runMirModule } from './mir/interp.js';
import { bootstrapSelf } from './bootstrap.js';

/**
 * `-I <目录>` 收成一张有序的表（可重复，第六十二刀）。jancy 的 `jnc` 就是这个开关，
 * 它把每个 `-I` 追加进 `m_importDirList`，找 import 时按**给的顺序**逐个试
 * （jnc_ct_ImportMgr.cpp:110-119 -> axl_io_FilePathUtils.cpp:419-449）。
 * 顺序有意义，所以这儿不去重、不排序 —— 只把 `-I` 后面那一格照原样收下来。
 */
function incDirs(argv) {
  const out = [];
  let i = 0;
  for (const a of argv) {
    if (a === '-I') {
      const d = argv[i + 1];
      if (d === undefined || d.startsWith('-')) throw new OmniError('-I 后面要一个目录');
      out.push(d);
    } else if (a.startsWith('-I') && a.length > 2) {
      out.push(a.slice(2)); // `-I目录`（贴着写，tcc 两种都认）
    }
    i++;
  }
  return out;
}

/**
 * `-D 名字` / `-D 名字=宏体` / `-D名字`，以及 `-U 名字` / `-U名字`（都与 tcc 同形）。
 * 回 [名字, 宏体] 的表，**宏体 `null` = `#undef`**。
 *
 * 顺序有意义，而且 `-D` 与 `-U` **共用一条顺序**：tcc 两个都往同一个 `cmdline_defs`
 * 缓冲里写文本（`#define …` / `#undef …`，libtcc.c:859、865），所以
 * `-DX=1 -UX` 与 `-UX -DX=1` 是两回事。
 *
 * **没有 `=` 的宏体是 `1`，不是空**（tcc 的 `tcc_define_symbol`：`value = *eq ? eq+1 : "1"`）。
 * 这一条不是细节：`config.h` 里 `#if !(TCC_TARGET_I386 || … || TCC_TARGET_ARM64 || …)`
 * 那一行要求每个名字都能当数用，展开成空就是「bad preprocessor expression」。
 * `-D 名字=`（等号后面什么都没有）才是空宏体 —— tcc 也是这么分的。
 */
function defArgs(argv) {
  const out = [];
  let i = 0;
  for (const a of argv) {
    let d = null;
    let u = null;
    if (a === '-D') {
      d = argv[i + 1];
      if (d === undefined || d.startsWith('-')) throw new OmniError('-D 后面要一个名字');
    } else if (a.startsWith('-D') && a.length > 2) {
      d = a.slice(2);
    } else if (a === '-U') {
      u = argv[i + 1];
      if (u === undefined || u.startsWith('-')) throw new OmniError('-U 后面要一个名字');
    } else if (a.startsWith('-U') && a.length > 2) {
      u = a.slice(2);
    }
    if (d !== null) {
      const eq = d.indexOf('=');
      out.push(eq < 0 ? [d, '1'] : [d.slice(0, eq), d.slice(eq + 1)]);
    } else if (u !== null) {
      out.push([u, null]);
    }
    i++;
  }
  return out;
}

/**
 * 系统头目录（tcc 的 `sysinclude_paths`）：`-isystem` 给的排在**前面**，
 * 自带的那一份排后面 —— tcc 的次序（`-isystem` 在选项里就加，
 * `CONFIG_TCC_SYSINCLUDEPATHS` 是 `tcc_set_output_type` 里补的，libtcc.c:973）。
 * `-nostdinc` 只掐掉自带的那一份，`-isystem` 给的照留。
 */
function sysIncDirs(argv) {
  const out = [];
  let i = 0;
  for (const a of argv) {
    if (a === '-isystem') {
      const d = argv[i + 1];
      if (d === undefined) throw new OmniError('-isystem 后面要一个目录');
      out.push(d);
    }
    i++;
  }
  if (!argv.includes('-nostdinc')) out.push(...cSysInclude());
  return out;
}

/** `-include 文件`（tcc 的 `cmdline_incl`）：开工前先读的那几份，按命令行次序。 */
function inclArgs(argv) {
  const out = [];
  let i = 0;
  for (const a of argv) {
    if (a === '-include') {
      const f = argv[i + 1];
      if (f === undefined) throw new OmniError('-include 后面要一个文件');
      out.push(f);
    }
    i++;
  }
  return out;
}

/**
 * 本机 SDK 的 `/usr/include`（tcc 的 `CONFIG_TCC_SYSINCLUDEPATHS` 里第二段）。
 *
 * tcc 那边这一段是 **configure 时**定死的 —— `configure:370` 就一句
 * `tcc_usrinclude="$(xcrun --show-sdk-path)/usr/include"`，接着
 * `default tcc_sysincludepaths "{B}/include:$tcc_usrinclude"`，编成
 * `-DCONFIG_TCC_SYSINCLUDEPATHS=…`，运行时只是 `tcc_add_sysinclude_path`
 * 把它按 `:` 拆开（libtcc.c:976）。Omni 没有 configure 那一步，于是同一件事
 * 挪到第一次用的时候做，按代价从小到大试：
 *
 *   1. `SDKROOT`（clang 的老规矩，交叉/CI 上常设）
 *   2. 那两条写死的路径 —— 与 tcc 找库时的退路同一份
 *      （`tccmacho.c:2287`：CommandLineTools 与 Xcode.app）
 *   3. `xcrun --show-sdk-path` —— 真要开子进程才走这一步
 *
 * 一个都不成（不是 macOS、SDK 没装）就只剩自带那一段，与这一片之前一样。
 */
let sdkRootCache;
function sdkRoot() {
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
function sdkUsrInclude() {
  const r = sdkRoot();
  if (r === null) return null;
  const p = join(r, 'usr', 'include');
  return isDir(p) ? p : null;
}
/** SDK 的 `usr/lib` —— `-l` 找库的那一格，与 `tcc_add_macos_sdkpath` 找的同一处。 */
function sdkUsrLib() {
  const r = sdkRoot();
  if (r === null) return null;
  const p = join(r, 'usr', 'lib');
  return isDir(p) ? p : null;
}

/**
 * C 前端的系统头目录，与 tcc 的 `sysinclude_paths` 同一形状：**自带那一份在前**
 * （tcc 的 `{B}/include`，我们是 `stage0/include` —— 位置与 `RUNTIME_DIR` 同一手法：
 * 相对程序镜像固定两级上去，于是不依赖当前工作目录），**本机 SDK 的
 * `/usr/include` 在后**（第八十八片）。`-isystem` 给的排在这两段前头，
 * `-nostdinc` 把这两段一起掐掉。
 */
function cSysInclude() {
  const out = [join(installDir(), '..', '..', 'include')];
  const sdk = sdkUsrInclude();
  if (sdk !== null) out.push(sdk);
  return out;
}

/**
 * 一份 `.c` -> 预处理后的文本。**格式与 `tcc -E` 逐字节相同**（ADR-0017 第五刀）：
 * 默认带 GCC 那种 `# 行号 "文件"` 的行标，`-P` 一族把它换掉或关掉。
 * 文件 IO 在这里，预处理器自己只认一个 `readFile` 回调 —— 于是 REPL 那一路可以把
 * 内存里的几份 `.h` 直接喂进去，测试也不必碰 fs。
 */function cppText(path, incs, defs, dflag, pflag, deps, sysIncs, incls, verbose) {
  const cpp = new Cpp({
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
  });
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
  /* `-dD` = 3、`-dM` = 7（tcc 的 `dflag`）。 */
  cpp.dflag = dflag ?? 0;
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
 * `gen_makedeps`（tcctools.c:599）：一条 make 规则。
 *
 * ```
 * 目标: \
 *   dep1 \
 *   dep2
 * ```
 * 去重是**印的时候**做的（记的时候重复留着），空白按 `escape_target_dep` 加反斜杠
 * （`is_space` 那五个字符，不含换行）。`-MP`（`gen_phony_deps`）再给**除主文件之外**
 * 每个头补一条空规则 —— 头文件被删掉时 make 不会因为「没有规则可做」而停下来。
 */
function makedepsText(target, list, phony) {
  const deps = [];
  for (const d of list) if (!deps.includes(d)) deps.push(d);
  const esc = (s) => s.replace(/[ \t\v\f\r]/g, (c) => `\\${c}`);
  let out = `${target}:`;
  for (const d of deps) out += ` \\\n  ${esc(d)}`;
  out += '\n';
  if (phony) for (let i = 1; i < deps.length; i++) out += `${esc(deps[i])}:\n`;
  return out;
}

/**
 * `default_outputfile`（tcc.c:251）在 `-M` 那一路上算出来的名字：**basename** 的后缀
 * 换成 `.o`，没有后缀就是 `a.out`。`-M` 印出来的目标就是它（不是 `-o`，除非真给了 `-o`）。
 */
function depTarget(file) {
  const b = basename(file);
  const i = b.lastIndexOf('.');
  return i > 0 ? `${b.slice(0, i)}.o` : 'a.out';
}

/**
 * 一份 `.c` -> MIR（ADR-0017 第六刀）。宿主回调与 `cppText` 同一套。
 * 良构检查在这里做完 —— 前端刚长出来，让 verifier 先骂比让解释器崩掉好查。
 */
function cMir(path, incs, defs, args) {
  const { mod, warnings } = lowerC(path, readText(path), {
    readFile: (p) => {
      try {
        return readText(p);
      } catch {
        return null;
      }
    },
    includeDirs: incs,
    sysIncludeDirs: cSysInclude(),
    dirname,
    join,
  }, defs.map(([name, body]) => ({ name, body })), args);
  for (const w of warnings) stderr(`${w}\n`);
  const errs = verifyMir(mod);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  return mod;
}

/**
 * 一份 `.c` -> 一个**目标文件**（ADR-0017 第九刀第二十六片）。
 *
 * 与 `cMir` 的差别只有一个：走 `lowerCNative` —— 出来的 MIR 没有线性内存，地址就是真
 * 地址，全局与串常量是数据段里的真符号，libc 直接调。生成之后写一个 Mach-O 的
 * `MH_OBJECT`，之后由 `clang`（或我们自己的链接器）与 crt/libc 链起来。
 *
 * `arch` 给 `x86_64` 就在 Apple Silicon 上交叉出 Rosetta 能跑的码，不给按本机。
 */
function cObj(path, out, arch, incs, defs, fmt, os) {
  const { mod, warnings } = lowerCNative(path, readText(path), {
    readFile: (p) => {
      try {
        return readText(p);
      } catch {
        return null;
      }
    },
    includeDirs: incs,
    sysIncludeDirs: cSysInclude(),
    dirname,
    join,
    /* 预定义宏里目标 CPU 那三条跟着 `--arch` 走（第一百〇二片）：`__x86_64__` 一变，
     * tinycc 自己的源码就走 x86_64 那一支，不必手工递 `-DTCC_TARGET_X86_64`。 */
    arch: arch === 'x86_64' ? 'x86_64' : 'arm64',
  }, defs.map(([name, body]) => ({ name, body })));
  for (const w of warnings) stderr(`${w}\n`);
  const errs = verifyMir(mod);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  const blob = arch === 'x86_64' ? genX64(mod) : genArm64(mod);
  const syms = [];
  for (let k = 0; k < mod.funcs.length; k++) {
    /* `local`（第九十二片）：`static` 的函数与外部函数的转发桩不进外部符号表 ——
     * 多份 `.o` 一起链的时候（编 tinycc 自己就是十二份）它们每份都有一个同名的。 */
    syms.push({
      name: mod.funcs[k].name,
      off: blob.offsets[k],
      local: mod.funcs[k].local,
      /* `weak`（第一百〇四片）：`__attribute__((weak))` 的函数在符号表里是弱定义。 */
      weak: mod.funcs[k].weak === true,
    });
  }
  /* 两个写出器同一份入参（第三十八片）：Mach-O 那个喂 clang 那条「真的能跑」的腿，
   * ELF 那个喂 tcc 那条「字节相同」的腿 —— tcc 的 `-c` 在**所有**目标上都写 ELF。 */
  const write = fmt === 'elf'
    ? (t, d, ds, rs, a, al) => writeElfObject(t, d, ds, rs, a, al,
      { file: basename(path), prefix: os === 'linux' ? '' : '_' })
    : writeObject;
  writeBinary(out, write(blob.bytes, blob.data,
    [...syms, ...blob.dataSyms], [...blob.relocs, ...blob.dataRelocs], arch, blob.dataAlign));
  return out;
}
/**
 * `c-mir` / `c-run` 的命令行切一刀：`--` 之后的都是**被跑的程序自己的**实参。
 *
 * tcc 那边不需要这一刀 —— `-run` 是个开关，它后面的第一个非选项就是源文件，再往后
 * 全归被跑的程序。我们这儿选项跟在**源文件之后**（`c-run x.c -I dir`），于是
 * `argv` 与 `-I/-D` 会撞在一起，只能用 `--` 分开：`c-run x.c -I dir -- aa bb`。
 */
function cSplitArgs(rest) {
  const cut = rest.indexOf('--');
  if (cut < 0) return { flags: rest, prog: [] };
  return { flags: rest.slice(0, cut), prog: rest.slice(cut + 1) };
}

/** 文件后缀决定默认的类型模式（ADR-0008 第 1 节）；`--mode` 可覆盖，REPL 用它 */
function modeFor(path, argv, fallback = 'mixed') {
  const i = argv.indexOf('--mode');
  if (i >= 0) {
    const m = argv[i + 1];
    if (!['mixed', 'dynamic', 'static'].includes(m)) {
      throw new OmniError(`--mode must be one of mixed, dynamic, static (got '${m}')`);
    }
    return m;
  }
  const ext = path.slice(path.lastIndexOf('.'));
  return MODE_BY_EXT[ext] ?? fallback;
}

/* ---------------------------------------------------------------- --verbose
 *
 * 把内部执行摊开：每一步是什么、多大、花了多久。日志一律走 **stderr** —— stdout 上是
 * 编译产物与被执行程序的输出，那两样在测试里是逐字节比对的，不能被日志污染。
 * 时间是墙上时间（js_now_ms）：大头是 cc 与子进程，CPU 时间量不到它们。
 */
let VERBOSE = false;
let vMark = 0;

function vStep(msg) {
  if (!VERBOSE) return;
  const now = nowMs();
  const d = Math.trunc(now - vMark);
  vMark = now;
  stderr(`omni: ${msg}  [${d}ms]\n`);
}

/**
 * `.js` 入口走 JS 语法前端：链接整棵 import 树，再降级成 OIR（ADR-0011 第 6 步）。
 * 自举就是这一条路 —— 编译器自己的源码是 JS，喂给它自己就得到下一代。
 * 这里没有 check()：OIR 是降级器直接造的，类型早已确定（全是 dynamic）。
 */
function compileJs(path) {
  const diags = new Diagnostics();
  const ast = linkJs(path, (p) => (exists(p) ? readText(p) : null), diags);
  diags.throwIfErrors();
  vStep(`js front end  link ${path}`);
  const mod = lowerJs(ast, diags);
  diags.throwIfErrors();
  vStep(`js lower -> OIR  ${mod.funcs.length} funcs, ${mod.structs.length} structs`);
  return { ast, mod, diags };
}

/**
 * WAT（WebAssembly 文本格式）-> OIR。S 表达式那条路径上的第一个真语法前端，
 * 也是 OIR 的第三个生产者 —— 边界与理由见 frontend-wat/lower.js 的文件头。
 */
function compileWat(path) {
  const diags = new Diagnostics();
  const mod = lowerWat(new SourceFile(path, readText(path)), diags);
  diags.throwIfErrors();
  vStep(`wat front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

function compile(path, argv = []) {
  const r = compileFront(path, argv);
  // 摇树（第一百〇六刀）：所有前端都是"把库整份降下来"，从入口不可达的那些函数一个都不发。
  // `OMNI_PRUNE=0` 关掉 —— 要对比"摇没摇"两份产物时用。
  if (env('OMNI_PRUNE') !== '0' && r !== undefined && r.mod !== undefined) {
    const n = pruneFuncs(r.mod);
    if (n.after !== n.before) vStep(`prune  ${n.before} -> ${n.after} funcs（摇掉 ${n.before - n.after}）`);
  }
  return r;
}

function compileFront(path, argv) {
  if (path.endsWith('.js')) return compileJs(path);
  if (path.endsWith('.wat')) return compileWat(path);
  if (path.endsWith('.sx')) return compileSexpr(path);
  if (path.endsWith('.asy')) return compileAsy(path);
  if (path.endsWith('.jnc')) return compileJnc(path, incDirs(argv));
  return compileProgram(path, undefined, modeFor(path, argv));
}

/**
 * asy 前端的零件：语法表 + 词法 + 内建绑定表。**文件 IO 与表加载都在这里**，
 * 降级器只拿解析好的东西 —— 整份文件的编译（asyText）与 REPL（repl.js 的 AsyLang）
 * 共用这一份，所以"从哪里找模块"这类规则不会有两份实现。
 */
/**
 * 解析树的**紧凑格式**（第七十四刀）。量出来的：asy_builtins 那份树存成 JSON 是 12.0MB，
 * 用我们自己的 JSON 读器读回来 415ms，外加 184ms GC 与 109ms 读文件 —— 一趟 1.9s 里
 * 最大的一块，而且每个例子都得付一遍（树是**库**的，例子只是引它）。
 *
 * 树的形状只有三种（glrParse 出来的就是 S 表达式，见 glr/driver.js:114-130）：
 *   atom:   `{kind:'atom',   value, span:{start,end}}`
 *   string: `{kind:'string', value, raw, span:{start,end}}`
 *   list:   `{kind:'list',   items:[…], span:{start,end}}`
 * 所以不必走通用 JSON —— 前序一遍，长度显式写在前面，读的时候一遍扫过去，不用转义：
 *   `a` start `,` end `,` 值长 `:` 值
 *   `s` start `,` end `,` 值长 `,` 原文长 `:` 值 原文
 *   `l` start `,` end `,` 个数 `;` 子节点…
 * 形状认不出来（以后往节点上加了字段）就回 null，那一份**不进缓存**，行为一字不变。
 */
function astPack(t) {
  const out = [];
  // 存不下来时说清是**哪一种形状**存不下来（`OMNI_ASY_PACKDBG=1`）：这一格一 null，
  // 整个单元的接口索引就不写，而从外面看只是"这个库还是从源码走"，量不出原因。
  const nope = (why, x) => {
    if (env('OMNI_ASY_PACKDBG') === '1') {
      vStep(`asy 打包不了 ${why} kind=${x === null || typeof x !== 'object' ? String(x) : x.kind} keys=${x === null || typeof x !== 'object' ? '' : Object.keys(x).join(',')}`);
    }
    return false;
  };
  const walk = (x) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return nope('不是节点', x);
    const sp = x.span;
    if (sp === null || sp === undefined || typeof sp !== 'object') return nope('没有 span', x);
    for (const k of Object.keys(sp)) {
      if (k !== 'start' && k !== 'end' && k !== 'file') return nope(`span 多一格 ${k}`, x);
    }
    if (!Number.isInteger(sp.start) || !Number.isInteger(sp.end)) return nope('span 不是整数', x);
    const ks = Object.keys(x);
    if (x.kind === 'atom') {
      if (ks.length !== 3 || typeof x.value !== 'string') return nope('atom 形状不对', x);
      out.push(`a${sp.start},${sp.end},${x.value.length}:${x.value}`);
      return true;
    }
    if (x.kind === 'string') {
      if (ks.length !== 4 || typeof x.value !== 'string' || typeof x.raw !== 'string') return nope('string 形状不对', x);
      out.push(`s${sp.start},${sp.end},${x.value.length},${x.raw.length}:${x.value}${x.raw}`);
      return true;
    }
    if (x.kind === 'list') {
      if (ks.length !== 3 || !Array.isArray(x.items)) return nope('list 形状不对', x);
      out.push(`l${sp.start},${sp.end},${x.items.length};`);
      for (const y of x.items) {
        if (!walk(y)) return false;
      }
      return true;
    }
    return nope('认不出的 kind', x);
  };
  return walk(t) ? out.join('') : null;
}

/** 上面那一份读回来。`file` 直接挂在 span 上，所以不用再走一遍"重新挂 file"。 */
function astUnpack(s, file) {
  let i = 0;
  const num = (stop) => {
    let n = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === stop) { i++; return n; }
      if (c < 48 || c > 57) throw new OmniError(`ast 缓存坏了：第 ${i} 个字符不是数字`);
      n = n * 10 + (c - 48);
      i++;
    }
    throw new OmniError('ast 缓存坏了：数没读完就到末尾了');
  };
  const node = () => {
    const t = s.charCodeAt(i);
    i++;
    const start = num(44);          // ','
    const end = num(44);
    if (t === 97) {                 // 'a'
      const len = num(58);          // ':'
      const value = s.slice(i, i + len);
      i += len;
      return { kind: 'atom', value: value, span: { start: start, end: end, file: file } };
    }
    if (t === 115) {                // 's'
      const vlen = num(44);
      const rlen = num(58);
      const value = s.slice(i, i + vlen);
      i += vlen;
      const raw = s.slice(i, i + rlen);
      i += rlen;
      return {
        kind: 'string', value: value, raw: raw, span: { start: start, end: end, file: file },
      };
    }
    if (t !== 108) throw new OmniError(`ast 缓存坏了：第 ${i - 1} 个字符不是 a/s/l`);
    const n = num(59);              // ';'
    const items = [];
    for (let k = 0; k < n; k++) items.push(node());
    return { kind: 'list', items: items, span: { start: start, end: end, file: file } };
  };
  const t = node();
  if (i !== s.length) throw new OmniError('ast 缓存坏了：末尾还有多余的东西');
  return t;
}

function asyFrontEnd() {
  const gpath = join(installDir(), '..', 'frontend-asy', 'asy.grammar');
  if (!exists(gpath)) throw new OmniError(`找不到 asy 语法文件：${gpath}`);
  const tb = loadGrammar(gpath);
  // 内建函数的绑定表是**数据**，跟语法表一个路子。数学不是 asy 的语法
  //（asy 自己那边也是 builtin.cc 里一张表）。
  const btab = join(installDir(), '..', 'frontend-asy', 'builtins.tab');
  if (!exists(btab)) throw new OmniError(`找不到 asy 内建绑定表：${btab}`);
  const builtins = parseAsyBuiltins(readText(btab));
  vStep(`asy builtins   ${builtins.size} 条绑定`);
  // ---- 解析缓存（第七十二刀）----
  // 量出来的：一个只带 prelude 的文件跑 836ms，里面 glrParse 120ms + lexText 59ms +
  // 建树 55ms 是最大的一块（node --cpu-prof），而 prelude 与 base/ 那几十个文件每次跑
  // 都**一模一样**。所以按「语法表 + 源文本」的哈希把树存到盘上，命中就 JSON.parse 回来。
  // 键里带语法表的哈希：语法一改，缓存整片失效。`OMNI_NO_ASTCACHE=1` 关掉它（对照用）。
  // span 里的 `file` 是个带全文与行表的对象，不进 JSON —— 读回来再挂上（astReattach）。
  const gkey = hash16(readText(gpath));
  const astDir = env('OMNI_NO_ASTCACHE') === '1' ? null : join(cacheRoot(), 'asy-ast');
  if (astDir !== null) mkdirAll(astDir);
  const parseText = (p, text, diags) => {
    const file = new SourceFile(p, text);
    // 键不哈希全文（量过：哈希 base 那几十个文件要 56ms）——用「路径 + 改动时间 + 字节数」，
    // 那三样一致就是同一份源码，而 stat 是常数时间。文本不是从盘上来的（REPL、内联）时
    // 退回哈希那条路。
    //
    // 改动时间与语法表的哈希**不在文件名里，在旁边那份 .stamp 里**（第七十四刀）：
    // 编进文件名的话每改一次源码就多出一条，asy_builtins 那一条 12MB，量过 .omni-cache/asy-ast
    // 就是这么攒到 1.3GB 的。现在一份源码在盘上**只占一条**，改了就原地盖掉。
    //
    // 文件名是**源文件的基名 + 一段路径哈希**，只换后缀：`plain.asy` -> `plain__<8 位>.ast`。
    // 全哈希的名字看不出在复用谁，所以基名留着。**一层平铺、不分子目录** —— 这份缓存是
    // 公用的：谁引到 `plain.asy` 都用同一格。
    // 路径那一段是必须的：只取基名时同名不同目录撞在一格上，两个入口轮流跑就互相盖
    // （从前的注释说"撞了就是印记不一致，退化成不命中"，那是**错的** —— 见下面 same 那一行）。
    // 不是从盘上来的文本（REPL、内联）没有名字，按全文哈希起名。
    let base = '';
    let inline = false;
    if (astDir !== null) {
      if (exists(p)) {
        const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        const nm = cut < 0 ? p : p.slice(cut + 1);
        const dot = nm.lastIndexOf('.');
        base = `${dot <= 0 ? nm : nm.slice(0, dot)}__${hash16(p).slice(0, 8)}`;
      } else {
        inline = true;
        base = `_inline-${hash16(text)}`;
      }
    }
    const cpath = base === '' ? '' : join(astDir, `${base}.ast`);
    const spath = base === '' ? '' : join(astDir, `${base}.stamp`);
    // 这一趟的文本已经在手上，把这份内容的身份记进备忘（下面真要哈希时不用再读一遍文件）
    const seed = () => {
      const m = mtimeMs(p);
      const n = fileSize(p);
      const had = srcIdMemo.get(p);
      if (had === undefined || had.mtime !== m || had.len !== n) {
        srcIdMemo.set(p, { mtime: m, len: n, hash: hash16(text) });
      }
    };
    if (cpath !== '' && exists(spath) && exists(cpath)) {
      const fs = readText(spath).split('|');
      // 印记的身份是**内容哈希**（inline 那种没有文件，名字里已经带着哈希）：touch 一下、
      // 重新 checkout 一遍都不该让这份树作废。改动时间与字节数只是省一次读的预检 ——
      // 两样对得上就直接命中，对不上才真去哈希一遍（inpOk）。
      //
      // **先核路径**：这一格的文件名只是基名，同名不同目录会撞到一起，而 `inpOk` stat 的是
      // **印记里记着的**那个路径，不是这一趟要的这个 —— 于是撞了反而"命中"。
      // 量到的样子：`omni run /tmp/tri2.asy` 解析出来的是 `/tmp/asyfp/tri2.asy` 的树，
      // 整趟前端都在编另一个程序，输出是一份画图的 EPS（tri2.asy 里一句画图都没有）。
      const same = inline || inpPath(fs[1]) === p;
      const r = inline ? { ok: fs[1] === '-', cur: '-' } : inpOk(fs[1] === undefined ? '' : fs[1]);
      if (fs[0] === gkey && same && r.ok) {
        const t = astUnpack(readText(cpath), file);
        if (r.cur !== fs[1]) writeText(spath, `${gkey}|${r.cur}`);   // 刷新预检那两格
        vStep(`asy ast cache  ${p}`);
        return t;
      }
    }
    const toks = lexText(tb.grammar.lex, file, diags);
    diags.throwIfErrors();
    vStep(`asy lexer      ${p} -> ${toks.length} tokens`);
    const t = glrParse(tb, toks, diags);
    diags.throwIfErrors();
    if (cpath !== '') {
      const packed = astPack(t);
      // 形状认不出来就不缓存（见 astPack 的注释）。先写树再写印记：印记是"这一条成了"的凭据。
      if (packed !== null) {
        if (!inline) seed();
        writeText(cpath, packed);
        writeText(spath, `${gkey}|${inline ? '-' : inpField(p)}`);
      }
    }
    return t;
  };
  // 模块的找法是量出来的 —— asy 按**当前目录**找，不是按引它的那个文件所在的目录
  // （量过：`asy -noV sub/user.asy` 里的 `import mm;` 找不到 sub/mm.asy）。
  // 当前目录之后按 `ASYMPTOTE_DIR`（asy 自己的那个环境变量，冒号分隔）找，最后是
  // 我们自己的 stage0/lib/asy。**base/*.asy 不抄一份**：plain/graph 那一堆是 asy
  // 源码，要引的就是真的那些；我们只补 C++ 那一侧的内建面（lib/asy 里那一份）。
  const libDir = join(installDir(), '..', '..', 'lib', 'asy');
  const searchDirs = [];
  const envDir = env('ASYMPTOTE_DIR');
  if (envDir !== undefined && envDir !== '') {
    for (const d of envDir.split(':')) if (d !== '') searchDirs.push(d);
  }
  searchDirs.push(libDir);
  // 这一趟真的加载了哪些模块文件（按加载顺序）。产物缓存的依赖清单靠它。
  const seen = [];
  const paths = new Map();
  /**
   * 模块名 -> 它解析到的**真文件**，只 stat、不读不解析。
   *
   * 单独摘出来是必须的：产物名里带着这个路径的哈希（见 unitName），而问"这个库的产物
   * 还能用吗"（skipBody / 接口索引）发生在**加载之前** —— 那时候 `paths` 里还没有这一格，
   * 名字就会算成 `asy_builtins__<key 的哈希>`，与盘上那份 `asy_builtins__<路径的哈希>`
   * 对不上，于是每一格都报"没有 .aif"。量到的样子：13 份里只有 2 份走上索引。
   */
  const resolve = (name) => {
    const had = paths.get(name);
    if (had !== undefined) return had;
    // `collections.map` 这种带点的模块路径，文件是 `collections/map.asy`（量过 asy 也这样找）。
    // 先按原样找一遍：真有个叫 `a.b.asy` 的文件时那份赢，与不带点的写法同一条规矩。
    const cands = name.indexOf('.') < 0 ? [name] : [name, name.split('.').join('/')];
    for (const nm of cands) {
      const q = join(cwd(), `${nm}.asy`);
      if (exists(q)) { paths.set(name, q); return q; }
    }
    for (const d of searchDirs) {
      for (const nm of cands) {
        const q = join(d, `${nm}.asy`);
        if (exists(q)) { paths.set(name, q); return q; }
      }
    }
    return '';
  };
  const loader = (diags) => (name) => {
    const p = resolve(name);
    if (p === '' || !exists(p)) return null;
    vStep(`asy module    ${name} -> ${p}`);
    seen.push(p);
    return parseText(p, readText(p), diags);
  };
  return {
    parseText: parseText, loader: loader, builtins: builtins, libDir: libDir, seen: seen,
    paths: paths, resolve: resolve,
  };
}

/**
 * 上一趟 asyText 读过的文件（主文件在第一格）。产物缓存的依赖清单用它 ——
 * 模块是**加载期**才知道的（`import` 在源码里），所以只能事后取。
 */
let lastAsyDeps = [];

/**
 * 编译器自己那一份的印记：stage0/src 底下每个文件的「路径 + 改动时间 + 字节数」。
 * 产物缓存的键里带它 —— 改了降级器或后端，缓存整片失效。
 * 目录与文件**问文件系统**（isDir），不按名字猜。原先按"名字里有没有点"分
 * —— 在 stage0/src 底下确实成立（目录都没有后缀，文件都有），但装好的那份里
 * 编译器自己就叫 `dist/src/host/omni`、没有后缀，于是它被当成目录走进去，
 * readdir 一个普通文件：`ENOTDIR: not a directory, scandir '…/dist/src/host/omni'`。
 * 一条"在源码树里恰好成立"的命名约定不能当成布局的判据。
 *
 * **这里原先只走了 `installDir()`**（那是 `stage0/src/host`），于是改了
 * frontend-asy/ 底下任何一处降级器，印记都不动、产物缓存整片误命中 —— 量到过：
 * 同一份 `path r=(0,0); r=r--(10,0); r=r..(20,10);` 在改完前端之后仍然出旧图
 * （直线而不是曲线），`rm -rf .omni-cache/asy-js` 之后才对。这与第七十九刀那次
 * "产物名只取基名"是同一类错：一个会跑错程序的缓存。所以往上走一级，走全 stage0/src；
 * 键里存**整条路径**而不是基名（两个目录里同名的文件不能互相冒充）。
 * lib/ 底下的 .asy 不在这里：它们逐个进了产物缓存的依赖清单（见 jsCachePut）。
 */
let srcStampMemo = '';
function srcStamp() {
  if (srcStampMemo !== '') return srcStampMemo;
  const parts = [];
  const walk = (d) => {
    for (const f of readDir(d).sort()) {
      const p = join(d, f);
      if (isDir(p)) walk(p);
      else parts.push(`${p}:${mtimeMs(p)}:${fileSize(p)}`);
    }
  };
  walk(join(installDir(), '..'));
  srcStampMemo = hash16(parts.join('|'));
  return srcStampMemo;
}

/**
 * 编译产物（JS）的缓存（第七十四刀）。量出来的：`tests/asy/draw/tri.asy` 引真 base 时
 * 一趟 1.22s，里面 AST 缓存读回来约 0.5s、把 base 那三十个模块**重新降级**约 0.7s、
 * 生成 1.16MB 的 JS 约 0.3s —— 而这三样在同一份源码上每次都一模一样。
 *
 * 缓存的是最后那一份 JS，键是「编译器印记 + 语法表 + 这一趟读过的每个文件的
 * 改动时间与字节数」。**一个主文件只占一条**（文件名里只有路径的哈希，印记在内容里），
 * 所以改一次源码不会多出一条 —— asy-ast 那个目录就是因为把改动时间编进文件名，
 * 攒到了 625MB。
 *
 * 这一条只在 `run` 那一路上用：它的输入输出都是"这一份源码跑出来的 JS"，
 * 与后端/解释器那几条腿无关。`OMNI_NO_JSCACHE=1` 关掉（对照用）。
 */
/**
 * 一切中间文件与缓存的根：**仓库里的 `.omni-cache`**，不再用系统临时目录（第一百〇五刀）。
 *
 * 为什么不用 `/tmp` / `/var/folders`：
 *   - 系统会清它。EPS 参考那 192 份就是这么丢的（一趟 5 分钟的真 asy 重跑），
 *     而 glr 表、运行时 `.o`、链好的可执行文件都是"重算很贵、内容只由输入决定"的东西。
 *   - 看不见。`omni-l2pb0k/a.out.c` 这种名字在 `/var/folders/x6/dw0k…` 底下，
 *     出了问题连"上一趟到底编了什么"都翻不出来。
 *   - 一台机器上两个 checkout 的印记里带的是路径与 mtime，撞不撞全靠运气。
 * `OMNI_CACHE_DIR` 可以把整棵搬走（CI 上想放到 workspace 之外时用）。
 */
function cacheRoot() {
  const e = env('OMNI_CACHE_DIR');
  if (e !== undefined && e !== '') return e;
  return join(installDir(), '..', '..', '..', '.omni-cache');
}

/**
 * 一次性的工作目录（生成的 `.c`、链出来的 `a.out`、写缓存前的暂存…）。
 *
 * **名字是确定的**，不是 mkdtemp 那种随机名：从前靠系统清 `/tmp` 才不攒垃圾，
 * 搬进仓库之后随机名就等于每跑一趟多一个目录。同一个 kind + key 的下一趟原地盖掉。
 * 代价写在明处：**并发跑同一个输入会撞**（同一份源码同时编两遍本来也会争缓存那一格）。
 */
function workDirFor(kind, key) {
  const dir = join(cacheRoot(), 'work', key === '' ? kind : `${kind}-${key}`);
  mkdirAll(dir);
  return dir;
}

function jsCacheDir() {
  return join(cacheRoot(), 'asy-js');
}
function jsCacheStamp() {
  // 印记里必须带**找模块的那几样**：同一个主文件在 `ASYMPTOTE_DIR` 指着真 base 时
  // 与不指时编出来的是两份 JS，而依赖清单里的文件两边都还在、都没动 —— 只看清单会误命中。
  // 当前目录同理（asy 先按 cwd 找模块，量过）。
  const ad = env('ASYMPTOTE_DIR');
  const ab = env('OMNI_ASY_BUILTINS');
  return `v1|${srcStamp()}|${ad === undefined ? '' : ad}|${ab === undefined ? '' : ab}|${cwd()}`;
}
function jsCacheGet(path) {
  if (env('OMNI_NO_JSCACHE') === '1') return null;
  const key = `j-${hash16(path)}`;
  const dep = join(jsCacheDir(), `${key}.dep`);
  const jsp = join(jsCacheDir(), `${key}.js`);
  if (!exists(dep) || !exists(jsp)) return null;
  const lines = readText(dep).split('\n');
  if (lines[0] !== jsCacheStamp()) return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const f = lines[i].split('\t');
    if (!exists(f[0]) || `${mtimeMs(f[0])}` !== f[1] || `${fileSize(f[0])}` !== f[2]) return null;
  }
  return readText(jsp);
}
function jsCachePut(path, js, deps) {
  if (env('OMNI_NO_JSCACHE') === '1' || deps.length === 0) return;
  const key = `j-${hash16(path)}`;
  const lines = [jsCacheStamp()];
  for (const p of deps) {
    if (exists(p)) lines.push(`${p}\t${mtimeMs(p)}\t${fileSize(p)}`);
  }
  mkdirAll(jsCacheDir());
  // 先写产物再写清单：清单是"这一条成了"的凭据，反过来会留下半条。
  writeText(join(jsCacheDir(), `${key}.js`), js);
  writeText(join(jsCacheDir(), `${key}.dep`), lines.join('\n'));
}

/**
 * 原生那一路的产物缓存（第一百〇五刀）：**链好的可执行文件**按同一把印记躺在
 * `.omni-cache/asy-exe` 里，源码与它引的库都没动就直接 exec。
 *
 * 为什么必须有这一条：node 上那一路（模块产物 / 整份 JS）早就有缓存了，而自举出来的
 * 原生二进制一趟都没有 —— 量出来 `run tests/asy/cases/03-quotes.asy` **每趟 12s**
 * （AST 读回来 3.4s + 前端 5.0s + 发 C 2.5s + clang 0.5s），而这 12s 的输入
 * 一个字节都没变。命中之后剩下的只有 exec。
 *
 * 印记比 JS 那份多一格 **cc**：同一份源码用 clang 与用 tcc 链出来的是两个可执行文件。
 * 依赖清单与 jsCache 同一套（`路径\t改动时间\t字节数`，事后从 lastAsyDeps 取）。
 * `OMNI_NO_EXECACHE=1` 关掉（对照用）。
 */
function exeCacheDir() {
  return join(cacheRoot(), 'asy-exe');
}
function exeCacheStamp(cc) {
  // 编译器与**它的 flags** 都在印记里：`OMNI_OPT=2` 与默认 -O0 是两个可执行文件
  return `e1|${jsCacheStamp()}|cc:${cc}|${ccFlags(cc).join(' ')}`;
}
function exeCacheGet(path, cc) {
  if (env('OMNI_NO_EXECACHE') === '1') return null;
  const key = `e-${hash16(path)}`;
  const dep = join(exeCacheDir(), `${key}.dep`);
  const exe = join(exeCacheDir(), `${key}.bin`);
  if (!exists(dep) || !exists(exe)) return null;
  const lines = readText(dep).split('\n');
  if (lines[0] !== exeCacheStamp(cc)) return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const f = lines[i].split('\t');
    if (!exists(f[0]) || `${mtimeMs(f[0])}` !== f[1] || `${fileSize(f[0])}` !== f[2]) return null;
  }
  return exe;
}
function exeCachePut(path, cc, deps) {
  if (env('OMNI_NO_EXECACHE') === '1' || deps.length === 0) return;
  const key = `e-${hash16(path)}`;
  const lines = [exeCacheStamp(cc)];
  for (const p of deps) {
    if (exists(p)) lines.push(`${p}\t${mtimeMs(p)}\t${fileSize(p)}`);
  }
  // 清单最后写：可执行文件是 buildNative 直接链到那个名字上的，链一半的话没有清单，
  // 下一趟老老实实重来。
  writeText(join(exeCacheDir(), `${key}.dep`), lines.join('\n'));
}
/** 这一趟该把可执行文件链到哪儿（缓存开着就直接链进缓存那一格，省一次拷贝） */
function exeCachePath(path) {
  if (env('OMNI_NO_EXECACHE') === '1') return null;
  mkdirAll(exeCacheDir());
  return join(exeCacheDir(), `e-${hash16(path)}.bin`);
}

/**
 * asymptote -> 核心方言 -> OIR（ADR-0014 第 2 道门槛）。
 * 语法那一半是数据（`frontend-asy/asy.grammar`，从 camp.y 照原样转写）；这里只做
 * 类型定向的那一半，出来的仍然是核心方言文本 —— 于是六条腿一条都不知道 asy 存在。
 */
function asyText(path, out, skipBody, ifaceFn) {
  const fe = asyFrontEnd();
  const diags = new Diagnostics();
  const tree = fe.parseText(path, readText(path), diags);
  const text = lowerAsy(tree, diags, {
    path, load: fe.loader(diags), builtins: fe.builtins,
    // asy 的 C++ 内建面（path/pen/frame/… 那一族）做成一个模块，每个单元隐式 import
    // 一次（见 lower.js 的 builtinsIn）。**默认开着** —— 真 asy 那边这一面是运行时自带的，
    // `size(100);` 不用 import 任何东西就能跑，所以要它对上就不能靠环境变量。
    // 与 ASYMPTOTE_DIR 一起用就是"引真的 base/*.asy"。OMNI_ASY_BUILTINS=0 关掉（
    // 调这一面自己的时候用：它自己是 asy 源码，不能隐式引进自己）。
    prelude: env('OMNI_ASY_BUILTINS') === '0' ? '' : 'asy_builtins',
    // 模块名 -> 它解析到的真文件。**只 stat 不加载** —— 产物名里带这个路径的哈希，
    // 而"这个库的产物还能用吗"要在加载之前就问得出来（见 asyFrontEnd 的 resolve）。
    pathOf: (n) => fe.resolve(n),
    // 产物还在、源文件没动的库：正文一步都不降（第七十六刀，见 lower.js 的 skipBody）
    skipBody: skipBody === undefined ? null : skipBody,
    // 库的接口索引要把默认实参那些表达式打包进去（第七十八刀，见 iface.js）
    astPack,
    // 产物齐了的库：连源码都不读，声明从 `.aif` 认（第七十八刀）
    iface: ifaceFn === undefined ? null : ifaceFn,
  }, out);
  diags.throwIfErrors();
  // 这一趟读过的文件（主文件 + 真的加载了的模块）。产物缓存的依赖清单就是它，
  // 所以必须是**加载完之后**取 —— fe.seen 是 loader 一路 push 进去的。
  lastAsyDeps = [path];
  for (const p of fe.seen) if (!lastAsyDeps.includes(p)) lastAsyDeps.push(p);
  vStep(`asy front end  ${path} -> 核心方言 ${text.length} bytes`);
  return text;
}

function compileAsy(path) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${path}.sx`, asyText(path)), diags);
  diags.throwIfErrors();
  return { ast: null, mod, diags };
}

/**
 * 一个单元 -> 它那份产物的名字（盘上就叫这个，只换后缀）。
 *
 * 名字取**源文件的基名 + 一段身份哈希**。基名是给人看的；哈希那一段是必须的 ——
 * 只取基名时两个不同目录下同名的源文件共用一份产物与一份清单，而清单里记的是**它**
 * 那个源文件的路径，那个文件没动就算"命中"。量到的样子：`omni run /tmp/tri2.asy`
 * 一步前端都不走，跑出来的是 `/tmp/asyfp/tri2.asy` 那一份的输出（一份画图的 EPS，
 * 而 /tmp/tri2.asy 里一句画图都没有）。这不是慢，是**跑错程序**。
 * 与 rustc 的 `-C metadata`、Cargo 的 fingerprint 同一个做法：身份进名字。
 *
 * 身份是「解析到的真文件 + 模块身份」两样一起哈：模块身份是 `collections.iter(T=int)`
 * 那样的东西（同一个文件的两次模板实例化是两份产物），真文件把同名不同目录分开。
 */
function unitName(info) {
  const k = info === undefined || info === null ? null : info;
  const src = k === null ? '' : (k.file !== '' ? k.file : k.key);
  if (src === '') return 'omni_entry';
  const cut = Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\'));
  const nm = cut < 0 ? src : src.slice(cut + 1);
  const dot = nm.lastIndexOf('.');
  const base = dot <= 0 ? nm : nm.slice(0, dot);
  return `${base}__${hash16(`${src}|${k === null ? '' : k.key}`).slice(0, 8)}`;
}

/**
 * 产物名 -> **JS 标识符**里能用的那一段（`omni_init_<这一段>`）。
 *
 * 产物名是照源文件名起的，而文件名里的字符不都能当标识符 —— 量出来的形状是
 * examples/xxsq01x-1.asy：入口单元叫 `xxsq01x-1`（入口那份不带 hash 后缀），
 * 于是 `main-xxsq01x-1.js` 里那句 `import { omni_init_xxsq01x-1 } …` 是
 * `SyntaxError: Unexpected token '-'`，例子在**加载模块**这一步就炸了（连诊断都发不出）。
 *
 * 洗法：不合法的字符换成 `_`；**洗过的**再缀一段原名的 hash —— 不缀就把
 * `a-b` 与 `a_b` 洗成同一个名字，那是"另一个例子的初始化"那一类的错。
 * 文件名照旧用没洗过的那个（import 路径是字符串，什么字符都行）。
 */
function jsUnitSym(name) {
  const clean = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (clean === name) return name;
  return `${clean}__n${hash16(name).slice(0, 8)}`;
}

/** 一个源文件路径 -> 产物名（清单那一路只有路径，没有单元信息）。 */
function fileUnitName(p) {  return unitName({ key: p, file: p, tpl: false });
}

/**
 * `_mainname()` 会降成什么（源文件的基名，去掉 `.asy` —— 与 lower.js 的 rootModName 同一条规矩）。
 * 单元的印记里那格 `main:` 用它，见 asyModsBuild 里的 stampOf。
 */
function asyMainWord(p) {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const nm = cut < 0 ? p : p.slice(cut + 1);
  return nm.endsWith('.asy') ? nm.slice(0, nm.length - 4) : nm;
}

/**
 * asy -> **每个源文件一份**核心方言模块（第七十五刀）。
 * 每一份里用到的别人家的名字是 `(sig "出处" (…))`，所以每一份都能单独编 ——
 * 一个库改了只重编它自己那一份，别的照旧从盘上拿。
 */
function asyUnitTexts(path, skip) {
  const out = {};
  asyText(path, out, skip === undefined || skip === null ? null : skip.fn,
    skip === undefined || skip === null ? null : skip.iface);
  if (out.sections === undefined) throw new OmniError('asy: 这一趟没有分段信息');
  // 复用那几份带进来的"只剩产物"的模块（见 asyModsSkip）
  out.sections.extra = skip === undefined || skip === null ? [] : [...skip.extras.values()];
  // 哪些单元这一趟**一格产物都不留**（`OMNI_ASY_UNITS=1`，见 lower.js 的 unitWhy）
  if (env('OMNI_ASY_UNITS') === '1') {
    for (const w of out.sections.unitWhy === undefined ? [] : out.sections.unitWhy) {
      vStep(`asy 单元 ${w.why}  ${w.key === '' ? '<无源文件>' : w.key}`);
    }
  }
  const r = asyUnitModules(out.sections, unitName, out.sections.tail);
  vStep(`asy units      ${r.units.length} 份新拼、${r.reused.length} 份原样留着`);
  return r;
}

/** 印记里的两格说的是同一份输入吗（**只比路径与内容哈希**，改动时间与字节数不算） */
function inpSame(x, y) {
  if (x === y) return true;
  const i = x.lastIndexOf(':h');
  const j = y.lastIndexOf(':h');
  if (i < 0 || j < 0) return false;
  return x.slice(0, i) === y.slice(0, j) && x.slice(i + 2) === y.slice(j + 2);
}

/** 两份印记说的是同一批输入吗（一格一格核，见 inpSame） */
function stampSame(a, b) {
  const xs = a.split('|');
  const ys = b.split('|');
  if (xs.length !== ys.length) return false;
  for (let i = 0; i < xs.length; i++) if (!inpSame(xs[i], ys[i])) return false;
  return true;
}

/** 产物的默认去处。**一个共用目录** —— 复用的就是这里面按文件名躺着的那些 `.js`。 */
function asyModsDir() {
  return join(cacheRoot(), 'asy-mods');
}

/**
 * 一个源文件的**身份是它的内容哈希**，不是改动时间（第七十七刀）。
 *
 * 从前印记记的是 `路径:改动时间:字节数`，于是 `touch settings.asy` 就重编 —— 内容一个
 * 字节没变。换台机器、重新 checkout 一遍同样全体失效。tsc 那份 `.tsbuildinfo` 里每个
 * 文件记的是内容的 version（哈希），道理一样：**同一份输入必须映到同一格产物**。
 *
 * 代价是每趟要哈希那十几个源文件（量过 base 那批 56ms）。所以改动时间与字节数留着当
 * **快速预检**：两样都对得上就直接信旁边记着的那格哈希，一个字节都不用读；对不上才真去
 * 读文件重算，而重算出来哈希一样的话产物照旧有效（只把预检那两格刷新）。
 * 常态下还是只 stat，语义却是内容哈希。
 */
const srcIdMemo = new Map();

/** `{mtime, len, hash}`；文件不在就回 null。同一趟里一个文件只哈希一次。 */
function srcId(p) {
  if (p === '' || !exists(p)) return null;
  const m = mtimeMs(p);
  const n = fileSize(p);
  const had = srcIdMemo.get(p);
  if (had !== undefined && had.mtime === m && had.len === n) return had;
  const info = { mtime: m, len: n, hash: hash16(readText(p)) };
  srcIdMemo.set(p, info);
  return info;
}

/** 记进印记的那一格：`路径:改动时间:字节数:h内容哈希`（没有源文件记 `-`，文件没了记 `路径:-`） */
function inpField(p) {
  if (p === '') return '-';
  const id = srcId(p);
  return id === null ? `${p}:-` : `${p}:${id.mtime}:${id.len}:h${id.hash}`;
}

/** 印记里那一格记的是**哪个文件**（`路径:改动时间:字节数:h内容哈希` 的头一段） */
function inpPath(field) {
  if (field === undefined || field === '' || field === '-') return '';
  if (field.endsWith(':-')) return field.slice(0, -2);
  const c3 = field.lastIndexOf(':');
  const c2 = field.lastIndexOf(':', c3 - 1);
  const c1 = field.lastIndexOf(':', c2 - 1);
  return c1 < 0 ? '' : field.slice(0, c1);
}

/** 印记里的一格现在还成立吗。回 `{ok, cur}` —— `cur` 与原来那格不同就该把印记刷新。 */
function inpOk(field) {
  if (field === '-') return { ok: true, cur: '-' };
  if (field.endsWith(':-')) {
    const p0 = field.slice(0, -2);
    return { ok: !exists(p0), cur: inpField(p0) };
  }
  const c3 = field.lastIndexOf(':');
  const c2 = field.lastIndexOf(':', c3 - 1);
  const c1 = field.lastIndexOf(':', c2 - 1);
  if (c1 < 0 || c2 < 0 || c3 < 0 || field[c3 + 1] !== 'h') return { ok: false, cur: '' };
  const p = field.slice(0, c1);
  if (!exists(p)) return { ok: false, cur: inpField(p) };
  // 预检：改动时间与字节数都没动就不读文件。顺手把那格哈希记进 srcIdMemo ——
  // 同一趟里稍后写新印记时（stampOf 里那些 inpField）就不必再读一遍、再哈一遍这个文件了。
  // 量过：不记这一格的话，换个入口跑一趟要在 hash16 上白花 38ms（库源文件都被重哈一遍）。
  const m = mtimeMs(p);
  const n = fileSize(p);
  if (`${m}` === field.slice(c1 + 1, c2) && `${n}` === field.slice(c2 + 1, c3)) {
    if (srcIdMemo.get(p) === undefined) {
      srcIdMemo.set(p, { mtime: m, len: n, hash: field.slice(c3 + 2) });
    }
    return { ok: true, cur: field };
  }
  const cur = inpField(p);
  return { ok: cur.slice(cur.lastIndexOf(':') + 1) === field.slice(c3 + 1), cur: cur };
}

/** `.wk` 里一条与一条之间的分界线（项本身缩进两格起，所以顶头这一行不会撞上）。 */
const ASY_WK_SEP = ';;--';

/**
 * 「这一份产物还是最新的吗」——是的话前端**连它的正文都不降**（第七十六刀）。
 *
 * 判据与写产物那一刻用的是**同一格印记**：`.stamp` 里记着「编译器 + 它自己那个源文件 +
 * 它引到的那几个源文件」的 `路径:改动时间:字节数`，这里把每一格反过来 stat 一遍。
 * 全对上、并且 `.js`/`.sec`/`.wk` 三样都在，就把签名清单与它引到的 weak 项读回来给前端。
 *
 * 量出来的账：13 个库的 asyBodyPass 是 368ms（整个前端 645ms 的一半多），而它降出来的
 * 东西逐字节等于盘上那份 —— 这一刀省的就是它。声明遍那 221ms 省不掉：入口要那些表。
 */
function asyModsSkip(dir, cs, mainTag) {
  const extras = new Map();          // 产物名 -> {name, key, sigs, weak}
  // 一份产物旁边那格 `.dep`：`key|源文件`、`need|要跟着进来的产物名`
  const readDep = (nm) => {
    const p = join(dir, `${nm}.dep`);
    if (!exists(p)) return null;
    const need = [];
    let key = '';
    for (const ln of readText(p).split('\n')) {
      if (ln.startsWith('key|')) key = ln.slice(4);
      else if (ln.startsWith('need|')) need.push(ln.slice(5));
    }
    return { key, need };
  };
  // 一份产物的四格（`.stamp` 对上、`.js`/`.sec`/`.wk`/`.dep` 都在）都齐了才回它的内容
  const load = (nm) => {
    const st = join(dir, `${nm}.stamp`);
    const secP = join(dir, `${nm}.sec`);
    const wkP = join(dir, `${nm}.wk`);
    if (!exists(st) || !exists(join(dir, `${nm}.js`)) || !exists(secP) || !exists(wkP)) return null;
    const fs = readText(st).split('|');
    if (fs[0] !== cs) return null;
    for (let i = 1; i < fs.length; i++) {
      const f = fs[i];
      if (f === '-') continue;                 // 没有源文件的那种依赖（omni_weak）
      if (f.startsWith('t')) return null;      // 按文本哈希记的那种（omni_weak 自己）：不复用
      // 「这一份的正文里有主文件的基名」那一格（见 asyModsBuild 的 stampOf）：换了入口就不复用
      if (f.startsWith('main:')) { if (f !== mainTag) return null; continue; }
      if (!inpOk(f).ok) return null;
    }
    const dep = readDep(nm);
    if (dep === null) return null;
    const sigs = [];
    for (const ln of readText(secP).split('\n')) if (ln.trim() !== '') sigs.push(ln);
    const weak = [];
    for (const t of readText(wkP).split(`\n${ASY_WK_SEP}\n`)) if (t.trim() !== '') weak.push(t);
    return { name: nm, key: dep.key, need: dep.need, sigs, weak };
  };
  const skipFn = (info) => {
    const nm = unitName(info);
    const me = load(nm);
    if (me === null) return null;
    // 它要带的那几份也得全齐（一份缺了就整个不跳过 —— 宁可老老实实降一遍）
    const pull = [];
    const seen = new Set([nm]);
    const wave = [...me.need];
    while (wave.length > 0) {
      const n2 = wave.pop();
      if (seen.has(n2)) continue;
      seen.add(n2);
      const had = extras.get(n2);
      const x = had === undefined ? load(n2) : had;
      if (x === null) return null;
      if (had === undefined) pull.push(x);
      for (const d of x.need) if (!seen.has(d)) wave.push(d);
    }
    for (const x of pull) extras.set(x.name, x);
    return { sigs: me.sigs, weak: me.weak };
  };
  return {
    extras,
    fn: skipFn,
    // **接口索引**（第七十八刀）：产物这一套都齐了、旁边又躺着 `.aif` 的话，前端连这个库的
    // 源码都不读。先过一遍上面那关（印记 + `need` 闭包），过了才认这份索引 —— 判据是同一格。
    //
    // span 上那个 `file` 给一格轻壳：不读源码就没有全文与行表，而这条路上库的声明本来
    // 不该再报诊断（真报了也还有路径与偏移可看）。
    iface: (info) => {
      // **默认关着**（`OMNI_ASY_IFACE=1` 打开）。这一格是"快但还不对"，判据是出图数：
      // 220 例里有 oracle 参考的 192 份，关索引出图 **55** 份、开索引 **44** 份。
      // 开着还剩两族只在这条路上才有的错（量过、都在 ADR-0014 第七十九刀那一节）：
      //   34 份 `'X' 在这里还看不见`、19 份 `字段 'X' 的默认值：不能把 null 当成 T`。
      // 所以正确性优先：默认关，等接口按条存（ADR-0015 第 5 步）把这两族清了再打开。
      //
      // 这一路已经修好的三处（都留着，开起来是真省）：
      //   - `asyIfaceLoad` 从前写死 `obj.v !== 1` 而 dump 写 `v: 2`，整条路是死的 ——
      //     从前"开索引一点不省"那次测量测的是同一条路。
      //   - 产物名里带源文件路径的哈希，而这一格在**加载之前**算名字，`pathOf` 那时回不出
      //     路径，13 份里只有 2 份找得到 `.aif`（已改成只 stat 的 resolve）。
      //   - `access m;` 只建别名不并名字，asyModMerge 一笔不记，读回来 `L.mods` 是空的 ——
      //     默认值里的 `settings.x` 于是报"带点的名字"（101 份→0 份）。
      //   - 读回来的单元不再重新 dump：那个来回是有损的，几代之后名字就找不着了（72→34）。
      //
      // 打开之后改一个字符的墙上时间（安静环境，三趟三趟）：
      //   asy-units（只编译） 关 537/517/508ms   开 406/333/273ms
      //   run（编译 + 跑）    关 885/738/623ms   开 551/502/477ms
      if (env('OMNI_ASY_IFACE') !== '1') return null;
      const nm = unitName(info);
      const p = join(dir, `${nm}.aif`);
      if (!exists(p)) { vStep(`asy 接口索引不命中 ${nm} 没有 .aif`); return null; }
      if (skipFn(info) === null) { vStep(`asy 接口索引不命中 ${nm} 产物那一套没齐`); return null; }
      const obj = JSON.parse(readText(p));
      if (obj === null || obj === undefined) return null;
      // 版本对不上就当没有这一格（盘上那份是旧格式）。这一格与 iface.js 的 asyIfaceLoad
      // **必须同一个数** —— 从前这里认 2、那边写死认 1，接口索引于是整片是死的。
      if (obj.v !== 3) return null;
      vStep(`asy 接口索引   ${nm}`);
      return {
        obj,
        file: {
          path: info.file === '' ? nm : info.file,
          lineCol: () => ({ line: 1, col: 1 }),
          lineText: () => '',
          text: '',
        },
        unpack: astUnpack,
      };
    },
  };
}

/**
 * 每一份产物的**指纹**（ADR-0015 决策 1）。只由**源侧**的东西算出来：
 * 编译器印记、环境、它自己那个源文件的内容哈希、它 import 的那几份的指纹。
 *
 * 与"这一趟的入口是谁""这一趟哪几份被跳过"都无关 —— 这正是旧那套 `.stamp` 做不到的：
 * 那一格记的是链接算出来的 deps，跟着跳过与否变，于是"换个入口跑"就能让别人作废。
 *
 * `import` 图允许有环（asy 里互相 import 是常事），所以按**不动点**迭代而不是递归：
 * 初值只含自己，每一轮把依赖的指纹掺进来，不再变就停。环里的成员因此共用同一层信息，
 * 等价于按 SCC 整块算一个指纹。
 */
function asyFps(all, cs, mainPath) {
  const ev = asyModsEnv(mainPath);
  const nameOfKey = new Map();
  for (const u of all) if (u.key !== '') nameOfKey.set(u.key, u.name);
  const self = new Map();
  const deps = new Map();
  for (const u of all) {
    const id = u.key === '' ? null : srcId(u.key);
    self.set(u.name, hash16(`${cs}|${ev}|${u.name}|${id === null ? '' : id.hash}`));
    const ds = new Set();
    for (const k of u.imps === undefined || u.imps === null ? [] : u.imps) {
      const n = nameOfKey.get(k);
      if (n !== undefined && n !== u.name) ds.add(n);
    }
    deps.set(u.name, [...ds].sort());
  }
  let fp = new Map(self);
  for (let round = 0; round < 64; round++) {
    const next = new Map();
    let same = true;
    for (const [n, s] of self) {
      const parts = [s];
      for (const d of deps.get(n)) parts.push(`${d}:${fp.get(d) === undefined ? '' : fp.get(d)}`);
      const v = hash16(parts.join('|'));
      next.set(n, v);
      if (v !== fp.get(n)) same = false;
    }
    fp = next;
    if (same) break;
  }
  return fp;
}

/**
 * 把一份 asy 程序落成一目录 ESM 模块（每个源文件一份），回那份入口 `.js` 的路径。
 *
 * 增量就在每一份旁边那格印记上：一份产物的**输入**只有两样 —— 它自己那份 `.sx`
 * （里面已经含了它看见的全部签名）与编译器自己。两样都没动就不重编，盘上那份留着。
 * 量出来的：换个入口跑，9 份里复用 7 份（只有 omni_weak 与入口自己要重编）。
 */
function asyModsBuild(path, dir) {
  mkdirAll(dir);
  // 主文件的名字**只进用得着它的那几份**印记（这一刀）。
  //
  // 从前它进的是 `cs` —— 每一份产物的印记都带着它，于是**库那几份跨不了入口**：
  // 量出来的样子是 01-arith 编完之后跑 02-strings，日志写着「新编 4 份、复用 0 份」，
  // 28 行代码 0.9s。为什么当初要带上它：TeX 那条路上 `_mainname()` 降成了字面量
  // （dvips 把 dvi 的文件名写进产物正文，`TeXDict begin … (equilateral_.dvi)` 那一行），
  // 不带的话 fano 会复用 equilateral 那份产物，名字就是上一个例子的。
  //
  // 现在按「这一份的正文里到底有没有那个名字」分：有就在它自己那格印记尾巴上补一格
  // `main:<基名>`，别的入口来了对不上就重编；没有的（asy_builtins、settings、绝大多数库）
  // 一格都不带，谁都能复用。判据故意**偏保守** —— 正文里恰好出现同名字符串的库会白重编
  // 一次，但绝不会拿着别的例子的名字跑。
  const cs = srcStamp();
  const mainWord = asyMainWord(path);
  const mainTag = `main:${mainWord}`;
  const r = asyUnitTexts(path, asyModsSkip(dir, cs, mainTag));
  // ADR-0015 第一步与第二步：指纹与归属先只打印不接线，好验两样都与"入口是谁"无关。
  if (env('OMNI_ASY_FP') === '1') {
    const fps = asyFps([...r.units, ...r.reused], cs);
    for (const n of [...fps.keys()].sort()) vStep(`asy 指纹  ${fps.get(n)}  ${n}`);
    for (const [nm, own] of r.owners === undefined ? [] : r.owners) {
      vStep(`asy 归属  ${own === '' ? '<运行时>' : own}  ${nm}`);
    }
  }
  writeText(join(dir, 'omni_rt.js'), emitJsRuntimeModule());
  // 一份产物的印记（这一格决定重不重编）：`编译器 | 它自己那个源文件 | 它引到的那几个源文件`，
  // 每一格是 `路径:改动时间:字节数:h内容哈希`（见 inpField）。**身份是内容哈希** ——
  // touch 一下、重新 checkout 一遍都不该重编；改动时间与字节数只是省一次读的预检。
  // 没有源文件的那份（omni_weak：内容由整个程序决定）只能哈希它自己的文本 —— 它小。
  const fstamp = inpField;
  const keyOfName = new Map();
  for (const u of r.units) keyOfName.set(u.name, u.key);
  for (const u of r.reused) keyOfName.set(u.name, u.key);
  const stampOf = (u) => {
    if (u.key === '') return `${cs}|t${hash16(u.text)}|${u.text.length}`;
    const ds = [];
    for (const d of u.deps) ds.push(fstamp(keyOfName.get(d) === undefined ? '' : keyOfName.get(d)));
    // `include` 摊进来的那几个文件也要进印记（这一刀）：正文有一半来自它们，可它们既不是
    // 这一份的 key、也不在 deps 里。少了这一格，改 base/plain_picture.asy 而 plain.asy
    // 没动时 `plain` 那份产物照旧算"还能用"，盘上那份**旧代码**被复用 —— 量出来的样子是
    // 往 plain_picture.asy 里加的探针在 OMNI_ASY_MODS=1 那一路一声不响。
    const ic = u.inc === undefined || u.inc === null ? [] : u.inc;
    for (const p of ic) ds.push(fstamp(p));
    // 正文里出现过主文件的基名（`_mainname()` 那一格）就把它记进印记的尾巴，别的入口对不上
    // 就重编；没出现的一格都不带，于是库那几份跨入口共用（见函数头那段账）。
    const mn = u.text.indexOf(mainWord) >= 0 ? `|${mainTag}` : '';
    return `${cs}|${fstamp(u.key)}|${ds.join('|')}${mn}`;
  };
  let made = 0;
  let kept = r.reused.length;
  for (const u of r.units) {
    const jsPath = join(dir, `${u.name}.js`);
    const stPath = join(dir, `${u.name}.stamp`);
    const stamp = stampOf(u);
    if (exists(stPath) && exists(jsPath)) {
      const old = readText(stPath);
      if (stampSame(old, stamp)) {
        kept++;
        // 内容一样、只是改动时间变了（touch / 重新 checkout）：把预检那两格刷新，下一趟连读都不用读
        if (old !== stamp) writeText(stPath, stamp);
        continue;
      }
    }
    writeText(join(dir, `${u.name}.sx`), u.text);
    // ADR-0015 第三步：把核心方言**逐条**落进声明存储（`d/<内容哈希>.sx`），
    // 单元旁边一格 `.idx` 记它有哪几条、什么次序。这一步只写不读，判据是"拼回去
    // 逐字节等于 `.sx`" —— 对上了才说明"条"这个粒度切得干净，后面 emit 与接口才能按条走。
    if (env('OMNI_ASY_DECLS') === '1' && u.parts !== undefined && u.parts !== null) {
      const dd = join(dir, 'd');
      mkdirAll(dd);
      const hs = [];
      for (const p of u.parts) {
        const h = hash16(p);
        hs.push(h);
        const pp = join(dd, `${h}.sx`);
        if (!exists(pp)) writeText(pp, p);   // 名字由内容决定：写一次就够，谁也盖不了谁
      }
      writeText(join(dd, `${u.name}.idx`), `${hs.join('\n')}\n`);
      const back = `(module\n${u.parts.join('\n')})\n`;
      vStep(back === u.text ? `asy 逐条切开   ${u.name} ${hs.length} 条`
        : `asy 逐条切开对不上 ${u.name}`);
    }
    const d = new Diagnostics();
    const mod = lowerCoreSexpr(new SourceFile(`${u.name}.sx`, u.text), d, `omni_init_${jsUnitSym(u.name)}`);
    d.throwIfErrors();
    writeText(jsPath, emitJs(mod, { esm: true }));
    // 下一趟要复用这一份时，前端连它的正文都不降 —— 那时靠的就是这三格：
    // `.sec` 是它定义的名字与签名（别人引它要发的 `(sig …)`），
    // `.wk` 是它引到的那些 weak 项的正文（那一档按程序生成，不生就成了未声明），
    // `.dep` 是复用它时还得跟着进来的那几份。
    //
    // **入口那一份不出这三格**：入口单元的前缀是空串（id 0），它的顶层名字于是是**裸的**
    // （`cardioid.asy` 里那个 `real f(real t)` 就叫 `f`）。出了 `.sec` 之后，别的程序在算
    // "还要带哪几份"时会把某个库 weak 项里出现的 `f` 认成"cardioid 定义的"，于是
    // `main-label3.js` 里多出一句 `omni_init_cardioid()` —— 量出来的样子就是 label3 与
    // gamma3 在 `$alen` 上炸（跑的是另一个例子的初始化）。入口本来也不该被谁复用。
    if (u.key !== '' && u.name !== r.entry) {
      writeText(join(dir, `${u.name}.sec`), `${u.sec.join('\n')}\n`);
      writeText(join(dir, `${u.name}.wk`), u.weak.join(`\n${ASY_WK_SEP}\n`));
      const dl = [`key|${u.key}`];
      for (const n of u.need) dl.push(`need|${n}`);
      writeText(join(dir, `${u.name}.dep`), `${dl.join('\n')}\n`);
      // 这一份的**接口索引**（第七十八刀）：下一个例子引到这个库时，靠它认名字与签名，
      // 源码与树都不再碰。存不下来的那种（碎片打包认不出形状）这一格是 null —— 不写，
      // 下一趟照旧从源码走。
      if (u.iface !== undefined && u.iface !== null) {
        writeText(join(dir, `${u.name}.aif`), JSON.stringify(u.iface));
      }
    }
    writeText(stPath, stamp);
    made++;
  }
  vStep(`asy units      新编 ${made} 份、复用 ${kept} 份`);
  // 每一份自己的 `(main …)` 只做一件事：把**这一份**的全局清零（第二十四刀那条
  // "零初始化在入口最前面"，现在分到了各家）。所以入口那份 main 先把各家的清零跑一遍，
  // 最后才是入口自己 —— 入口的 `(main …)` 里才是真正的程序（含调各模块的 init）。
  // 少了这一步，别人家的全局是 undefined：量出来的样子是 cyclic 登记处那一格
  // `Cannot read properties of undefined (reading 'length')`。
  const names = [];
  for (const u of r.units) if (u.name !== r.entry) names.push(u.name);
  for (const u of r.reused) if (u.name !== r.entry) names.push(u.name);
  names.sort();
  const lines = ["import './omni_rt.js';"];
  for (const n of names) lines.push(`import { omni_init_${jsUnitSym(n)} } from './${n}.js';`);
  lines.push(`import { omni_init_${jsUnitSym(r.entry)} } from './${r.entry}.js';`);
  for (const n of names) lines.push(`omni_init_${jsUnitSym(n)}();`);
  lines.push(`omni_init_${jsUnitSym(r.entry)}();`);
  lines.push('$js_check_uncaught();');
  lines.push('$flush();');
  lines.push('');
  // 入口那一份的启动器**按入口起名**：这个目录是共用的，叫 main.js 的话两个入口互相盖
  const mainPath = join(dir, `main-${r.entry}.js`);
  writeText(mainPath, lines.join('\n'));
  // 清单：这个入口用到哪几份产物、每份对应的源文件与它的改动时间/字节数，
  // 再加一格「这一份的印记里有没有 `main:`」（第一百〇四刀）。
  // 下一趟只要这张清单还成立，**整个前端一步都不走**（见 asyModsFast）。
  //
  // 那一格是必须的：库的产物现在**跨入口共用**了，而带主文件名的那几份（`_mainname()`）
  // 换个入口跑就会被原地盖掉 —— 清单只核源文件的话，A 的快路会拿起 B 刚写下的那一份。
  // 与 `w|` 那一格是同一类问题（同一个共用目录、同一个名字、内容却按程序变）。
  const mrec = (nm) => {
    const st = join(dir, `${nm}.stamp`);
    if (!exists(st)) return '-';
    for (const f of readText(st).split('|')) if (f.startsWith('main:')) return f;
    return '-';
  };
  const man = [asyModsEnv(), cs, r.entry];
  for (const u of r.units) man.push(`u|${u.name}|${u.key}|${fstamp(u.key)}|${mrec(u.name)}`);
  for (const u of r.reused) man.push(`u|${u.name}|${u.key}|${fstamp(u.key)}|${mrec(u.name)}`);
  // **omni_weak 那一份也要记一格**：它的内容由整个程序决定（名字却必须固定 ——
  // 库那几份 `.js` 里写死的是 `from './omni_weak.js'`），所以换个入口跑一趟就会把它盖掉。
  // 记下这一趟那份的印记，下一趟对不上就老老实实重来。
  // 量出来的样子（没有这一格时）：`run tri`、`run curve`、再 `run tri` —— 第三趟命中清单，
  // 拿的却是 curve 那份 weak，报 `s_…_shipout__d0_2_3_4_5_6_7_8_9` 不是它的导出。
  const wst = join(dir, `${r.weak}.stamp`);
  if (exists(wst)) man.push(`w|${readText(wst)}`);
  writeText(join(dir, `main-${r.entry}.dep`), `${man.join('\n')}\n`);
  vStep(`asy units      -> ${dir}`);
  return mainPath;
}

/**
 * 影响"同一个名字解析到哪个文件"的环境。清单里带上它 —— 换了 ASYMPTOTE_DIR
 * 或者换了当前目录（模块是**按当前目录**找的，量过），同一份清单就不再作数。
 *
 * 还带上**主文件的名字**：TeX 那条路上 `_mainname()` 把它降成了字面量（dvips 会把
 * dvi 的文件名写进产物正文，`TeXDict begin … (equilateral_.dvi)` 那一行），而单元那一级
 * 的产物缓存是按**源码内容**做键的 —— 不带主文件名的话，asy_builtins 那一份会被下一个
 * 例子照旧复用，名字就是上一个例子的。量出来过：equilateral 之后跑 fano，产物里写着
 * `(equilateral_.dvi)`。
 */
function asyModsEnv(path) {
  const d = env('ASYMPTOTE_DIR');
  const b = env('OMNI_ASY_BUILTINS');
  const m = path === undefined ? '' : fileUnitName(path);
  return `env|${cwd()}|${d === undefined ? '' : d}|${b === undefined ? '' : b}|${m}`;
}

/**
 * 上一趟的清单还成立吗？成立就直接回那份启动器的路径 —— 这一趟**不解析、不降级、
 * 不生成**，只剩 node 自己跑。
 *
 * 为什么这一格是必须的：产物缓存只砍掉"核心方言 -> JS"那一段，而量出来的大头在前端 ——
 * 一趟 1.8s 里 AST 读回来约 250ms、把库重新降级约 800ms，两样都发生在"知道产物还能用"
 * **之前**。所以判断"能不能用"这件事本身必须便宜：只 stat 清单里那几十个文件。
 *
 * 这里的每一问都必须与 asyModsBuild 写清单时**一模一样**：从前那边写的是
 * `srcStamp()|main:<入口>`、这边只比 `srcStamp()`，于是这条快路**永远不命中** ——
 * 同一个入口连跑两趟，第二趟照旧满编（量出来 5.9s，日志里那句「asy mods 不命中
 * 编译器自己变了」每趟都在，没人细看）。
 */
function asyModsFast(path, dir) {
  const nm = fileUnitName(path);
  const mainPath = join(dir, `main-${nm}.js`);
  const depPath = join(dir, `main-${nm}.dep`);
  // 不成立时**说清是哪一格不成立**：这条快路一旦悄悄失效，整个前端就白跑一趟
  // （量出来的样子是「换个入口跑一趟，再跑回来又是满编 0.9s」），而从日志上看不出来。
  const miss = (why) => { vStep(`asy mods 不命中 ${why}`); return null; };
  if (!exists(depPath) || !exists(mainPath)) return miss('还没有这个入口的清单');
  const lines = readText(depPath).split('\n');
  if (lines.length < 3) return miss('清单不全');
  if (lines[0] !== asyModsEnv()) return miss('环境变了（当前目录 / ASYMPTOTE_DIR）');
  if (lines[1] !== srcStamp()) return miss('编译器自己变了');
  if (lines[2] !== nm) return miss('入口名字对不上');
  for (let i = 3; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === '') continue;
    // omni_weak 那一格：它是按程序生成的，换个入口跑就会被盖掉（见 asyModsBuild）
    if (ln.startsWith('w|')) {
      const wst = join(dir, 'omni_weak.stamp');
      if (!exists(wst)) return miss('weak 那一份没了');
      if (readText(wst) !== ln.slice(2)) return miss('weak 那一份被别的入口盖掉了');
      continue;
    }
    const parts = ln.split('|');
    if (parts[0] !== 'u') return miss('清单里有认不出的行');
    if (!exists(join(dir, `${parts[1]}.js`))) return miss(`产物 ${parts[1]}.js 没了`);
    // 这一格记的是 `路径:改动时间:字节数:h内容哈希`（inpField 那一份），没有源文件的记 `-`。
    // 改动时间变了但内容哈希一样也算成立（touch / 重新 checkout 不该让整张清单作废）。
    const want = parts[3] === undefined ? '' : parts[3];
    if (!inpOk(want).ok) return miss(`源文件 ${parts[1]} 变了`);
    // 「这一份是不是带着某个入口的名字」那一格（第一百〇四刀）：库的产物跨入口共用之后，
    // 带 `_mainname()` 的那几份换个入口跑会被盖掉，只核源文件的话就会拿起别人那一份。
    const mwant = parts[4] === undefined ? '-' : parts[4];
    let mhave = '-';
    const stp = join(dir, `${parts[1]}.stamp`);
    if (exists(stp)) {
      for (const f of readText(stp).split('|')) if (f.startsWith('main:')) mhave = f;
    }
    if (mhave !== mwant) return miss(`产物 ${parts[1]} 是别的入口的那一份`);
  }
  if (!exists(join(dir, 'omni_rt.js'))) return miss('运行时那一份没了');
  vStep(`asy mods 命中   ${lines.length - 3} 份产物一份没动`);
  return mainPath;
}

/**
 * 核心 S 表达式方言 -> OIR（ADR-0014 决策 1 的汇聚点）。
 * `omni glr GRAMMAR FILE` 的输出就是这份方言，所以「加一门语言 = grammar + 映射标注」
 * 走的是同一条路：那边印出来，这边读进来，中间没有为那门语言写的代码。
 */
function compileSexpr(path) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(path, readText(path)), diags);
  diags.throwIfErrors();
  vStep(`core sexpr front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

/**
 * jancy 前端（ADR-0016 分步 7）。零件比 asy 那一份少得多：只有语法表 + 词法，
 * 没有内建绑定表（jancy 的标准库这一刀不接）、也没有解析缓存（一份 `.jnc` 就是一趟，
 * 没有 base/ 那样每次都重解析的库）。模块加载有了，见 jncText 里的 find / parse（第六十刀）。
 */
function jncFrontEnd() {
  const gpath = join(installDir(), '..', 'frontend-jnc', 'jnc.grammar');
  if (!exists(gpath)) throw new OmniError(`找不到 jnc 语法文件：${gpath}`);
  return loadGrammar(gpath);
}

/**
 * 一份 `.jnc` -> 语法树。入口文件与被 import 进来的文件走的是同一条（第六十刀）。
 *
 * 抛不抛只看**这个文件自己**新添了错没有，而不是 `throwIfErrors`。一趟降级现在会解好几个
 * 文件，而前面那些文件已经记下的"还不收"不该把后面的解析掐掉 —— 掐掉的话这一趟就只报得出
 * 第一条拦路项，语料尺子跟着少数。
 */
function jncParse(tb, path, diags) {
  const n0 = diags.errorCount();
  const file = new SourceFile(path, readText(path));
  const toks = lexText(tb.grammar.lex, file, diags);
  if (diags.errorCount() > n0) throw new OmniError(diags.format());
  vStep(`jnc lexer      ${path} -> ${toks.length} tokens`);
  const tree = glrParse(tb, toks, diags);
  if (diags.errorCount() > n0) throw new OmniError(diags.format());
  if (tree === null) throw new OmniError(`解析不了：${path}`);
  return tree;
}

/**
 * 一段**表达式源码** -> 那棵表达式的树（第六十四刀，给格式化字面量里的 `$(…)` 用）。
 *
 * 语法只有一个起点（`unit`），所以把这段源码裹成一个合法的单元再解析，再把 `return` 底下
 * 那一棵挖出来。jancy 那边是词法层做的（`lit_fmt_opener` 之后 `fcall main`，Lexer.rl:142，
 * 于是里头那段就是普通 token 流）；这一层的词法是一张 DFA，没有 fcall / fret，所以改成
 * "整块当一个 token、要用时再解析一遍"—— 认的是同一门语言。
 *
 * 裹的时候按**原文的行列**补空白：头一段占第一行，再补 line-1 个换行与 col-1 个空格，于是
 * 里头报的位置就是真文件里的真位置。字面量落在第一行时补不出来（头那段自己占着第一行），
 * 那时列往右偏 —— 行仍旧是对的。
 */
function jncParseExpr(tb, file, text, offset, diags) {
  const n0 = diags.errorCount();
  const { line, col } = file.lineCol(offset);
  const head = 'void __fmt__() { return (';
  const pad = line > 1 ? '\n'.repeat(line - 1) + ' '.repeat(col - 1) : '';
  const wrapped = new SourceFile(file.path, `${head}${pad}${text}); }`);
  const toks = lexText(tb.grammar.lex, wrapped, diags);
  if (toks === null || diags.errorCount() > n0) return null;
  const tree = glrParse(tb, toks, diags);
  if (tree === null || diags.errorCount() > n0) return null;
  const dig = (nd) => {
    if (nd === null || typeof nd !== 'object' || !Array.isArray(nd.items)) return null;
    const h = nd.items[0];
    if (nd.items.length > 1 && h !== undefined && h !== null && h.value === 'return') return nd.items[1];
    for (const it of nd.items) {
      const r = dig(it);
      if (r !== null) return r;
    }
    return null;
  };
  return dig(tree);
}

/**
 * 一份 `.jnc` -> 核心方言的文本。`omni sx` 那条路也走它，所以降级只有一份实现。
 *
 * `needEntry`（第六十五刀）：要跑的那几条腿要一个 `int main()`；`omni sx` 只要降下来的
 * 文本，库模块本来就没有入口（语料 662 份里 408 份是这种），所以那条路上不要。
 */
function jncText(path, dirs = [], needEntry = true) {
  const tb = jncFrontEnd();
  const diags = new Diagnostics();
  const tree = jncParse(tb, path, diags);
  // import 的找法（第六十刀定的形，第六十二刀补上 `-I`）：绝对路径原样看在不在；否则先
  // **在写这条 import 的文件自己的目录里**找，再按给的顺序逐个试 `-I` 的目录 —— 与
  // jancy 的 findImportFile 一模一样（io::findFilePath(fileName, unit->getDir(),
  // &m_importDirList, false)，jnc_ct_ImportMgr.cpp:110-119；那个 false 是
  // doFindInCurrentDir，所以**进程的当前目录不算一格**，axl_io_FilePathUtils.cpp:428-446）。
  // 路径过一遍 resolve（jancy 那边是 io::getFullFilePath，jnc_ct_Module.cpp:386）——
  // 查重认的是这一格，所以 `./a.jnc` 与 `a.jnc` 是同一个文件。
  const find = (spec, from) => {
    if (isAbsolute(spec)) return exists(spec) ? resolve(spec) : null;
    const here = join(dirname(from), spec);
    if (exists(here)) return resolve(here);
    for (const d of dirs) {
      const p = join(d, spec);
      if (exists(p)) return resolve(p);
    }
    return null;
  };
  const text = lowerJnc(tree, diags, {
    path,
    unit: resolve(path),
    find,
    parse: (p) => jncParse(tb, p, diags),
    parseExpr: (file, src, offset) => jncParseExpr(tb, file, src, offset, diags),
    dirs,
    needEntry,
  });
  diags.throwIfErrors();
  return text;
}

function compileJnc(path, dirs = []) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${path}.sx`, jncText(path, dirs)), diags);
  diags.throwIfErrors();
  vStep(`jnc front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

/**
 * 入口 -> 模块图 -> 检查 -> OIR。
 * 依赖不再靠"提到 json 就整体拼进来"的猜测（旧的 libsFor），而是靠源码里写下的 import（ADR-0009）。
 * `--mode` 只覆盖入口文件的模式；被导入模块的模式由它自己的后缀决定。
 */
function compileProgram(path, text, mode) {
  const diags = new Diagnostics();
  const { decls, imports, files } = loadProgram({ path, text, mode, diags });
  diags.throwIfErrors();
  vStep(`front end  ${path}  mode ${mode}, ${files.length} files, ${decls.length} decls, ${imports.size} imports`);
  const program = { kind: 'Program', decls, imports };
  const mod = check(program, diags, mode);
  diags.throwIfErrors();
  vStep(`check -> OIR  ${mod.funcs.length} funcs, ${mod.structs.length} structs`);
  return { ast: program, mod, diags };
}

/** 找一个可用的 C 编译器：tcc 最快，适合开发循环；clang/gcc 用于发布 */
let findCCMemo = '';
function findCC() {
  if (findCCMemo !== '') return findCCMemo;
  const explicit = env('OMNI_CC');
  if (explicit) { findCCMemo = explicit; return findCCMemo; }
  for (const cc of ['tcc', 'clang', 'gcc', 'cc']) {
    const r = spawn('which', [cc], 'c');
    if (r[0] === 0 && r[1].trim()) { findCCMemo = cc; return findCCMemo; }
  }
  throw new OmniError('no C compiler found (tried tcc, clang, gcc, cc; override with OMNI_CC)');
}

/**
 * 优化档。**默认 -O0**：这条腿在测试轴上的角色是"另一份语义实现"，不是性能基线，
 * 而 clang -O2 在这些几百行的翻译单元上就是纯粹的等待（量过：run-c 一次 0.42s -> 0.28s，
 * 五条腿 × 四十个用例乘起来就是半分钟）。要性能数字的场合显式开：`OMNI_OPT=2`。
 * 语义不因此改变 —— 逐个运算的语义靠的是下面那条 `-ffp-contract=off`，与档位无关。
 */
function optFlag() {
  const o = env('OMNI_OPT');
  return o === undefined || o === '' ? '-O0' : `-O${o}`;
}

/**
 * tcc 要的是极速编译，clang/gcc 用 optFlag()；运行时和生成的代码用同一份 flags。
 * `-ffp-contract=off` 不是可选的：clang 默认允许在一条语句里把 `a + b*c` 合成 FMA，
 * 那条 FMA 少一次中间舍入，于是 C 那条腿与 JS 那条腿的浮点结果**会分叉**。
 * 这条是量出来的 —— 曾经在运行库里自己写过一版 `exp`（Horner 全是 `a + r*s`），
 * 在 `exp(-10.0)` 上 run 与 run-c 差 1 ULP，加上这个 flag 才一致。那份实现后来撤了
 * （超越函数改成转手宿主的数学库），但 flag 留着：核心方言的 `(bin "*" …)`/`(bin "+" …)`
 * 是**逐个运算**的语义，编译器不许替我们改写 —— 这跟数学库怎么绑没关系。
 */
function ccFlags(cc) {
  // -pthread：入口跑在一条大栈的线程上（omni_run_entry），编译与链接两边都要这一位。
  // macOS 上 pthread 就在 libSystem 里、这个开关等于空操作；glibc 2.34 起也已并进 libc。
  return cc === 'tcc' ? ['-I', RUNTIME_DIR]
    : [optFlag(), '-std=c99', '-ffp-contract=off', '-w', '-pthread', '-I', RUNTIME_DIR];
}

/**
 * 运行时的 .o 缓存。不缓存就是每次 build 都重编 8 个翻译单元：实测 757ms -> 73ms，10 倍。
 * 自举时编译器要反复重建自己，这条直接决定开发循环还能不能用。
 * 缓存键 = 编译器 + flags + 运行时目录下每个 .c/.h 的 mtime 与大小（改 omni.h 会让全部失效）。
 */
function runtimeObjects(cc) {
  const flags = ccFlags(cc);
  const srcs = runtimeSources();
  const deps = readDir(RUNTIME_DIR).filter((f) => /\.[ch]$/.test(f)).sort()
    .map((f) => {
      const p = join(RUNTIME_DIR, f);
      return `${f}:${mtimeMs(p)}:${fileSize(p)}`;
    });
  const key = hash16([cc, ...flags, ...deps].join('|'));
  const dir = join(cacheRoot(), 'rt', key);
  const objs = srcs.map((p) => join(dir, `${basename(p, '.c')}.o`));
  if (objs.every((o) => exists(o))) {
    vStep(`runtime .o  ${objs.length} objects, cache hit ${dir}`);
    return objs;
  }

  // 先编进暂存目录再整体 rename：中断不会留下半个缓存
  const stage = workDirFor('rt-stage', key);
  const staged = srcs.map((p) => join(stage, `${basename(p, '.c')}.o`));
  for (let i = 0; i < srcs.length; i++) {
    const r = spawn(cc, [...flags, '-c', '-o', staged[i], srcs[i]], 'c');
    if (r[0] !== 0) {
      throw new OmniError(`omni runtime failed to compile with ${cc}:\n${r[2]}`);
    }
  }
  // 目标已存在 = 别人先建好了，下面那句会用它（rename 到一个非空目录在两个宿主上都是硬错，
  // 而宿主的错误不是可以 catch 的异常，所以先看一眼）。父目录得先在，rename 才有地方落。
  mkdirAll(join(cacheRoot(), 'rt'));
  if (!exists(dir)) rename(stage, dir);
  vStep(`runtime .o  ${srcs.length} objects compiled with ${cc}`);
  return objs.every((o) => exists(o)) ? objs : staged;
}

/**
 * workDir 给的时候，生成的 .c 就留在那里（名字跟着产物走）——
 * `omni bootstrap` 与 `build --work DIR` 要的是"中间产物留在构建目录里"：链断在哪一代
 * 都能直接翻出那份 C 来看。不给的时候落在 `.omni-cache/work/c-<产物名>` 底下，
 * 名字是确定的（从前是 /var/folders 里一个随机名，出了问题捞不着）。
 */
function buildNative(mod, outPath, workDir) {
  const dir = workDir === undefined ? workDirFor('c', hash16(outPath)) : workDir;
  if (workDir !== undefined) mkdirAll(dir);
  const cPath = join(dir, `${basename(outPath)}.c`);
  const cText = emitC(mod);
  writeText(cPath, cText);
  vStep(`backend c  ${cText.length} bytes -> ${cPath}`);
  const cc = findCC();
  // 运行时是 stage0/runtime/ 下真正的 C 文件，预编成 .o 缓存起来；热的叶子函数是
  // omni.h 里的 static inline，所以不靠 LTO 也能内联（tcc 没有 -flto）
  // 外部 C 符号用到的库跟在后面（ADR-0014 决策 4）；libc 的那些 lib 是 null，不产生 -l
  const libs = cAbiLibs(mod.cabi ?? []).map((l) => `-l${l}`);
  const cargs = [...ccFlags(cc), cPath, ...runtimeObjects(cc), '-o', outPath, '-lm', ...libs];
  const r = spawn(cc, cargs, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`C backend produced code that ${cc} rejected:\n${r[2]}\n(kept at ${cPath})`);
  }
  vStep(`${cc}  ${cargs.length} args -> ${outPath}  ${fileSize(outPath)} bytes`);
  return { cPath, cc };
}

/**
 * C 路径上的"直接执行"：编出一个可执行文件再跑掉，退出码原样传回。
 * `run-c` 就是它；原生构建上的 `run` 也是它（那一代没有 JS 引擎）。
 * `--work DIR` 会把可执行文件和生成的 C 都留在 DIR 里，方便事后看。
 */
/** 解释器（ADR-0013）：不经过任何别的执行器，OIR 直接跑 */function runInterp(mod) {
  const code = interpret(mod);
  vStep(`exec interp  OIR ${mod.funcs.length} funcs  exit=${code}`);
  return code;
}

/** MIR 上的闭包编译解释器（ADR-0014 决策 7）：降级 -> verify -> 编成闭包 -> 跑 */
function runInterpMir(mod) {
  const code = interpretMir(mod);
  vStep(`exec interp --mir  ${mod.funcs.length} funcs  exit=${code}`);
  return code;
}

/**
 * @param srcPath 这一趟的源文件（工作目录按它起名 —— **不能是一个固定名字**：
 *   测试轴上好几个例子的同一条腿是同时跑的，共用一个 `a.out` 就会跑到别人的程序上。
 *   量出来的样子：`cases/95-sig-batch` 的 run-llvm 印的是另一个例子的输出。）
 * @param cache 吃不吃可执行文件缓存。`run` 吃，`run-c`（明说要走这条腿）不吃。
 */
function runViaC(mod, argv, srcPath, cache) {
  const wi = argv.indexOf('--work');
  // `--work` 给了就照它办（要的是"留在那儿"）；否则**直接链进产物缓存那一格** ——
  // 下一趟同一份源码进来，exeCacheGet 命中就只剩 exec（第一百〇五刀）。
  const cached = wi >= 0 || cache !== true ? null : exeCachePath(srcPath);
  const dir = wi >= 0 ? argv[wi + 1] : workDirFor('run', hash16(srcPath === undefined ? '' : srcPath));
  if (wi >= 0) mkdirAll(dir);
  const exe = cached === null ? join(dir, 'a.out') : cached;
  const built = buildNative(mod, exe, wi >= 0 ? dir : undefined);
  if (cached !== null) exeCachePut(srcPath, built.cc, lastAsyDeps);
  const code = spawn(exe, [], 'i')[0];
  vStep(`exec ${exe}  exit=${code}`);
  return code;
}

/**
 * LLVM 路径（ADR-0014 决策 3）。第一阶段是 **AOT via 文本 IR**：MIR -> .ll -> clang。
 *
 * 为什么还要外部 clang：ORC JIT 那一步要通过 C-FFI 调 libLLVM-C，而它需要的是同一份
 * 文本 IR（`LLVMParseIRInContext`）—— 也就是说**发射器不用重写**，先把降级这一半做对。
 * 「运行期不需要 cc」那条约束因此还没兑现，这是明说的阶段边界，不是忘了。
 *
 * tcc 不认 .ll，所以这条路只用 clang（`OMNI_CLANG` 可覆盖）。运行时目标文件仍然复用
 * runtimeObjects 那份缓存：LLVM 只负责用户代码，运行时永远是 C。
 */
function findClang() {
  const explicit = env('OMNI_CLANG');
  if (explicit) return explicit;
  for (const cc of ['clang', '/opt/homebrew/opt/llvm/bin/clang', 'gcc']) {
    const r = spawn('which', [cc], 'c');
    if (r[0] === 0 && r[1].trim()) return cc;
  }
  throw new OmniError('no clang found for the llvm backend (override with OMNI_CLANG)');
}

function buildLlvm(mod, outPath, workDir) {
  const mir = lowerToMir(mod);
  const errs = verifyMir(mir);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  const ir = emitLlvm(mir);
  const dir = workDir === undefined ? workDirFor('ll', hash16(outPath)) : workDir;
  if (workDir !== undefined) mkdirAll(dir);
  const llPath = join(dir, `${basename(outPath)}.ll`);
  writeText(llPath, ir);
  vStep(`backend llvm  ${ir.length} bytes -> ${llPath}`);
  const cc = findClang();
  const args = [optFlag(), '-w', '-ffp-contract=off', '-pthread', '-I', RUNTIME_DIR, llPath,
    ...runtimeObjects(cc), '-o', outPath, '-lm'];
  const r = spawn(cc, args, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`llvm backend produced IR that ${cc} rejected:\n${r[2]}\n(kept at ${llPath})`);
  }
  vStep(`${cc}  ${args.length} args -> ${outPath}  ${fileSize(outPath)} bytes`);
  return { llPath, cc };
}

function runViaLlvm(mod, argv, srcPath) {
  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : workDirFor('run-ll', hash16(srcPath === undefined ? '' : srcPath));
  if (wi >= 0) mkdirAll(dir);
  const exe = join(dir, 'a.out');
  buildLlvm(mod, exe, wi >= 0 ? dir : undefined);
  const code = spawn(exe, [], 'i')[0];
  vStep(`exec ${exe}  exit=${code}`);
  return code;
}

/**
 * ORC JIT（ADR-0014 决策 3 第二阶段）。
 *
 * 兑现的是「运行期不需要 cc」：磁盘上不落目标文件、不链接、不 exec 一个新二进制 ——
 * 文本 IR 直接进 `LLVMParseIRInContext`，ORC 惰性物化，查到地址就跳进去。
 * 与 AOT 共用**同一个发射器**，这正是当初选文本 IR 而不是 C API 建 IR 的回报。
 *
 * 还有一层间接没去掉：ORC 那一段在 `stage0/jit/omni_jit.c` 里，node 这一侧是 spawn 它。
 * 原因写在那个文件的头上 —— 封闭的 C_ABI 没有「按 ptr 间接调用」，而 JIT 的最后一步
 * 就是它。补上等于给 JS 域一把任意函数指针，那要另开一条 ADR。所以这条边界是划的，
 * 不是忘了：**编译**这一半已经不需要 cc 了，**宿主**那一半还是一个 C 程序。
 *
 * 宿主本身要编一次（约 1s），所以按 [编译器, LLVM 版本, 源文件, 运行时 .o] 做内容寻址
 * 缓存，和 runtimeObjects 同一套路。
 */
function findLlvmConfig() {
  const explicit = env('OMNI_LLVM_CONFIG');
  if (explicit) return explicit;
  for (const lc of ['llvm-config', '/opt/homebrew/opt/llvm/bin/llvm-config',
    '/usr/local/opt/llvm/bin/llvm-config']) {
    const r = spawn('which', [lc], 'c');
    if (r[0] === 0 && r[1].trim()) return lc;
  }
  throw new OmniError(
    'no llvm-config found; the jit host needs LLVM headers and libLLVM '
    + '(override with OMNI_LLVM_CONFIG, or use run-llvm for the AOT path)');
}

/** JIT 宿主的源码位置在 c_runtime.js 里定（和 RUNTIME_DIR 同一处，布局知识只有一份） */
function buildJitHost() {
  const cc = findClang();
  const lc = findLlvmConfig();
  const ver = spawn(lc, ['--version'], 'c');
  if (ver[0] !== 0) throw new OmniError(`${lc} --version failed:\n${ver[2]}`);
  const inc = spawn(lc, ['--includedir'], 'c');
  const libdir = spawn(lc, ['--libdir'], 'c');
  if (inc[0] !== 0 || libdir[0] !== 0) throw new OmniError(`${lc} did not report its paths`);
  const src = join(JIT_DIR, 'omni_jit.c');
  if (!exists(src)) throw new OmniError(`jit host source is missing: ${src}`);

  const objs = runtimeObjects(cc);
  const key = hash16([cc, ver[1].trim(), src, mtimeMs(src), fileSize(src), ...objs].join('|'));
  const dir = join(cacheRoot(), 'jit', key);
  const exe = join(dir, 'omni-jit');
  if (exists(exe)) {
    vStep(`jit host  cache hit ${exe}`);
    return exe;
  }
  // 运行时的 .o 直接链进宿主，JIT 出来的代码靠「进程符号搜索」找到它们（见 omni_jit.c）。
  // -Wl,-export_dynamic 是必须的：默认情况下可执行文件的符号不进动态符号表，
  // ORC 就找不到 omni_print_int 这些。
  const stage = workDirFor('jit-stage', key);
  const staged = join(stage, 'omni-jit');
  const args = ['-O2', '-w', '-pthread', '-I', inc[1].trim(), '-I', RUNTIME_DIR, src, ...objs,
    '-L', libdir[1].trim(), '-lLLVM', '-lm', '-Wl,-export_dynamic', '-o', staged];
  const r = spawn(cc, args, 'o');
  if (r[0] !== 0) throw new OmniError(`the jit host failed to build with ${cc}:\n${r[2]}`);
  mkdirAll(join(cacheRoot(), 'jit'));
  if (!exists(exe)) rename(stage, dir);
  vStep(`jit host  built with ${cc} + LLVM ${ver[1].trim()} -> ${exists(exe) ? exe : staged}`);
  return exists(exe) ? exe : staged;
}

function runViaJit(mod, argv, srcPath) {
  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : workDirFor('run-jit', hash16(srcPath === undefined ? '' : srcPath));
  if (wi >= 0) mkdirAll(dir);
  const mir = lowerToMir(mod);
  const errs = verifyMir(mir);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  const ir = emitLlvm(mir);
  const llPath = join(dir, 'jit.ll');
  writeText(llPath, ir);
  vStep(`backend llvm  ${ir.length} bytes -> ${llPath}`);
  const host = buildJitHost();
  const code = spawn(host, [llPath], 'i')[0];
  vStep(`orc jit ${llPath}  exit=${code}`);
  return code;
}


function main(argv) {
  const [cmd, ...rest] = argv;
  // --verbose 要在做任何事之前生效，否则第一步的耗时就丢了
  VERBOSE = rest.includes('--verbose') || rest.includes('-v');
  vMark = nowMs();
  // 带值的开关（-o NAME / --mode M / -I 目录 / -D 宏）的值不能被当成源文件。
  // `-I` 与 `-D` 是补上的（第五刀）：少了它们，`cpp -I dir x.c` 会把 `dir` 当成源文件 ——
  // 而 `.jnc` 那一路的 `-I` 本来就有同一个毛病，一并修掉。
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-o' || a === '--mode' || a === '--work' || a === '--cache'
      || a === '-I' || a === '-D' || a === '--rdata'
      || a === '-L' || a === '--target' || a === '-e' || a === '-l'
      || a === '--dylib' || a === '--libtcc1' || a === '--dll'
      || a === '--soname' || a === '--rpath' || a === '--install-name'
      || a === '--subsystem' || a === '--image-base' || a === '--stack'
      || a === '--file-align' || a === '--section-align' || a === '--dwarf'
      || a === '-MF' || a === '-U' || a === '-isystem' || a === '-include') { i++; continue; }
    if (a.startsWith('-')) continue;
    files.push(a);
  }
  const path = files[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    stdout(USAGE);
    return 0;
  }
  // repl 没有源文件；默认模式是 ADR-0008 第 3 节的 dynamic（沿革见 repl.js 文件头）。
  // `--lang` 选前端：驱动是与语言无关的，omni 走检查器的增量会话，sx/asy 走核心方言的，
  // js 走 frontend-js 的增量会话（原生二进制上一样有交互式 JS —— 那是前端，不需要
  // 宿主有能吃 JS 文本的引擎）。
  // `--engine` 选**执行引擎**：interp（OIR 解释器）| js（JS 后端，产物装进同一个全局
  // 作用域）。两条都是增量的 —— 引擎只需要 install/runEntry 这一对口子。
  // asy 要语法表与内建绑定表，那是文件 IO，所以由这里注入（repl.js 不碰盘）。
  if (cmd === 'repl') {
    const li = rest.indexOf('--lang');
    const ei = rest.indexOf('--engine');
    return startRepl(modeFor('', rest, 'dynamic'), li >= 0 ? rest[li + 1] : 'omni',
      { asy: asyFrontEnd, asyPrelude: () => (env('OMNI_ASY_BUILTINS') === '0' ? '' : 'asy_builtins') },
      ei >= 0 ? rest[ei + 1] : 'interp');
  }
  // 自举也没有源文件参数（默认就是编译器自己）。整条链与四条门槛见 bootstrap.js
  if (cmd === 'bootstrap') {
    const oi = rest.indexOf('-o');
    const outDir = oi >= 0 ? rest[oi + 1] : join(cwd(), 'dist');
    const source = path === undefined ? join(installDir(), '..', 'cli.js') : path;
    if (!exists(source)) {
      throw new OmniError(`bootstrap: no compiler source at ${source}; pass the path explicitly`);
    }
    const r = bootstrapSelf({
      source,
      outDir,
      quick: rest.includes('-q') || rest.includes('--quick'),
      emitOf: (kind, p) => {
        const { mod } = compile(p, []);
        return kind === 'c' ? emitC(mod, {}) : emitJs(mod);
      },
      buildTo: (p, out, work) => buildNative(compile(p, []).mod, out, work).cc,
    });
    return r.fail > 0 ? 1 : 0;
  }
  if (!path) throw new OmniError(`command '${cmd}' needs a source file`);
  if (!exists(path)) throw new OmniError(`no such file: ${path}`);

  switch (cmd) {
    case 'run': {
      // 一个源文件一份产物那条路（第七十五刀）：产物按源文件名躺在一个**共用目录**里，
      // 跑的是 node 自己的 ESM 模块图 —— 复用与增量都在那个目录上，不在这一趟里。
      // **这是默认**（第一百〇四刀）：它是唯一一条"改一个文件只重编一份"的路，
      // 而那条整份程序一份大 JS 的缓存只在源码一个字节都没动时才管用。
      // `OMNI_ASY_MODS=0` 回到"整份程序一份大 JS"那条（对照用）。
      if (path.endsWith('.asy') && hasJsEngine() && !rest.includes('--interp')
        && env('OMNI_ASY_MODS') !== '0') {
        const dir = asyModsDir();
        // 先问一句"上一趟的清单还成立吗"。成立就一步前端都不走 —— 判断本身只是几十个 stat。
        const hit = asyModsFast(path, dir);
        const mainPath = hit === null ? asyModsBuild(path, dir) : hit;
        const st = spawn('node', [mainPath], 'i')[0];
        vStep('exec node（每个源文件一份 ESM）');
        return st;
      }
      // 产物缓存（第七十四刀）：同一份源码（连它引的每个模块）没动过就直接跑上一趟的 JS。
      // 只对 asy 那一路开 —— 别的前端还没有依赖清单。`--interp` 那条腿要 OIR，绕开。
      const cacheable = path.endsWith('.asy') && hasJsEngine() && !rest.includes('--interp');
      if (cacheable) {
        const hit = jsCacheGet(path);
        if (hit !== null) {
          vStep(`asy js cache  ${hit.length} bytes`);
          evalJs(hit);
          vStep('exec in-process (node host, indirect eval)');
          return 0;
        }
      }
      // 原生那一路的产物缓存（第一百〇五刀）：**链好的可执行文件**按同一把印记躺在
      // `.omni-cache/asy-exe` 里，源码与它引的库都没动就只剩 exec。
      // 量出来（自举出来的二进制，03-quotes.asy）：那 12.6s 里 AST 读回来 3.4s、
      // 前端 5.0s、发 C 2.5s、clang 0.5s，而输入一个字节都没变。
      // 这一格必须在 compile **之前**问 —— 大头全在前端。
      if (path.endsWith('.asy') && !hasJsEngine() && !rest.includes('--interp')
        && !rest.includes('--mir') && !rest.includes('--work')) {
        const exe = exeCacheGet(path, findCC());
        if (exe !== null) {
          vStep(`asy exe cache  ${fileSize(exe)} bytes  ${exe}`);
          const st = spawn(exe, [], 'i')[0];
          vStep(`exec ${exe}  exit=${st}`);
          return st;
        }
      }
      const { mod } = compile(path, rest);
      // 自己的解释器（ADR-0013）。阶段 1 还没覆盖全部 op，所以要显式要它
      if (rest.includes('--interp')) return runInterp(mod);
      // `run` 的意思是"解析完直接执行"，怎么执行是**这一代宿主的事**：node 上是生成 JS
      // 在本进程里 eval；原生构建里没有第三方 JS 引擎，那边同一件事走 C 路径 ——
      // 前端、检查、OIR 都是同一份，换的只是"谁来跑最后那一步"。所以先问一句能力，
      // 而不是让 js_eval 报错：用户要的是执行，不是一句"换个命令重试"。
      // 注意这不是"原生构建少了一种能力"：JS 源码在两边都能编能跑（tests/js-exec 那条轴
      // 在自举出来的编译器上也过），少的只是"直接吃一段 JS 文本当程序跑"的那个引擎。
      if (hasJsEngine()) {
        const js = emitJs(mod);
        vStep(`backend js  ${js.length} bytes`);
        if (cacheable) jsCachePut(path, js, lastAsyDeps);
        evalJs(js);
        vStep('exec in-process (node host, new Function)');
        return 0;
      }
      // 这一代没有 JS 引擎，"直接执行"就是 C 路径（产物缓存见 runViaC）
      return runViaC(mod, rest, path, true);
    }
    case 'emit-js': {
      const { mod } = compile(path, rest);
      stdout(emitJs(mod));
      return 0;
    }
    case 'emit-c': {
      const { mod } = compile(path, rest);
      stdout(emitC(mod, { amalgamate: rest.includes('--amalgamate') }));
      return 0;
    }
    case 'build': {
      const { mod } = compile(path, rest);
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : basename(path).replace(/\.(omni|omnis|omnid|js)$/, '');
      // --work DIR：生成的 C 留在 DIR 里而不是临时目录（自举链要能事后翻中间产物）
      const wi = rest.indexOf('--work');
      const { cc } = buildNative(mod, out, wi >= 0 ? rest[wi + 1] : undefined);
      stderr(`omni: built ${out} via ${cc}\n`);
      return 0;
    }
    case 'run-c': {
      const { mod } = compile(path, rest);
      // `run-c` 是"明说要走 C 这条腿"（测试轴的一条），所以**不吃产物缓存**：
      // 那条缓存是给 `run`（"把我的程序跑起来"）的，见 exeCacheGet。
      return runViaC(mod, rest, path, false);
    }
    // LLVM 路径（ADR-0014 决策 3，第一阶段 = AOT via 文本 IR）
    case 'emit-llvm': {
      const { mod } = compile(path, rest);
      const mir = lowerToMir(mod);
      const errs = verifyMir(mir);
      if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
      stdout(emitLlvm(mir));
      return 0;
    }
    case 'run-llvm': {
      const { mod } = compile(path, rest);
      return runViaLlvm(mod, rest, path);
    }
    // GPU 路径（ADR-0014 门槛 7 的另一半）：一个 kernel 一份 SPIR-V 汇编。
    // 只发文本 —— 打包成二进制字是 spirv-as 的活，而它是官方工具（见 backend-spirv 的文件头）。
    case 'emit-spirv': {
      const { mod } = compile(path, rest);
      const mir = lowerToMir(mod);
      const errs = verifyMir(mir);
      if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
      const ki = rest.indexOf('--kernel');
      stdout(emitSpirv(mir, ki >= 0 ? rest[ki + 1] : undefined));
      return 0;
    }
    case 'run-jit': {
      const { mod } = compile(path, rest);
      return runViaJit(mod, rest, path);
    }
    case 'build-llvm': {
      const { mod } = compile(path, rest);
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : basename(path).replace(/\.(omni|omnis|omnid|js|wat)$/, '');
      const wi = rest.indexOf('--work');
      const { cc } = buildLlvm(mod, out, wi >= 0 ? rest[wi + 1] : undefined);
      stderr(`omni: built ${out} via llvm ir + ${cc}\n`);
      return 0;
    }
    // 自己的解释器（ADR-0013 阶段 1）：不生成 JS、不生成 C，直接走 OIR。
    // `--mir` 换成 MIR 那条（ADR-0014 决策 7）：闭包编译 + 值窗口帧，分派只付一次。
    // 两条**必须给出同样的输出** —— 这是「五方逐字节相同」里的第四方与第五方。
    case 'interp': {
      const { mod } = compile(path, rest);
      return rest.includes('--mir') ? runInterpMir(mod) : runInterp(mod);
    }
    case 'ast': {
      const { ast } = compile(path, rest);
      stdout(JSON.stringify(ast, replacer, 2) + '\n');
      return 0;
    }
    // asy / jancy -> 核心方言 那一步的**文本**。核心方言的诊断报的是 `<文件>.asy.sx:L:C`，
    // 而那份 .sx 是虚拟的（从不落盘），所以没有这一条就只能拿着行号猜。印出来的
    // 内容与 lowerCoreSexpr 拿到的**逐字节相同** —— 行号可以直接对。
    case 'sx': {
      stdout(path.endsWith('.jnc') ? jncText(path, incDirs(rest), false) : asyText(path));
      return 0;
    }
    // C 的预处理（ADR-0017 第五刀）。**格式与 `tcc -E` 逐字节相同** —— 那是它的
    // 测试轴（`tests/c/`）：同一份 `.c` 交给我们和 tcc，两份输出必须一样。
    // `-I <目录>` 与 `.jnc` 那一路共用同一个收集器；`-D 名字[=宏体]` 与 tcc 同形。
    case 'cpp': {
      /* `-dD` / `-dM`：把 `#define`/`#undef`/`#pragma *_macro` 边过边印，
       * `-dM` 再把记号流那一半掐掉（tcc 的 `dflag` = 3 / 7）。 */
      const dflag = rest.includes('-dM') ? 7 : (rest.includes('-dD') ? 3 : 0);
      /* `-P[n]`：行标那一格。tcc 是 `Pflag = atoi(后面那串) + 1` —— `-P` → 1（什么都不印）、
       * `-P1` → 2（`#line`）、`-P10` → 11。不给就是 0，GCC 的 `# 行号 "文件"`。 */
      let pflag = 0;
      for (const a of rest) {
        if (a === '-P' || /^-P\d+$/.test(a)) pflag = (Number.parseInt(a.slice(2), 10) || 0) + 1;
      }
      /* `-M` 一族（tcc 的 `gen_deps`，libtcc.c:2095）：`-M`/`-MD` 连系统头一起记，
       * `-M`/`-MM` 只出依赖不出正文（`just_deps`）。`-MF <文件>` 换落脚处（`-` = 标准输出），
       * 不给的话 `-M`/`-MM` 落标准输出、`-MD`/`-MMD` 落 `目标.d`。`-MP` 补空规则。 */
      const wantDeps = ['-M', '-MM', '-MD', '-MMD'].some((o) => rest.includes(o));
      const justDeps = rest.includes('-M') || rest.includes('-MM');
      const mfi = rest.indexOf('-MF');
      const oi = rest.indexOf('-o');
      const deps = wantDeps
        ? { sys: rest.includes('-M') || rest.includes('-MD') } : undefined;
      /* `-v` 是数出来的，不是查表：tcc 那边 `do ++verbose; while (*optarg++ == 'v')`
       * （libtcc.c:2044），于是 `-v` = 1、`-vv` = 2、`-vvv` = 3。2 起才开始印头文件
       * 的开合（`->` 开成了 / `=>` 有卫哨于是跳过 / `nf` 这一格没有）。 */
      let verbose = 0;
      for (const a of rest) if (/^-v+$/.test(a)) verbose = a.length - 1;
      const out = cppText(path, incDirs(rest), defArgs(rest), dflag, pflag, deps,
        sysIncDirs(rest), inclArgs(rest), verbose);
      if (wantDeps) {
        const target = oi >= 0 ? rest[oi + 1] : depTarget(path);
        const text = makedepsText(target, deps.list, rest.includes('-MP'));
        let to = mfi >= 0 ? rest[mfi + 1] : (justDeps ? '-' : null);
        if (to === null) to = `${target.slice(0, target.lastIndexOf('.'))}.d`;
        if (to === '-') stdout(text);
        else writeText(to, text);
      }
      if (!justDeps) stdout(out);
      return 0;
    }    // C -> MIR（ADR-0017 第六刀）。`c-mir` 印 MIR，`c-run` 跑它 ——
    // **退出码就是 C 的 `main` 的返回值**，与 `tcc -run` 逐条相同，那也是这一刀的 oracle。
    case 'c-mir': {
      const { flags, prog } = cSplitArgs(rest);
      stdout(printMir(cMir(path, incDirs(flags), defArgs(flags), prog)));
      return 0;
    }
    case 'c-run': {
      const { flags, prog } = cSplitArgs(rest);
      const mod = cMir(path, incDirs(flags), defArgs(flags), prog);
      return runMirModule({ structs: [], enums: [], classes: [], js: false }, mod);
    }
    /* `c-obj`：C -> 真机器码 -> 一个 `.o`（第九刀第二十六片）。
     * 链接留给外面（`clang a.o -o a`）—— 可执行文件的写出还没到。 */
    case 'c-obj': {
      const { flags } = cSplitArgs(rest);
      const oi = flags.indexOf('-o');
      const out = oi >= 0 ? flags[oi + 1] : `${basename(path, '.c')}.o`;
      const ai = flags.indexOf('--arch');
      const arch = ai >= 0 ? flags[ai + 1] : 'arm64';
      /* `--format elf` 写 tcc 那种 `.o`（`ET_REL`），`--os linux` 去掉符号名前那条
       * 下划线。默认还是 Mach-O —— 本机的 clang 只吃那一种。 */
      const fi = flags.indexOf('--format');
      const fmt = fi >= 0 ? flags[fi + 1] : 'macho';
      const si = flags.indexOf('--os');
      const os = si >= 0 ? flags[si + 1] : 'osx';
      stdout(`${cObj(path, out, arch, incDirs(flags), defArgs(flags), fmt, os)}\n`);
      return 0;
    }
    /* `elf-r`：几个 `.o` 并成一个 `.o`，就是 `tcc -r`（第九刀第四十二片）。
     * 输入可以是 **tcc 自己出的**目标文件 —— 于是这一步的字节对账不必等代码生成对齐。
     * 32 位（i386 / arm）的 ELF32 一样认，位宽从输入里看（第七十二片）。
     *   omni elf-r a.o b.o -o m.o [--rdata .rdata] [--unwind] */
    case 'elf-r': {
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : 'a.o';
      const ri = rest.indexOf('--rdata');
      /* `readBinary` 回的是 latin1 的串（宿主那一层就这么定的），读节头要按字节看。 */
      const bytesOf = (p) => {
        const s = readBinary(p);
        const b = new Uint8Array(s.length);
        for (let k = 0; k < s.length; k++) b[k] = s.charCodeAt(k);
        return b;
      };
      writeBinary(out, mergeElfObjects(files.map(bytesOf), {
        rdata: ri >= 0 ? rest[ri + 1] : '.data.ro',
        unwind: rest.includes('--unwind'),
      }));
      stdout(`${out}\n`);
      return 0;
    }
    /* `pe-link`：几个 `.o` 链成一份 `.exe`（第九刀第四十七到五十片）。库从 `-L` 那几个
     * 目录里找：`<目标>-libtcc1.a` 与 `msvcrt.def` / `kernel32.def`。
     * `--shared` 造 DLL（第六十四片）：映像基址、`subsystem`、`Characteristics` 都换，
     * thunk 节里多一张导出表，入口是 `_dllstart`。
     * 第六十六片那几个开关：`--subsystem`（名字或数字）、`--image-base`（十六进制）、
     * `--stack`（十进制）、`--section-align` / `--file-align`（十六进制）、`-e` 换入口。
     * 命令行上的文件按内容认：只有一节且那一节叫 `.rsrc` 的是资源（第六十八片），
     * 开头是 `MZ` 的是真的 `.dll`（第六十七片），剩下的才是目标文件。
     * `-g` 把 `.stab` / `.stabstr` 带进来，`-gdwarf` 换成 dwarf 那十来节；两种都在文件
     * 末尾接一张 COFF 符号表（第六十九、七十片）。
     * 导出表不看是不是 DLL —— `.exe` 里的 `__declspec(dllexport)` 一样进表，而且只要
     * 表非空就顺手往 `<输出>.def` 写一份清单（第七十一片）。
     *   omni pe-link a.o [a.res] [foo.dll] -o a.exe -L dir [-L dir …]
     *                 [--target x86_64-win32] [--shared] [-g | -gdwarf]
     *                 [--subsystem gui] [--image-base 1000000] [--stack 2097152]
     *                 [--section-align 2000] [--file-align 1000] [-e main] */
    case 'pe-link': {
      const shared = rest.includes('--shared');
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : (shared ? 'a.dll' : 'a.exe');
      const ti = rest.indexOf('--target');
      const target = ti >= 0 ? rest[ti + 1] : 'x86_64-win32';
      const valOf = (n) => { const i = rest.indexOf(n); return i < 0 ? undefined : rest[i + 1]; };
      const hex = (n) => { const v = valOf(n); return v === undefined ? undefined : parseInt(v, 16); };
      /* `pe_setsubsy` 那张表。 */
      const SUBSY = new Map([['native', 1], ['gui', 2], ['windows', 2], ['console', 3],
        ['posix', 7], ['efiapp', 10], ['efiboot', 11], ['efiruntime', 12], ['efirom', 13]]);
      const sub = valOf('--subsystem');
      const subsystem = sub === undefined ? undefined
        : (SUBSY.get(sub) ?? parseInt(sub, 10));
      const stackArg = valOf('--stack');
      /* `-g` 是 stabs，`-gdwarf` / `-gdwarf-N` 是 dwarf（默认 5）。 */
      const gdwarf = rest.find((a) => a.startsWith('-gdwarf'));
      const dwarf = gdwarf === undefined ? 0
        : (parseInt(gdwarf.slice(8), 10) || 5);
      const opt = {
        dll: shared,
        subsystem,
        imagebase: hex('--image-base'),
        sectionAlign: hex('--section-align'),
        fileAlign: hex('--file-align'),
        stack: stackArg === undefined ? undefined : parseInt(stackArg, 10),
        entry: valOf('-e'),
        debug: rest.includes('-g') || gdwarf !== undefined,
        dwarf,
      };
      const bytesOf = (p) => {
        const s = readBinary(p);
        const b = new Uint8Array(s.length);
        for (let k = 0; k < s.length; k++) b[k] = s.charCodeAt(k);
        return b;
      };
      const libDirs = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-L') { libDirs.push(rest[i + 1]); i++; continue; }
        if (rest[i].startsWith('-L')) libDirs.push(rest[i].slice(2));
      }
      const open = (names) => {
        for (const d of libDirs) {
          for (const n of names) {
            const p = join(d, n);
            if (exists(p)) return { path: p, bytes: bytesOf(p) };
          }
        }
        return null;
      };
      const objs = files.map(bytesOf);
      const loaded = peLoad({
        objs: files.map((p, i) => ({ path: p, bytes: objs[i] })),
        libtcc1: `${target}-libtcc1.a`,
        open,
        ...opt,
      });
      const r = peWrite({
        objs: [...loaded.objs, ...loaded.members.map((m) => m.bytes)],
        dlls: loaded.dlls,
        res: loaded.res,
        startName: loaded.entryName,
        declare: [{ name: loaded.start, after: loaded.objs.length }],
        gui: loaded.peType === PE_GUI,
        outName: out,
        ...opt,
      });
      writeBinary(out, r.bytes);
      /* 有导出的符号时 tcc 还顺手写一份 `<输出>.def`（`pe_build_exports` 里那段 `#if 1`）。 */
      if (r.def !== undefined) writeText(r.def.path, r.def.text);
      stdout(`${out} (${r.bytes.length} 字节，${r.infos.length} 节，${r.nthunks} 个导入桩)\n`);
      return 0;
    }
    /* `elf-link`：几个 `.o` 链成一份 Linux 可执行文件（第九刀第五十三、五十四片）。
     * 默认动态（跟 tcc 一样，`.interp` / `.dynsym` / `.dynamic` 那一套都摆出来），
     * `--static` 只摆装载得下的那几条，`--shared` 造共享库（第五十九片），
     * `--dll` 接一份真的共享库（第六十片），`--pie` 位置无关、`--rdynamic` 全导出、
     * `--soname` / `--rpath` 是 `.dynamic` 里那两条（第六十二片）。没有 libc，入口自己指：
     *   omni elf-link a.o [b.o …] -o a.out [-e main] [--static] [--shared]
     *                  [--dll libfoo.so] [--pie] [--rdynamic]
     *                  [--soname libfoo.so.1] [--rpath /opt/lib] [--enable-new-dtags] */
    case 'elf-link': {
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : 'a.out';
      const ei = rest.indexOf('-e');
      const entryName = ei >= 0 ? rest[ei + 1] : 'main';
      const valOf = (flag) => {
        const i = rest.indexOf(flag);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const bytesOf = (p) => {
        const s = readBinary(p);
        const b = new Uint8Array(s.length);
        for (let k = 0; k < s.length; k++) b[k] = s.charCodeAt(k);
        return b;
      };
      const dlls = [];
      for (let k = 0; k < rest.length - 1; k++) {
        if (rest[k] === '--dll') dlls.push({ bytes: bytesOf(rest[k + 1]), name: rest[k + 1] });
      }
      const r = elfExe({
        objs: files.map(bytesOf),
        entryName,
        static: rest.includes('--static'),
        shared: rest.includes('--shared'),
        pie: rest.includes('--pie'),
        rdynamic: rest.includes('--rdynamic'),
        soname: valOf('--soname'),
        rpath: valOf('--rpath'),
        newDtags: rest.includes('--enable-new-dtags'),
        dlls,
      });
      writeBinary(out, r.bytes);
      stdout(`${out} (${r.bytes.length} 字节，${r.shnum} 节，${r.phnum} 段，`
        + `入口 0x${r.entry.toString(16)})\n`);
      return 0;
    }
    /* `macho-link`：几个 `.o` 链成一份 macOS 可执行文件（第九刀第五十五、五十六片），
     * `--shared` 出一份 dylib（第六十三片）。接 libc 一句 `-lc` 就够（第九十八片，
     * 自己按 tcc 的规矩去 SDK 的 `usr/lib` 里找），也可以把文件明着给：
     *   omni macho-link a.o [b.o …] -o a.out [-e _main]
     *                   [-lc] [-L 目录] [--dylib <sdk>/usr/lib/libc.tbd]
     *                   [--libtcc1 libtcc1.a]
     *                   [--shared] [--install-name libfoo.dylib] [--rpath @loader_path]
     *                   [-g [--dwarf 2]]
     * 写出来的还没签名 —— arm64 上要自己补一句 `codesign -f -s - <文件>`，
     * tcc 也是这么干的（CONFIG_CODESIGN 只在本机那个目标上开）。 */
    case 'macho-link': {
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : 'a.out';
      const ei = rest.indexOf('-e');
      const entryName = ei >= 0 ? rest[ei + 1] : '_main';
      const bytesOf = (p) => {
        const s = readBinary(p);
        const b = new Uint8Array(s.length);
        for (let k = 0; k < s.length; k++) b[k] = s.charCodeAt(k);
        return b;
      };
      const dylibs = [];
      const archives = [];
      /* `--dylib` 认字：Mach-O（或胖二进制）就当真的库读（`macho_load_dll`），
       * 别的当 `.tbd` 文本（`macho_load_tbd`）。tcc 也是看头四个字节分派的。 */
      const takeLib = (p) => {
        const b = bytesOf(p);
        if (p.endsWith('.a')) archives.push(b);
        else dylibs.push(isMachoBinary(b) ? { name: p, bytes: b } : readText(p));
      };
      for (let k = 0; k < rest.length - 1; k++) {
        if (rest[k] === '--dylib') takeLib(rest[k + 1]);
      }
      const li = rest.indexOf('--libtcc1');
      if (li >= 0) archives.push(bytesOf(rest[li + 1]));
      /* `-l` 找库（第九十八片）：路径是 `-L` 给的那些在前，然后 `/usr/lib`
       * （tcc 的 `CONFIG_TCC_LIBPATHS` 在非 PE 上是 `{B}:<sysroot>/usr/lib`），
       * 最后是 SDK 里那份 `usr/lib`（`tcc_add_macos_sdkpath`，`tccmacho.c:2267`）——
       * 现在的 macOS 上 `libc.tbd` 只在最后那一处。
       *
       * 名字往文件的三种拼法照 `tcc_add_library`（`libtcc.c:1301-1332`）：
       * MACHO 上是 `lib%s.dylib`、`lib%s.tbd`、`lib%s.a`，**外层循环是拼法**
       * （先拿所有路径试 `.dylib`，再全试一遍 `.tbd`），`:name` 是「就照这个名字找，
       * 不加前缀后缀」。一个都没找到再拿名字本身当文件试一次，还是没有就报错。 */
      const libPaths = [];
      for (let k = 0; k < rest.length - 1; k++) {
        if (rest[k] === '-L') libPaths.push(rest[k + 1]);
        else if (rest[k].startsWith('-L') && rest[k].length > 2) libPaths.push(rest[k].slice(2));
      }
      libPaths.push('/usr/lib');
      const sdkLib = sdkUsrLib();
      if (sdkLib !== null) libPaths.push(sdkLib);
      const findLib = (name) => {
        const fmts = name.startsWith(':')
          ? [(d, n) => join(d, n)]
          : [(d, n) => join(d, `lib${n}.dylib`), (d, n) => join(d, `lib${n}.tbd`),
            (d, n) => join(d, `lib${n}.a`)];
        const bare = name.startsWith(':') ? name.slice(1) : name;
        for (const f of fmts) {
          for (const d of libPaths) {
            const p = f(d, bare);
            if (exists(p)) return p;
          }
        }
        for (const d of libPaths) {
          const p = join(d, bare);
          if (exists(p)) return p;
        }
        return null;
      };
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        let name = null;
        if (a === '-l' && k + 1 < rest.length) name = rest[k + 1];
        else if (a.startsWith('-l') && a.length > 2) name = a.slice(2);
        if (name === null) continue;
        const p = findLib(name);
        if (p === null) throw new OmniError(`library '${name}' not found`);
        takeLib(p);
      }
      const ni = rest.indexOf('--install-name');
      /* `--rpath` 可以给多次，攒成一串冒号隔开的（tcc 的 `tcc_concat_str(..., ':')`）。 */
      const rp = [];
      for (let k = 0; k < rest.length - 1; k++) {
        if (rest[k] === '--rpath') rp.push(rest[k + 1]);
      }
      const dwi = rest.indexOf('--dwarf');
      const r = machoExe({
        objs: files.map(bytesOf),
        entryName,
        dylibs,
        /* `-g`：stabs 那一路（`--dwarf` 没给）或者 dwarf 那一路。 */
        debug: rest.includes('-g'),
        dwarf: dwi >= 0 ? Number(rest[dwi + 1]) : 0,
        rpath: rp.length === 0 ? undefined : rp.join(':'),
        openDylib: (n) => (exists(n) ? bytesOf(n) : null),
        archives,
        shared: rest.includes('--shared'),
        outName: out,
        installName: ni >= 0 ? rest[ni + 1] : undefined,
      });
      writeBinary(out, r.bytes);
      stdout(`${out} (${r.bytes.length} 字节，${r.ncmds} 条加载命令，${r.nsects} 节，`
        + `入口偏移 0x${r.entryoff.toString(16)}`
        + `${r.members.length === 0 ? '' : `，拉了 ${r.members.length} 个库成员`})\n`);
      return 0;
    }
    // 一个源文件一份产物（第七十五刀）：`<名字>.sx` 与 `<名字>.js` 摊在一个目录里，

    // 名字就是源文件自己的名字。`-o 目录` 指定去处，默认 .omni-cache/asy-mods。
    // 加 `--run` 就直接跑（node 自己按 ESM 的模块图把它们串起来）。
    case 'asy-units': {
      const oi = rest.indexOf('-o');
      const dir = oi >= 0 ? rest[oi + 1] : asyModsDir();
      stdout(`${asyModsBuild(path, dir)}\n`);
      return 0;
    }
    case 'oir': {
      const { mod } = compile(path, rest);
      stdout(JSON.stringify(mod, replacer, 2) + '\n');
      return 0;
    }
    // MIR（ADR-0014 决策 6）：OIR 之下那一层 —— 线性定长记录、显式类型、结构化控制流。
    // 印的是文本形式，它的身份是快照比对对象；要持久化或哈希用字节形式（mir/bytes.js）。
    case 'mir': {
      const { mod } = compile(path, rest);
      const mir = lowerToMir(mod);
      let insns = 0;
      for (const f of mir.funcs) insns += f.count();
      vStep(`OIR -> MIR  ${mir.funcs.length} funcs, ${insns} insns, ${mir.consts.items.length} consts`);
      // 良构检查**默认开着**，不是可选的调试开关：MIR 的下游有四个后端，一条破了
      // 不变量的指令在四处会各自表现成不同的错答案（理由见 mir/verify.js 文件头）。
      const errs = verifyMir(mir);
      if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
      vStep('mir verify  ok');
      // --bytes：印字节形式的摘要与每个函数的内容哈希（增量编译的缓存键，决策 5）
      stdout(rest.includes('--bytes') ? dumpBytes(mir) : printMir(mir));
      return 0;
    }
    // 增量编译（ADR-0014 决策 5）：函数级单元 + 内容哈希 + 内容寻址的产物缓存。
    // 印的是命中/未命中计数 —— 门槛 4 要的是计数断言，不是计时。
    case 'incr': {
      const { mod } = compile(path, rest);
      const mir = lowerToMir(mod);
      const ci = rest.indexOf('--cache');
      const dir = ci >= 0 ? rest[ci + 1] : join(cacheRoot(), 'incr');
      const byName = new Map();
      for (const f of mod.funcs) byName.set(f.mangled, f);
      const cache = new IncrCache(dir);
      const res = compileIncremental(mir, 'js', cache, (name) => emitJsFunc(mod, byName.get(name)));
      vStep(`incr  ${res.units.length} units, ${res.hits} hit, ${res.misses} miss  cache ${dir}`);
      stdout(incrReport(res, rest.includes('--list')));
      return 0;
    }
    // ---- GLR（ADR-0014 决策 2）。语法是数据，这两条命令读的都是 .grammar 文件。
    // 它们摆在 CLI 上不只是为了调试：自举链要能让**原生编译器自己**跑一遍这条路，
    // 那是唯一能抓住封闭 ABI 违规的门槛（详见 tests/bootstrap/run.js 阶段 8）。
    // asy 前端的中间形态：印出核心方言，`omni run x.asy` 吃的就是它（ADR-0014 第 2 道门槛）
    case 'emit-asy': {
      stdout(asyText(path));
      return 0;
    }
    case 'glr-table': {
      stdout(dumpTable(loadGrammar(path), rest.includes('--brief')));
      return 0;
    }
    case 'glr': {
      const srcs = files.slice(1);
      if (srcs.length === 0) throw new OmniError('glr needs a grammar file and at least one input file');
      for (const s of srcs) if (!exists(s)) throw new OmniError(`no such file: ${s}`);
      const tb = loadGrammar(path);
      if (tb.grammar.lex === null) {
        throw new OmniError(`grammar '${tb.grammar.name}' has no (lex ...) form, so it cannot read source text`);
      }
      // 收多个输入是刻意的：真实语言的表有几百个状态，建一次要一两秒，而测试轴有上百条
      // case。一条命令喂一批输入，表就只建一次。只给一个文件时输出与从前逐字节相同 ——
      // 自举链阶段 9 对的是那一份。
      // `--count` 只印一行摘要，不印树。为的是**整份真实语料**：84 个 asy 模块的树印出来是
      // 133 MB，光排版就吃掉大半时间，而覆盖率那道门槛要的只是"每份都出、且只出一棵树"。
      // 节点数是那棵树的廉价指纹 —— 分析结果变了它基本一定跟着变。
      const countOnly = rest.includes('--count');
      for (const src of srcs) {
        const diags = new Diagnostics();
        const toks = lexText(tb.grammar.lex, new SourceFile(src, readText(src)), diags);
        diags.throwIfErrors();
        vStep(`lexer          ${src} -> ${toks.length} tokens`);
        const tree = glrParse(tb, toks, diags);
        diags.throwIfErrors();
        if (tree === null) throw new OmniError('glr: the parse failed without a diagnostic — that is a bug');
        if (countOnly) { stdout(`${src}  ${toks.length} tokens, ${countNodes(tree)} nodes\n`); continue; }
        if (srcs.length > 1) stdout(`;; ==== ${src}\n`);
        stdout(printSexpr([tree]));
      }
      return 0;
    }
    default:
      throw new OmniError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

/** 一棵 s-expr 的节点数。`glr --count` 的指纹，刻意只数节点：够灵敏，又不依赖排版。 */
function countNodes(n) {
  if (n === null || n === undefined) return 0;
  if (n.kind !== 'list') return 1;
  let sum = 1;
  for (const x of n.items) sum += countNodes(x);
  return sum;
}

/**
 * 读一份语法文件并构表。诊断在这里就抛掉 —— 语法写错了不该拖到分析期。
 *
 * **构表结果按内容寻址缓存**：量过 asy 那份语法的构表要 780ms（433 个状态，全在项集族
 * 那一遍），而这条路是「一条 case 一个进程」——tests/asy 一轴上百次进程，不缓存就是白烧
 * 几分钟。键 = 语法文本 + 格式版本，所以改语法、改序列化形状都自动失效；缓存里只有状态表
 * 与冲突清单，产生式表与 FIRST/FOLLOW 每次现算（5ms，见 table.js 的 augment）。
 * 写法是"先写临时文件再 rename"：几条腿并行跑时不会读到半截文件。
 */
function loadGrammar(path) {
  const diags = new Diagnostics();
  const text = readText(path);
  const g = readGrammar(readSexpr(new SourceFile(path, text), diags), diags);
  diags.throwIfErrors();
  const dir = join(cacheRoot(), 'glr', hash16(`${TABLE_FORMAT}|${text}`));
  const cpath = join(dir, 'table.txt');
  if (exists(cpath)) {
    const hit = tableFromText(readText(cpath), g);
    if (hit !== null) {
      vStep(`grammar ${g.name}  ${hit.states.length} states, cache hit ${cpath}`);
      return hit;
    }
  }
  const tb = buildTable(g);
  vStep(`grammar ${g.name}  ${tb.states.length} states, ${tb.conflicts.length} conflicts left to GLR`);
  mkdirAll(dir);
  const tmp = join(workDirFor('glr-w', hash16(path)), 'table.txt');
  writeText(tmp, tableText(tb));
  rename(tmp, cpath);
  vStep(`grammar ${g.name}  table cached at ${cpath}`);
  return tb;
}

/** span 里有 SourceFile 循环引用，BigInt 也不能直接序列化 */
function replacer(key, value) {

  if (key === 'span' || key === 'nameSpan' || key === 'ast' || key === 'defAst') return undefined;
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

const USAGE = `omni — stage0 bootstrap compiler

usage: omni <command> <file.omni>

commands:
  repl      interactive session (no file; defaults to --mode dynamic; --lang omni|sx|asy|js)
            --engine interp|js  which runtime runs each batch (both incremental)
  run       parse and execute (node host: in-process JS; native build: via the C path)
  run-c     compile to C, build with cc, execute
  build     compile to a native executable  (-o NAME; --work DIR keeps the generated C there)
  emit-js   print generated JavaScript
  emit-c    print generated C  (--amalgamate: inline the whole runtime into one file)
  emit-llvm print generated LLVM IR (ADR-0014 decision 3; scalars only so far)
  run-llvm  compile through LLVM IR with clang and execute
  build-llvm  same, but keep the executable  (-o NAME; --work DIR keeps the .ll)
  run-jit   compile through LLVM IR and execute it with the ORC JIT (no cc at run time)
  emit-spirv print SPIR-V assembly for one kernel (ADR-0014 gate 7; --kernel NAME)
  ast       print the AST as JSON
  sx        print the core-dialect text an .asy file lowers to (the *.asy.sx that
            core-dialect diagnostics cite; line numbers line up exactly)
  cpp       preprocess a .c file (ADR-0017 cut 5). The output is byte-identical to
            tcc -E -P; that equality is the test axis (tests/c/). Takes -I and -D.
  c-mir     compile a .c file straight to MIR (ADR-0017 cut 6, path B: the tccgen
            equivalent -- one pass, no AST). Takes -I and -D.
  c-run     the same, then run it. The exit status is C main's return value, so
            tcc -run is the oracle (tests/c/gen/). Takes -I and -D; whatever
            follows -- becomes the program's own argv (argv[0] is the .c path).
  c-obj     compile a .c file to a real object file (ADR-0017 cut 9: native, no linear
            memory). -o NAME, --arch arm64|x86_64. Link it yourself: clang a.o -o a
  elf-r     merge several ELF object files into one, i.e. tcc -r (ADR-0017 cut 9 slice
            42). -o NAME, --rdata NAME (PE calls it .rdata), --unwind (.eh_frame)
  pe-link   link .o files into a Windows .exe (ADR-0017 cut 9 slices 47-50): reads
            libtcc1.a on demand and the .def import libraries from -L DIR, builds the
            import table and thunks, applies every relocation. -o NAME,
            --target x86_64-win32|arm64-win32|i386-win32|arm-wince, --shared (a .dll),
            --subsystem NAME, --image-base HEX, --stack N, --section-align HEX,
            --file-align HEX, -e NAME (slice 66). Inputs are told apart by content:
            a one-section COFF named .rsrc is a resource file (slice 68), one starting
            with MZ is a real .dll (slice 67). -g keeps .stab/.stabstr, -gdwarf keeps the
            dwarf sections; both append a COFF symbol table (slices 69-70)
  elf-link  link .o files into a Linux executable (ADR-0017 cut 9 slices 53-54):
            dynamic by default like tcc (.interp/.dynsym/.dynamic/.got), --static for
            the plain one, --shared for a shared library (slice 59), --dll libfoo.so to
            link against one (slice 60). --pie, --rdynamic, --soname NAME,
            --rpath PATH, --enable-new-dtags (slice 62). No libc, so give the entry
            with -e NAME (default main). -o NAME
  macho-link
            link .o files into a macOS executable (ADR-0017 cut 9 slices 55-56): segments,
            chained fixups, export trie. -lc finds libc.tbd itself (-L DIR adds a
            search path; slice 98), or give --dylib <sdk>/usr/lib/libc.tbd and
            --libtcc1 libtcc1.a explicitly. --shared makes a dylib
            (slice 63), --install-name NAME sets LC_ID_DYLIB. The output is unsigned -
            run codesign -f -s - on it. -o NAME, -e NAME (default _main)
  oir       print the OIR as JSON
  mir       print the MIR (ADR-0014 decision 6): SSA values + slots + structured
            control flow, one 8-byte record per instruction (--bytes: sizes and
            per-function content hashes instead of the listing)
  incr      compile function by function through the content-addressed cache
            (ADR-0014 decision 5) and print hit/miss counts
            (--cache DIR, default .omni-cache/incr; --list: one line per unit)
  glr-table print the parsing table for a .grammar file (ADR-0014 decision 2)
            (--brief: rules and remaining conflicts only, no per-state dump)
  glr       parse a source file with a .grammar and print the resulting s-expr
            (usage: omni glr FILE.grammar FILE...; 多个输入只建一次表)
            (--count: one summary line per input instead of the tree)
  bootstrap build the whole chain into a tree and check the four fixpoints
            (no file = the compiler itself; -o DIR, default ./dist; -q skips the C path)

flags:
  -v, --verbose  trace every internal step to stderr with its wall-clock time
                 (front end, check, backend, runtime .o cache, cc, exec)
  -I <dir>       .jnc and .c: a directory to look in for an import / #include, tried
                 after the importing file's own directory. Repeatable; tried in the
                 given order. Same meaning as jancy's and tcc's own -I.
  -D name[=body] cpp only: predefine a macro, same spelling as tcc's -D.

type modes (ADR-0008) — chosen by extension, overridable with --mode:
  .omni     mixed   omitted type is inferred from the initializer, else dynamic
  .omnid    dynamic omitted type is always dynamic
  .omnis    static  omitted type is inferred; implicit dynamic is an error

other front ends — chosen by extension, no --mode:
  .js       the JS subset (ADR-0011), the language the compiler itself is written in
  .wat      WebAssembly text format, a subset (ADR-0014); see frontend-wat/lower.js

a .js entry goes through the JS front end instead (ADR-0011): the import tree is
linked into one program and lowered to OIR. That is how omni compiles itself.

env:
  OMNI_CC   C compiler to use (default: first of tcc, clang, gcc, cc)
  OMNI_CLANG  compiler for the llvm path (.ll input; default: clang)
  OMNI_LLVM_CONFIG  llvm-config used to locate LLVM headers/libs for run-jit
`;

try {
  setExitCode(main(procArgs()));
} catch (e) {
  if (e instanceof OmniError) {
    stderr(e.message + '\n');
    setExitCode(1);
  } else throw e;
}
