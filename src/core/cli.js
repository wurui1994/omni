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
  args as procArgs, env, setEnv, stdout, stderr, setExitCode, spawn, evalJs, hasJsEngine, nowMs,
  maxRssBytes,
  cwd, installDir, isDir, writeBinary, readBinary, runTimeout, pluginLoad, pluginsOk,
} from './host/native.js';
import { join, basename, dirname, isAbsolute, resolve } from './host/path.js';
import { installSrcEvalHook } from './host/src_eval.js';
import { cacheRoot, scratchDir, dropScratch, cacheList, cacheGc } from './host/cache.js';
import { dataPath, dataDir } from './host/data.js';
import { hash16 } from './host/hash.js';
import { findCmd, splitArgv, canonicalize, ownsVerbose, renderHelp, renderLegacy } from './cli/tree.js';
import { ROOT, LEGACY } from './cli/cmds.js';
import { renderPlan, renderSummary, renderStage } from './cli/stages.js';
import { planForC } from './cli/plan-c.js';
import { planForOmni } from './cli/plan-omni.js';
import { tccTranslate } from './cli/cmd-tcc.js';
import {
  foldedToSvg, cpuProfileToFolded, heapProfileToFolded, foldedTable, foldedSummary, foldedPaths,
  foldedTree, foldedEdges, foldedDiff,
} from './cli/flame.js';
import { statModel, statTable, statDot, statJson } from './cli/statgraph.js';
import { layerModel, layerTable, countNodes, stepTable, kindStat, kindTable } from './cli/layers.js';
import { linkJs } from './frontend-js/link.js';
import { lowerJs } from './frontend-js/lower.js';import { lowerWat } from './frontend-wat/lower.js';
import { genArm64Module as genArm64 } from './arm64/from_mir.js';
import { genModule as genX64 } from './x64/from_mir.js';
import { writeObject } from './link/macho.js';
import { writeElfObject } from './link/elf.js';
import { mergeObjects as mergeElfObjects } from './link/elf_merge.js';
import { peLoad, PE_GUI } from './link/pe_load.js';
import { peWrite } from './link/pe_link.js';
import { elfExe } from './link/elf_exe.js';
import { parseLdScript } from './link/ldscript.js';
import { isDefSyms } from './link/defsyms.js';
import { machoExe, isMachoBinary } from './link/macho_exe.js';
import { lowerToMir } from './mir/from_oir.js';
import { printMir } from './mir/print.js';
import { verifyMir } from './mir/verify.js';
import { dumpBytes } from './mir/bytes.js';
import { IncrCache, compileIncremental, incrReport } from './incr/cache.js';
import { Diagnostics, OmniError, SourceFile } from './source/diag.js';
/* `--engine graph`（那十门语言 -> 节点图 -> 契约五问）。**静态 import 是有代价的**：
 * 它把十份 tograph.js（`ext/<lang>/tograph.js`）一起拽进核心，与"薄核心 + plugins"
 * 那条路是反着的。现在这么写是因为那十份都是纯 JS、小、且没有别的依赖；哪天核心大小
 * 要紧了，正解是把 graph 这台机器登记成一格 lang / plugin（`lang/builtin.js` 那一套），
 * 不是在这儿加一句 `await import`（这份文件里 44 个 import 全是静态的，只有一套规矩）。 */
import { runGraphFile, buildGraphFile, coreSxText, borrowedExts } from './graph/run.js';
/* 构建引擎（`omni ninja`）：依赖图 + 脏判定 + 调度，不认识语言 —— 设计见
 * `docs/design/build-system.md`，模型照 ninja 复刻。 */
import { ninjaCmd } from './build/cli.js';
import { check } from './hir/check.js';
import { pruneFuncs } from './hir/prune.js';
import { cAbiLibs, cSysLib } from './hir/c_abi.js';
import { cffiNeeded, cffiSource } from './backend-js/cffi.js';
import { flatImage } from './link/flat_image.js';
import { dlopenAddon, publishCffi, hasAddonLoader } from './host/ffi_host.js';
import {
  target, registerTarget, registerLang, lang, registerRunner, runner, noteUnloadable,
  registerCap, cap, langNames, langByName, declareProvider,
} from './plugin.js';
/* 已经搬成独立模块的语言（ADR-0021 S4）：它们不 import 这一份，所以能独立编译。
 * 内建就是"核心自己调一次 register"，外挂是"dlopen 之后 omni_plugin_init 调同一个 register"
 * —— 两条路在注册表那一层看不出区别。 */
import { registerBuiltins } from './lang/builtin.js';
import { builtinAlt } from './lang/builtin-pick.js';
import { PLUGIN_SET, pluginRegName, CORE_DATA } from './plugin-set.js';
import { RUNTIME_DIR, JIT_DIR, GL_DIR, SCHED_DIR, runtimeSources } from './runtime/c_runtime.js';
import { loadProgram, MODE_BY_EXT } from './module/load.js';
import { startRepl } from './repl.js';
import { interpret } from './interp/eval.js';
import { interpretMir, runMirModule } from './mir/interp.js';
import { emitMirJs } from './mir/emit_js.js';
import { runMirJs } from './mir/js_rt.js';
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
 *
 * `--tcc-lib-dir DIR` 是 tcc 的 `-B` 那一格（tcc 里叫 `tcc_lib_path`）：它**换掉**
 * 自带那一份，而不是排在它前面。这一格要紧 —— tcc 那边 `{B}/include` 就是它自带的
 * 那一份，给了 `-B` 就没有别的了；我们从前把 `-B` 翻成 `-isystem DIR/include`，
 * 于是 `src/include` 还赖在搜索序的尾巴上，「只有我们有的头」我们找得到而 tcc 找不到。
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
  /* `--sysroot DIR`：系统头指向 `DIR/include`，跳过本机探测（SDK / /usr/include）。
   * 自带那一份（`src/include`）照留 —— `stdarg.h` 一族是编译器自己的，不是系统的。
   * **不走 `cSysInclude()`**：那个函数会把 macOS SDK 与 `/usr/include` 都带进来，
   * 而交叉编译的时候本机的那些头正是要**换掉**的。 */
  const si = argv.indexOf('--sysroot');
  if (si >= 0) {
    if (argv[si + 1] === undefined) throw new OmniError('--sysroot 后面要一个目录');
    /* 自带的那一份只有一条 —— `C_INCLUDE_DIR`（`src/include`），里头是
     * `stdarg.h`/`stddef.h`/`stdbool.h`/`float.h`，编译器自己的。 */
    out.push(cap('c.sysInclude')()[0]);  // C_INCLUDE_DIR（src/include）
    out.push(join(argv[si + 1], 'include'));
    return out;
  }
  const bi = argv.indexOf('--tcc-lib-dir');
  if (bi >= 0 && argv[bi + 1] === undefined) throw new OmniError('--tcc-lib-dir 后面要一个目录');
  if (!argv.includes('-nostdinc')) out.push(...cap('c.sysInclude')(bi >= 0 ? argv[bi + 1] : undefined));
  return out;
}

/**
 * 预定义宏要的那个目标：`--arch` / `--os` 给了就听，不给按**这台机器**。
 *
 * 谁要它：`c.toMir`（线性内存那条解释器腿）。它读的是这台机器**真的**系统头，而头文件
 * 按 `__x86_64__` / `__linux__` 分支 —— 从前那条腿的预定义写死 arm64-osx，
 * x86_64 Linux 上于是报 `gnu/stubs.h:7: include file 'gnu/stubs-32.h' not found`。
 * 那条腿的 **ABI** 仍是虚拟目标（`lowerC` 自己钉），这一格只管宏。
 */
function cTgt(argv) {
  const ai = argv.indexOf('--arch');
  const si = argv.indexOf('--os');
  return { arch: ai >= 0 ? argv[ai + 1] : hostArch(), os: si >= 0 ? argv[si + 1] : hostOs() };
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
 * 7 号往后那几节**造出来的次序**上的位置（第九刀第一百一十八片）。
 *
 * tcc 那边这几节不排序，谁先造谁在前，而「什么时候造」是编译走到哪儿决定的。
 * 把三件事都换算到「第几个函数」这一把尺子上：
 *
 *   `.rela.data` —— 第一条数据重定位落在第 k 个函数之前 → `k`
 *   `.rela.text` —— 第一条代码重定位在第 j 个函数的**体里**发 → `j + 0.5`
 *   `.pdata`     —— 第 0 个函数**收尾**时造 → `0.8`（比它的体晚、比下一个函数早）
 *
 * 量过的三种源码次序都对得上：初值在函数之前 → `.rela.data` 最前；在两个函数之间 →
 * 夹在 `.pdata` 与后面那个函数的 `.rela.text` 之间；第一个函数里就有调用 →
 * `.rela.text` 最前。
 */
/** 一串数里最小的那个。
 *
 * 为什么不写 `Math.min(...xs)`：封闭 ABI 的 op 是**定长**的，展开表达不了（决策 2），
 * 所以这一格自己摊成循环。空串回 `Infinity`，与 `Math.min()` 一致。 */
function minOfNums(xs) {
  let m = Infinity;
  for (const v of xs) if (v < m) m = v;
  return m;
}

function relaSeq(blob) {
  const seq = {};
  /* 「第几个函数」这根轴上只数**出过代码**的函数（第一百二十八片）：没有函数体的那些
   * 落点记 −1，一个字节也不占，也不进 `.eh_frame`/`.pdata`。而 `after` 数的是初值落下
   * 那一刻 `funcs` 有多长（里头可能有后来发现没函数体的），所以要折一下。 */
  const nf = blob.offsets.length;
  const emitted = [0];
  for (let k = 0; k < nf; k++) emitted.push(emitted[k] + (blob.offsets[k] >= 0 ? 1 : 0));
  const fold = (n) => emitted[Math.max(0, Math.min(n, nf))];
  if (blob.dataRelocs.length > 0) {
    seq.data = fold(minOfNums(blob.dataRelocs.map((r) => r.after ?? 0)));
  }
  /* `.rela.data.ro` 同一把尺子（第一百二十二片）：只读那一段里第一条重定位落在
   * 第几个函数之前。与 `.rela.data` 撞在同一格时，只读那一节的号大，排后面。 */
  if (blob.roRelocs !== undefined && blob.roRelocs.length > 0) {
    seq.rodata = fold(minOfNums(blob.roRelocs.map((r) => r.after ?? 0))) + 0.01;
  }
  if (blob.relocs.length > 0) {
    const at = minOfNums(blob.relocs.map((r) => r.at));
    const starts = blob.offsets.filter((o) => o >= 0);
    let j = 0;
    while (j + 1 < starts.length && starts[j + 1] <= at) j++;
    seq.text = j + 0.5;
  }
  if (blob.unwind !== null && blob.unwind !== undefined) seq.pdata = 0.8;
  return seq;
}

/**
 * `.eh_frame` 要的那张表（第九刀第一百一十九片）：每个函数在 `.text` 里的
 * `[start, size]`。只有 ELF 这个输出格式带展开表（tcc 的 `unwind_tables` 默认开，
 * 非 ELF 的输出格式又把它关掉），所以只有 linux 目标要 —— osx 走 Mach-O、
 * win32 走 PE，那两边一个 `.eh_frame` 也没有（win32 是 `.pdata`，第一百一十七片）。
 */
function ehFrameOf(blob, arch, os) {
  if (os !== 'linux' || arch !== 'x86_64') return undefined;
  return blob.offsets.map((start, k) => ({ start, size: blob.sizes[k] }));
}

/**
 * `c-obj`：把一个 `.c` 编成一个**真的目标文件**（第九刀第二十六片）。
 *
 * 与 `cMir` 的差别只有一个：走 `lowerCNative` —— 出来的 MIR 没有线性内存，地址就是真
 * 地址，全局与串常量是数据段里的真符号，libc 直接调。生成之后写一个 Mach-O 的
 * `MH_OBJECT`，之后由 `clang`（或我们自己的链接器）与 crt/libc 链起来。
 *
 * `arch` 给 `x86_64` 就在 Apple Silicon 上交叉出 Rosetta 能跑的码，不给按本机。
 *
 * `instr`（最后那一格）= **插桩**：`-finstrument-functions` 的那一对钩子由我们自己那台
 * C 前端插（第一百五十片第三格）。只有一处给 `true` —— `run x.c --profile cc` 那一趟里
 * **用户那一份**；收集器（`omni_prof.c`）与那格 `main` 包装绝不能插（钩子里再触发钩子
 * 就是栈爆，量到的是当场 `Segmentation fault: 11`）。所以这一格是显式的参数、不是一格
 * 全局状态：谁被插过在调用点上看得见。
 */
function cObj(path, out, arch, incs, defs, fmt, os, sysIncs, instr) {
  /* C -> 原生 MIR 那一步按名字要（ADR-0021 的 S4）：读文件、预处理、降级都在 C 那门语言里，
     驱动这一层只管把参数递过去、再把产物写成目标文件。 */
  const { mod, warnings } = cap('c.toMirNative')(path, {
    includeDirs: incs,
    sysIncludeDirs: sysIncs ?? cap('c.sysInclude')(),
    /* 预定义宏里目标 CPU 那三条跟着 `--arch` 走（第一百〇二片）：`__x86_64__` 一变，
     * tinycc 自己的源码就走 x86_64 那一支，不必手工递 `-DTCC_TARGET_X86_64`。
     * 剩下那四十几条跟着 `--os` 走（第一百二十九片），`wchar_t` 的宽度也是（第一百三十片）。 */
    arch: arch === 'x86_64' ? 'x86_64' : 'arm64',
    os,
    instrument: instr === true,
  }, defs);
  for (const w of warnings) stderr(`${w}\n`);
  const errs = verifyMir(mod);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  /* 前三格（读、预处理、降级）报在一起：`lowerCNative` 一趟就把它们做完了，拆不开
   * （ADR-0018 分片 2 后半，见 `vNext` 头上那段）。 */
  vNext('read', 'cpp', 'lower');
  /* win32 的 x86_64 上代码节里还多一份共用的展开信息（第一百一十七片）——
   * 摆在第一个函数之后，所以这一格得在生成代码的时候就给。 */
  const blob = arch === 'x86_64'
    ? genX64(mod, { unwind: fmt === 'elf' && os === 'win32' })
    : genArm64(mod);
  vNext('codegen');
  const syms = [];
  for (let k = 0; k < mod.funcs.length; k++) {
    /* 这个模块里没有函数体（第一百二十八片）：后端一个字节都没出，符号也不发 ——
     * 调用它的那条重定位会把名字带进「未定义的外部符号」那一段。 */
    if (mod.funcs[k].extern) continue;
    /* `local`（第九十二片）：`static` 的函数与外部函数的转发桩不进外部符号表 ——
     * 多份 `.o` 一起链的时候（编 tinycc 自己就是十二份）它们每份都有一个同名的。 */
    syms.push({
      name: mod.funcs[k].name,
      off: blob.offsets[k],
      /* `st_size`（第一百二十片）：函数在 `.text` 里占多长。tcc 记的是「这个函数的
       * 落点到下一个函数的落点」那一段 —— win32 上第一个函数后面那八字节的
       * `UNWIND_INFO` 也算在里头（量过：`f` 的代码 23 字节、`st_size` 32）。 */
      size: blob.sizes[k],
      local: mod.funcs[k].local,
      /* `weak`（第一百〇四片）：`__attribute__((weak))` 的函数在符号表里是弱定义。 */
      weak: mod.funcs[k].weak === true,
      /* `visibility`（第一百〇六片）：ELF 的 `st_other`。 */
      vis: mod.funcs[k].vis ?? 0,
      /* 符号表里排第几（第一百二十六片）：第一次见到这个名字的那一刻。 */
      seq: mod.funcSeq[k],
    });
  }
  /* 函数的别名（第一百〇五片）：与目标同一个偏移 —— 代码一份、符号两条。 */
  for (const a of mod.aliases) {
    if (a.kind !== 'f') continue;
    syms.push({
      name: a.name, off: blob.offsets[a.no], size: blob.sizes[a.no], local: false, weak: a.weak === true,
    });
  }
  /* 两个写出器同一份入参（第三十八片）：Mach-O 那个喂 clang 那条「真的能跑」的腿，
   * ELF 那个喂 tcc 那条「字节相同」的腿 —— tcc 的 `-c` 在**所有**目标上都写 ELF。 */
  const write = fmt === 'elf'
    /* STT_FILE 那一条印的是**命令行上给的那一串**（第一百〇七片量的：`tcc -c s.c` 写
     * `s.c`、`tcc -c ./s.c` 写 `./s.c`、给绝对路径就写绝对路径）—— 不是基名。 */
    ? (t, d, ds, rs, a, al) => writeElfObject(t, d, ds, rs, a, al,
      {
        file: path,
        /* 符号名前缀（第一百二十一片改对）：**只有 osx 加那条下划线**。
         * `libtcc.c:895-898` 里只有 MACHO 那一支开着 `leading_underscore`，PE 那一支
         * 被注释掉了 —— 量过 x86_64-win32 写出来的 `.o`，符号是 `main`/`g`/`tab`，
         * 一个下划线也没有。我们自己的 PE 链接器早就知道这一格（`pe_load.js`：PE 上默认 0）。 */
        prefix: os === 'osx' ? '_' : '',
        rdata: os === 'win32' ? '.rdata' : '.data.ro',
        /* 只读那一段（第一百二十二片）：`const` 的全局量的字节。 */
        rodata: blob.rodata,
        /* `.bss`（第一百三十二片）：没有初始化式的全局量在这一节里，NOBITS —— 只有
         * `sh_size`，文件里不占字节。 */
        bssSize: blob.bssSize,
        /* 三节各自的 `sh_addralign`（第一百三十二片）：里头对齐最大的那一块，下界 8。 */
        secAlign: blob.secAlign,
        unwind: blob.unwind ?? undefined,
        ehFrame: ehFrameOf(blob, arch, os),
        seq: relaSeq(blob),
      })
    /* Mach-O 那一头只有两节，只读那一段与 `.bss` 都折进 `__data` 的尾巴（`macho.js` 的 `foldRo`）。 */
    : (t, d, ds, rs, a, al) => writeObject(t, d, ds, rs, a, al,
      { rodata: blob.rodata, bssSize: blob.bssSize });
  writeBinary(out, write(blob.bytes, blob.data,
    orderSyms([...syms, ...blob.dataSyms]),
    [...blob.relocs, ...blob.dataRelocs, ...blob.roRelocs], arch, blob.dataAlign));
  vNext('write');
  return out;
}

/**
 * 符号表里的次序（第九刀第一百二十六片）：**建符号的次序**。
 *
 * 量过 tcc（`const char *const q="S"; const int c; char *p="P"; static int sv; int gv;`
 * 加一个 `static` 函数与 `main`）：局部那一段是 `L.3 L.4 sv helper`、非局部那一段是
 * `q c p gv main` —— 两段各自就是源码里被提到的次序。tcc 自己不排（`tccelf.c:862` 那段
 * 注释：「TCC cannot sort it while generating the code」），只在写出去之前按绑定分成
 * 局部/非局部两段（`sort_syms`），段里保持原序；分段那一步我们的写出器已经在做。
 *
 * 我们这儿是三堆分开攒的（函数、全局量、串常量），所以要按那个共用的号重排一遍。
 * 没有号的（别的前端、别名）当 `Infinity` —— 稳定排序把它们留在原处。
 */
function orderSyms(defs) {
  return defs.slice().sort((x, y) => (x.seq ?? Infinity) - (y.seq ?? Infinity));
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
/**
 * 嵌套的那几趟 `main`（`buildSelf` 链一次、`tccPrepLink` 先编几份 `.c` …）有多深。
 *
 * 为什么要它：`VERBOSE` / `STATS` / `LANGS_FAT` 与 `vMark` 都是**模块级**的，而 `main`
 * 一进门就按自己那串 argv 把它们重置一遍 —— 于是内层那一趟（argv 里只有 `-q`）
 * 把外层的 `-v` 关掉了，**外层后面的账全丢**。量到的原话（`run -v --backend c`）：
 *
 *   omni: runtime .o  20 objects, cache hit …  [1ms]
 *   196418                       <- 程序自己的输出
 *   （没有 `c link` 那一行，也没有 `exec` 那一行）
 *
 * 也就是说这条腿的**链接与执行两步一直没有耗时**，而 js 那条腿最后一行正是 `exec`。
 * 判据摆在 `tests/cli/verbose.js`。
 */
let MAIN_NEST = 0;
/**
 * 交叉编译那一格（`--sysroot DIR` 加上 `--arch`/`--os`）—— `main` 一进门记下来。
 *
 * 为什么是一格全局状态而不是参数：`omni build x.omni` 那条路上「目标是什么」要一直
 * 传到 `buildSelf` / `runtimeObjectsSelf` / `cObj` 三层里去，而那三层的签名是给
 * **本机**那一趟定的（`hostArch()` 直接就在里头调）。摆成一格状态，交叉编译这件事
 * 只在**一处**读，别处一个字不改 —— 与 `VERBOSE` 同一个手法。
 *
 * `null` = 就是这台机器（绝大多数时候）。
 */
let CROSS = null;
/**
 * 哪一份 libc（`--libc self`，第一百四十片）—— 与 `CROSS` 同一个理由摆成一格状态：
 * `omni build x.omni` 那条路上这件事要传到 `buildSelf` 里的那次 `c link` 上，
 * 而中间三层的签名是给本机那一趟定的。`null` = 系统那一份（绝大多数时候）。
 */
let LIBC = null;
/**
 * 生成的 C 交给谁（`--cc`，第一百四十六片）——与 `CROSS`/`LIBC` 同一个理由摆成一格状态：
 * 这件事要一直传到 `selfCC()` / `findCC()` 两处，而中间几层的签名是给「按环境变量决定」
 * 那一趟定的。
 *
 * **比 `OMNI_CC` 优先**：环境变量说的是「这一整轮都这样」，命令行说的是「这一趟这样」，
 * 后者盖前者是唯一讲得通的次序（`make CC=…` 也是这个规矩）。`null` = 没给，看环境变量；
 * 两处都没给就是 `self`（我们自己那台 C 前端 + 我们自己的链接器）。
 */
let CC = null;
/**
 * `--no-trim`：**不裁**产物里的运行时那一段（js 腿的摇树，见 `backend-js/emit.js` 的
 * `trimJsRuntime`）。摆成一格状态而不是一路传下去，与 `CC` 同一个理由：中间那几层的
 * 签名不带它，而它要落到四个发射点上。
 *
 * 它是**逃生门**，不是调优开关：摇树漏留一个名字的后果是运行期 `xxx is not defined`，
 * 那时候第一件要分清的事就是「是不是这一刀削掉的」—— 一句话切回整份带上。
 */
let NO_TRIM = false;
/**
 * 运行时 profiler（`--profile`，第一百四十七片）—— 与 `CC` 同一个理由摆成一格状态：
 * 这件事要落到三处（发射期插桩、外部 cc 的开关、子进程的环境），而中间几层的签名
 * 都不带它。
 *
 * `null` = 不量。带上时是 `{ mode, hz, out }`，`mode` 三档（理由见 `cmds.js` 的 F_PROFILE）：
 *   `cc`     —— 编译器自己插桩（`-finstrument-functions`）。**默认这一档**：
 *               gcc 与 clang 都有、Linux 与 macOS 都有，比 `-pg`/gprof 跨平台
 *               （Darwin 上 `-pg` 早就不出 `gmon.out` 了）。
 *   `sample` —— 定时器 + `backtrace`（`omni_prof.c`）。开销最低，纯运行期开关。
 *   `stub`   —— 我们自己在发射期插的那一对（`backend-c/emit.js` 的 `profTable`）；
 *               `--cc self` 那一路只有这一档。
 */
let PROF = null;

/**
 * `--profile-out x.svg` 的收尾：把运行时落下的折叠栈摊成火焰图（第一百四十七片）。
 *
 * 为什么分两步：渲染是**字符串计算**，而落折叠栈那一步发生在**被量的那个进程里**
 * （信号处理函数与 atexit 那一层）。让运行时去画 SVG 等于把一份渲染器塞进每个产物；
 * 让 CLI 去画，运行时只管「把数按通用格式吐出来」—— 那格格式（`a;b;c 计数`）本来就是
 * 火焰图、speedscope、gprof2dot 共用的。
 *
 * 折叠栈那份**留着不删**：它比 SVG 有用（能喂别的工具、能 diff 两次采样）。
 */
function profSvgFinish() {
  if (PROF === null || PROF.svg === undefined || PROF.out === null) return;
  if (!exists(PROF.out)) return;                    /* 一帧都没采到（程序太短）：不画空图 */
  const folded = readText(PROF.out);
  const frames = folded.split('\n').filter((l) => l !== '').length;
  let total = 0;
  for (const line of folded.split('\n')) {
    const sp = line.lastIndexOf(' ');
    if (sp > 0) total += Number(line.slice(sp + 1)) || 0;
  }
  writeText(PROF.svg, foldedToSvg(folded, `omni profile —— ${total} 帧 / ${frames} 条栈`));
  stderr(`omni: 火焰图 -> ${PROF.svg}（折叠栈留在 ${PROF.out}）\n`);
}
/* 编出来的核心默认只内建 js -> c，别的语言/目标各自一格 plugins/ 里的插件（ADR-0021 S4）。
   接缝是 linkJs 的 read 回调 —— 编译器读源码全过它，所以"换掉 builtin.js 那一份文本"
   就等于"不把那几门 import 进来"，链接器与摇树都跟着少活。
   `--fat` 是逃生门：把所有语言都编进核心（一份不用装插件的胖二进制）。 */
let LANGS_FAT = false;
let STATS = false;
/**
 * `--stat` / `--stat-out FILE`（第一百四十七片第二格）：构建统计与模块依赖图。
 * **与 `--stats` 是两件事**（那一格是按源文件的产出分布）—— 理由写在 `cmds.js` 的 F_STAT 上。
 * `null` = 不要。
 */
let STAT = null;
/** cgen 回的那份「按源文件的产出分布」—— `--stat` 那张表要它（理由见 buildNative 里那一段）。 */
let LAST_CGEN_STATS = null;
/** 最后一趟发出来的目标文本有多大（`--stat` 那张分层的账要它：最后一层就是它）。 */
let LAST_EMIT_BYTES = 0;
/**
 * 那份目标文本里**按源码长起来的那一段**有多大（固定序言另算）。
 *
 * 为什么要把这两个数分开：`docs/design/node-graph-shrink.md` 第三节钉的那条要求是
 * 「源码 N 行 -> 按源码长起来的那一段 ≤ N 行（**固定序言另算，那一段是常数**）」。
 * 不分开的话，一份 40 行的程序在 js 腿上会报 250 倍 —— 那 250 倍里 99% 是那份
 * 三十万字符的 prelude，与这份源码一个字都没关系。
 */
let LAST_EMIT_PROG = 0;
/**
 * `--stat` 那张「时间去哪儿了」的表：每格 `[步骤, 毫秒, 峰值]`，由 `vStep` 攒。
 *
 * 为什么攒的是**现成的那些步骤**而不是新插一套计时点：那几十处 `vStep` 已经把这条流水线
 * 切成了有名字的段（前端 / check -> OIR / backend c / 外部 cc / 链接 …），再插一套就是
 * 两处会分叉的账。`--stat` 只是把它们从「只有 -v 才印」变成「攒起来算一张表」。
 */
let STEPS = [];
let vMark = 0;
let vRss = 0;

/**
 * **`--profile` 认哪条腿**（第一百四十七片第四格）。三档落在三个不同的**机制**上，
 * 所以它们各只在有那台机制的腿上成立 —— 后端从来不只有 C 一条：
 *
 *   cc      外部编译器自己的插桩（`-finstrument-functions`）—— **只有 C 那条腿**
 *   stub    我们自己在发射期插的那一对 —— **C 与 js 两条**（两边发的都是我们的代码）
 *   sample  运行期采样 —— 现在**只有 C 那条腿**（`ITIMER_PROF` + ucontext）；
 *           js 那条腿要 node 自己那台 V8 采样器（`--cpu-prof` / `node:inspector`），
 *           还没接 —— 这一格有名有姓地报，不假装量过
 *
 * `.c` **输入**（`omni run x.c`）是第四条腿，名字叫 `c-src`：那是**你的** C，但插桩的人
 * 是**我们**（第一百五十片第三格）—— 三档都成立，而且一档都不要外部编译器。给了
 * `--cc clang` 就整趟交给它（`cFileViaCc`），那是同一件事的另一条路。
 *
 * 别的腿（llvm / jit / interp / wasm / graph 那台机器）三档都还没有。**收下开关却一声不响
 * 是最坏的一种**：用户会以为量过了。所以这一格当场报，并把「哪条腿有什么」一起说清。
 */
/**
 * 这一趟被编/被跑的**源文件**是哪个（认腿要它，而它得在动词分派之前就知道）。
 *
 * 用的是与底下那 28 段实现同一台切分器（`splitArgv`）—— 「哪些开关带值」这份知识只有
 * `cli/cmds.js` 一处。自己拿「前一个是不是 `-` 开头」猜过一版，量出来当场就错：
 * `run -v x.c` 里 `x.c` 的前一个是 `-v`（那是**布尔**开关），于是输入认成了空。
 *
 * 切不动（这一趟的开关本来就有问题）就回 `null`：那句话该由后面正经那一趟去报。
 */
function srcArg(node, rest) {
  try {
    const { args } = splitArgv(node, rest, (m) => new OmniError(m));
    return args.length > 0 ? args[0] : null;
  } catch (e) {
    return null;
  }
}

function profLeg(key, path, rest) {
  const val = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : null;
  };
  if (val('--engine') === 'graph') return 'graph';
  /* `--direct`（原样交给 node）是**另一条腿**：那份 js 不经我们的发射器，所以发射期插桩
   * 在它上头不成立，而 node 自己那台采样器成立。 */
  if (rest.includes('--direct')) return 'node';
  const b = val('--backend');
  const isC = typeof path === 'string' && path.endsWith('.c');
  if (isC) {
    /* `.c` 输入是**别人的 C**，不是我们发的 C —— 两条腿要分开（第一百四十七片第六格）：
     * 那份源码不经我们的**发射器**，但它经我们的**前端**，所以三档都在（第一百五十片
     * 第三格）：`cc`/`stub` 是前端插桩，`sample` 是定时器。 */
    if (b === null || b === 'native' || b === 'c') return 'c-src';
    return b;
  }
  if (b !== null) return b === 'native' ? 'c' : b;
  /* 默认腿：`run` 在 node 宿主上是 js（本进程 eval），`build` 是 C（编 + 链出可执行文件）。 */
  return key === 'build' ? 'c' : 'js';
}

/**
 * 那三档各自认的腿（名单就是上面那段注释的机器可读版本）。
 *
 * `c-src` = **`.c` 输入那条腿**（别人的 C）：三档全成立，而且**一档都不要外部 cc**
 * （第一百五十片第三格）—— 插桩那一对钩子由我们自己那台 C 前端插（`emitProfCall`），
 * 收集器由我们自己那台前端编。给了 `--cc clang` 就整趟交给它（`cFileViaCc`），
 * 那是同一件事的另一条路，不是唯一那条。
 * `node`  = **`--direct` 那条腿**（一份 js 原样交给 node）：只有 `sample` 成立，
 * 靠的是 node 自己那台 V8 采样器（`--cpu-prof`，见 `profNodeArgs`）。
 * `js` 这条腿上 `sample` **也接上了**（同一台采样器，量的是我们发出来的那份 JS）——
 * 从前这一格是有名有姓地欠着的，第一百四十八片第三格还上了。
 *
 * `stub` 与 `cc` 在 `c-src` 上是**同一台机器**：两个名字都落到「我们这台编译器自己插桩」
 * 上。分不开也不必分 —— 那份 C 是别人写的，而插桩的人是我们。
 */
const PROF_LEGS = {
  cc: ['c', 'c-src'],
  stub: ['c', 'js', 'c-src'],
  sample: ['c', 'c-src', 'js', 'node'],
};

/** 腿名印给人看时的说法（`c-src` 这个内部名字对用户没意思）。 */
const LEG_SAY = { c: 'c', 'c-src': '.c 输入', js: 'js', node: '--direct' };

/** 这一趟的 `--profile MODE` 落在这条腿上成不成立 —— 不成立就一句话说清怎么办。 */
function profCheckLeg(mode, leg) {
  if (PROF_LEGS[mode].includes(leg)) {
    /* 从前这儿有两句「`.c` 输入 + `--cc self` 做不到」的话（`cc` 那一档要外部
     * `-finstrument-functions`、`stub` 那一档"不改别人的源码"）。两句都作废了
     * （第一百五十片第三格）：用户那句话是对的 —— 我们用 js 实现了完整的 tcc，
     * 把 cc 当外部这件事本身才是那个限制。现在 `emitProfCall` 就是我们自己的
     * `-finstrument-functions`，三档在这条腿上都不必借外部编译器。 */
    return;
  }
  const has = (m) => `${m}（${PROF_LEGS[m].map((l) => LEG_SAY[l] || l).join(' / ')}）`;
  if (leg === 'js' && mode === 'sample') {
    /* 这一格早晚不该再有：`sample` 已经在 js 腿上接上了（V8 采样器）。留一句是给
     * 「名单与这几句话对不上」当门 —— 走到这儿说明 PROF_LEGS 被改坏了。 */
    throw new OmniError('--profile sample 在 js 这条腿上本该成立（node 的 V8 采样器）——'
      + '走到这句说明 PROF_LEGS 那张名单与这几句话对不上，是这一层自己的错');
  }
  if (leg === 'node' && mode === 'stub') {
    throw new OmniError('--profile stub 是**我们发射期**插的那一对，而 `--direct` 是把你的 js'
      + '原样交给 node —— 不经我们的发射器，我们不改你的 js。这条腿上用 `--profile sample`'
      + '（node 自己那台 V8 采样器）；要发射期插桩就去掉 `--direct`（走我们这一轮）');
  }
  if (leg === 'node' && mode === 'cc') {
    throw new OmniError('--profile cc 是**外部 C 编译器**自己的插桩（-finstrument-functions），'
      + '`--direct` 那条腿上跑的是 node，没有这台机器。用 `--profile sample`');
  }
  if (leg === 'js' && mode === 'cc') {
    throw new OmniError('--profile cc 是**外部 C 编译器**自己的插桩（-finstrument-functions），'
      + 'js 这条腿上没有这台机器。要么 `--backend c`，要么换 `--profile stub`（js 腿也有）');
  }
  throw new OmniError(`--profile ${mode} 在 ${leg} 这条腿上没有：现在 `
    + `${has('cc')} · ${has('stub')} · ${has('sample')}`
    + `${leg === 'graph' ? '。graph 那台机器（--engine graph）的 profile 还没接' : ''}`);
}

/**
 * js 那条腿的 `--profile stub` 收尾（第一百四十七片第四格）。
 *
 * 收集器在**被跑的那份 JS 里**（`prelude.js` 的 `JS_PROF_RT`），所以取账的办法是再走一次
 * 间接 `eval`：那两个名字挂在全局上，同一个全局作用域里叫得到。这样这份文件里一个
 * `globalThis` 都不用出现（自举那条腿的封闭子集，ADR-0011）。
 */
function profJsFinish() {
  if (PROF === null || PROF.mode !== 'stub' || PROF.leg !== 'js') return;
  const folded = evalJs('typeof $prof_report === "function" ? $prof_report() : ""');
  if (typeof folded !== 'string' || folded === '') {
    stderr('omni: profile：一格函数都没量到（这一趟里没有插得上桩的函数？）\n');
    return;
  }
  if (PROF.out !== null && PROF.out !== undefined) {
    writeText(PROF.out, folded);
    stderr(`omni: 折叠栈 -> ${PROF.out}（${folded.split('\n').length - 1} 条栈`
      + '，js 腿 · 发射期插桩）\n');
    return;
  }
  stderr(evalJs('$prof_table()'));
  /* 五张表（第一百四十九片）：那份折叠栈就在手里，热路径 / 调用边 / 调用树三张只有
   * 这一层算得出来。上面那张是收集器自己印的（自用 / 含子 / 调用次数）—— **次数**那一栏
   * 采样与聚合回溯都给不出，所以两张并排留着，各答各的问题。 */
  profViews(folded, 'omni prof（stub · js 腿 · 聚合回溯）', 'us');
}

/**
 * **一份折叠栈的五张读法**（第一百四十九片）。
 *
 * 用户那句话的原文：「我们的 cli 开 profile，只是显示函数调用次数和时间是不够。需要同时
 * 显示热路径。」—— 聚合回溯（一条栈 + 一个权重）本来就是为了看热路径，火焰图只是它的
 * 一种**画法**；在终端上真正好用的是排好序的表：能读、能 diff、能贴进提交信息。
 *
 * 五张各答一个不同的问题，谁也替不了谁：
 *   摘要      这些百分比是从多少绝对时间里分出来的（3ms 的账上"40%"没有意义）
 *   函数表    时间花在谁身上（自用 + 含子两栏：是它慢，还是它叫的人慢）
 *   热路径    **从哪儿走过来的** —— 一格函数被十处调用时，热的是哪一处
 *   调用边    一格热函数是被谁引热的（同一条边在所有路径上的权重加总）
 *   调用树    时间在每个分叉上怎么分的（对半分的两条子路在路径榜上都不显眼）
 *
 * `--profile-out` 给了的时候这五张不印：那一趟的产出是**那份折叠栈**（喂火焰图 /
 * speedscope / gprof2dot），要看表就 `omni flame` 或者不给 `--profile-out`。
 */
function profViews(folded, title, unit) {
  stderr(`\n${title}\n`);
  stderr(foldedSummary(folded, unit));
  stderr(foldedTable(folded, '', 20, unit));
  stderr(foldedPaths(folded, '', 10, unit));
  stderr(foldedEdges(folded, '', 10, unit));
  stderr(foldedTree(folded, '', 8, 1.0, unit));
}

/**
 * C 那几条腿的收尾（第一百四十九片）：把孩子落下的折叠栈读回来，印那五张表。
 *
 * 为什么不在孩子里印：热路径 / 调用边 / 调用树都要**整份聚合回溯**在手里排序，而孩子那侧
 * 是在 atexit（甚至信号处理函数）附近，那儿不该干排序与格式化这种事 —— 它只管把
 * `a;b;c 权重` 吐出来。这条分工与「渲染 SVG 归 CLI」是同一条（见 `profSvgFinish`）。
 *
 * 只在**没给 `--profile-out`** 时走（那时候 `tmpOut` 才有值）：给了的话那一趟的产出就是
 * 那份文件，表由 `omni flame` 或者下一趟不带 `--profile-out` 去看。
 */
/**
 * 折叠栈里的裸地址翻回名字。`PROF.map` 指着 `writeLinkMap` 落下的那份文件。
 *
 * 认两种形状：`[0x50cdec]`（glibc 的 `backtrace_symbols` 在没有符号时给的那一格，
 * 被 `pf_name_of` 当成"名字"取走了）与 `0x50cdec`（`omni_prof.c` 自己的兜底）。
 * 翻法是"落在哪一格之后"——按地址升序二分，取**最后一个不大于它**的符号。
 * 翻不出来的原样留着（那说明那一帧在 libc 里，不是我们的代码）。
 */
function profMapResolve(folded) {
  if (PROF === null || PROF.map === undefined || PROF.map === null) return folded;
  if (!exists(PROF.map)) return folded;
  const addrs = [];
  const names = [];
  for (const ln of readText(PROF.map).split('\n')) {
    const sp = ln.indexOf(' ');
    if (sp <= 0) continue;
    const a = Number.parseInt(ln.slice(0, sp), 16);
    if (!Number.isFinite(a)) continue;
    addrs.push(a);
    names.push(ln.slice(sp + 1));
  }
  if (addrs.length === 0) return folded;
  const at = (a) => {
    let lo = 0;
    let hi = addrs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (addrs[mid] <= a) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best < 0 ? null : names[best];
  };
  const one = (frame) => {
    const m = /^\[?0x([0-9a-fA-F]+)\]?$/.exec(frame);
    if (m === null) return frame;
    const nm = at(Number.parseInt(m[1], 16));
    return nm === null ? frame : nm;
  };
  const out = [];
  for (const ln of folded.split('\n')) {
    if (ln === '') { out.push(ln); continue; }
    const sp = ln.lastIndexOf(' ');
    if (sp < 0) { out.push(ln); continue; }
    const stack = ln.slice(0, sp).split(';').map(one).join(';');
    out.push(`${stack}${ln.slice(sp)}`);
  }
  return out.join('\n');
}

function profFoldedFinish() {
  if (PROF === null || PROF.tmpOut === undefined || PROF.tmpOut === null) return;
  const f = PROF.tmpOut;
  PROF.tmpOut = null;
  const folded = profMapResolve(exists(f) ? readText(f) : '');
  /* 单位跟着档走（与 `omni_prof.c` 的 `pf_write_folded` 是同一句话）：采样落的是帧数，
   * 插桩落的是**微秒**的自用时间。折叠栈这个格式自己不带单位，两边说的必须一致。 */
  const unit = PROF.mode === 'sample' ? 'frames' : 'us';
  if (folded.trim() === '') {
    /**
     * **一帧都没采到也要说话**（第一百四十九片第三格补的那一句）。
     *
     * 量到的原话（用户那一趟）：`run tests/cases/14_json_native.omni --profile sample:997
     * --backend c` 印完程序输出，只剩一句「折叠栈写到了 …」，五张表一张都没有 ——
     * 看着像 `--backend c` 被忽略了。真相是那份程序几毫秒就跑完，997Hz 上**一帧都没落**，
     * 而这一层当时选择了沉默（注释里写的是"孩子那侧已经说过了"，可孩子只说了落点）。
     * 沉默让人怀疑开关没生效，比多印一行糟得多。
     */
    if (PROF.mode === 'sample') {
      stderr(`omni: profile（sample · ${LEG_SAY[PROF.leg] ?? PROF.leg} 腿）一帧都没采到`
        + ' —— 采样只在**这个进程真的在烧 CPU** 的时候才有帧，而这一趟太短。'
        + '三条路：把工作量加大、把频率提上去（`--profile sample:9973`）、'
        + '或者换成不靠采样的那一档（`--profile cc` / `--profile stub`，按调用计数与时间）\n');
    } else if (PROF.mode === 'stub') {
      /* stub 现在也记调用栈了（生成的 C 里那张按路径的表，见 backend-c 的 `omni_prof_path`）
       * —— 走到这儿是「这一趟一条路都没记下来」：程序太短，每格自用都不满 1µs。 */
      stderr('omni: profile（stub · c 腿）一条调用栈都没记下来 —— 这一档按**每次返回的自用时间**'
        + '记，这一趟每一格都不到 1µs。上面 `prof[core]` 那张按函数的表（含调用次数）还在\n');
    } else {
      stderr(`omni: profile（${PROF.mode} · ${LEG_SAY[PROF.leg] ?? PROF.leg} 腿）`
        + '一条调用栈都没记下来 —— 插桩那一档按**每次返回的自用时间**记，'
        + '这一趟每一格都不到 1µs（或者根本没有被插桩的函数）。上面那张按函数的表还在\n');
    }
    return;
  }
  profViews(folded, `omni prof（${PROF.mode} · ${LEG_SAY[PROF.leg] ?? PROF.leg} 腿 · 聚合回溯）`, unit);
}

/** 这一趟给 node 加了采样开关时记一格（落点在哪儿），收尾时按它取账。 */
let PROF_NODE = null;

/**
 * **node 腿的 sample：借 node 自己那台 V8 采样器**（第一百四十八片第三格）。
 *
 * 这一格从前是**有名有姓地欠着**的（`profCheckLeg` 里那句「采样要宿主自己那台」）。
 * 现在接上了，办法是把开关加在**被跑的那个 node 进程**的命令行上：
 *   --cpu-prof                 采样开
 *   --cpu-prof-dir / -name     落点由我们定（不然它按 PID 起名，捞不着）
 *   --cpu-prof-interval µs     `--profile sample:200` 那个 hz 折成微秒（默认 1000µs）
 * 采样器只能在**进程启动时**开，所以两条路都得是「spawn 一个 node」：
 *   `--direct` 那条本来就是（`runJsDirect`）；
 *   我们发射出来那份 JS 从前在本进程里 eval，这一档改成落盘 + spawn（见 `runJsChild`）。
 *
 * 两条路共用这一格与收尾那一格 —— 用户那句话的原文是「node prof 对直到到 node 和一轮
 * 处理后的 js 都适用」。
 */
function profNodeArgs() {
  if (PROF === null || PROF.mode !== 'sample') return [];
  const dir = workDirFor('prof-node', hash16(`${PROF.hz}`));
  mkdirAll(dir);
  PROF_NODE = { dir, file: join(dir, 'omni.cpuprofile') };
  /* 旧的那份先删：`.cpuprofile` 不在的时候我们要能说「这一趟没量到」，
   * 而上一趟留下的那份会把这句话变成谎话。 */
  if (exists(PROF_NODE.file)) writeText(PROF_NODE.file, '');
  const us = PROF.hz > 0 ? Math.max(1, Math.round(1000000 / PROF.hz)) : 0;
  return ['--cpu-prof', '--cpu-prof-dir', dir, '--cpu-prof-name', 'omni.cpuprofile',
    ...(us > 0 ? ['--cpu-prof-interval', `${us}`] : [])];
}

/** node 采样那一趟的收尾：`.cpuprofile` -> 折叠栈 -> 表 / 落盘（火焰图由汇合点画）。 */
function profNodeFinish() {
  if (PROF_NODE === null) return;
  const f = PROF_NODE.file;
  PROF_NODE = null;
  const raw = exists(f) ? readText(f) : '';
  if (raw === '') {
    stderr('omni: node 那台采样器没落下 .cpuprofile —— 这一趟没量到'
      + '（程序太短？或者这个 node 版本没有 --cpu-prof）\n');
    return;
  }
  const folded = cpuProfileToFolded(raw);
  if (folded === '') {
    stderr('omni: node 采样器落了账但一帧都没采到（程序太短）\n');
    return;
  }
  const lines = folded.split('\n').length - 1;
  if (PROF.out !== null && PROF.out !== undefined) {
    writeText(PROF.out, folded);
    stderr(`omni: 折叠栈 -> ${PROF.out}（${lines} 条栈，node 腿 · V8 采样器）\n`);
    return;
  }
  profViews(folded, `omni prof（node 的 V8 采样器，${lines} 条栈）`, 'us');
}

/**
 * `--stat` / `--stat-out` 的落地（第一百四十七片第二格）：模块依赖图 + 构建统计。
 *
 * 数据来自两处，**都是已经算出来的**，这一层只是把它们对在一起：
 *   模块图   `compileProgram` 回的 `modPath`（id -> 路径）与 `ast.imports`（id -> 依赖 id）
 *   产出分布 cgen 回的 `stats`（源文件 -> 字节 / 行 / 函数）
 * 算与印分开：算在 `cli/statgraph.js`（纯计算、可判据），印在这儿。
 *
 * 拿不到模块图时**说清楚**（别的语言前端还没交出这一格），不假装印一张空表。
 */
/**
 * 各层的账（第一百四十七片第五格）：源码 -> AST -> OIR -> 目标文本，每层多少格、多少字符。
 *
 * 为什么要与 graph 那台机器**共用一份量法**（`cli/layers.js`）：胀不是图那条腿独有的，
 * 老那几条（js -> js、asy -> js、前端 -> OIR -> C）胀得更厉害，而它们还没有显式的图。
 * 「优化方法是统一的」这句话要落地，先得有一把两台机器都认的尺子 —— 这一格就是那把尺子
 * 在 omni 腿上的接线（graph 腿在 `graph/run.js` 的 `statOf` 里接同一份）。
 */
function statLayers(cr) {
  if (cr === undefined || cr === null) return;
  const paths = cr.modPath === undefined || cr.modPath === null ? [] : [...cr.modPath.values()];
  let chars = 0;
  let lines = 0;
  for (const p of paths) {
    if (!exists(p)) continue;
    const t = readText(p);
    chars += t.length;
    lines += t.split('\n').length;
  }
  const layers = [];
  if (cr.ast !== undefined && cr.ast !== null) {
    layers.push({ name: 'AST', n: countNodes(cr.ast.decls), unit: '格', bytes: null });
  }
  if (cr.mod !== undefined && cr.mod !== null) {
    layers.push({ name: 'OIR', n: cr.mod.funcs.length, unit: '个函数', bytes: null });
  }
  if (LAST_EMIT_BYTES > 0) {
    layers.push({ name: '目标文本', n: null, unit: '', bytes: LAST_EMIT_BYTES });
  }
  /* **按源码长起来的那一段**（固定序言另算 —— shrink 文档第三节钉的就是这一行）。
   * js 腿上这个数是「不带 prelude 再发一遍」（`chunk: true`）；C 腿上是 cgen 那份
   * 按源文件的产出分布之和（总字节减掉它就是共用的那几样）。 */
  if (LAST_EMIT_PROG > 0) {
    layers.push({ name: '按源码那一段', n: null, unit: '', bytes: LAST_EMIT_PROG });
  }
  if (layers.length === 0 || chars === 0) return;
  stderr(layerTable(layerModel({ bytes: chars, lines }, layers)));
  /* **按 kind 的分布**（与图那条腿的「按 op 的分布」同一种读法）：只报总数看不出胀在哪儿。
   * 老那几条腿的中间层从前只有总数，这两张表是「统一支持」的落点。 */
  if (cr.ast !== undefined && cr.ast !== null) stderr(kindTable('AST', kindStat(cr.ast.decls)));
  if (cr.mod !== undefined && cr.mod !== null) stderr(kindTable('OIR', kindStat(cr.mod.funcs)));
}

function statReport(cr) {
  if (STAT === null) return;
  /* 一、**时间**（构建统计不只是依赖）：那几十处 `vStep` 攒出来的一张表。 */
  if (STEPS.length > 0) stderr(stepTable(STEPS));
  /* 二、各层的账（与 graph 那台机器同一把尺子）。 */
  statLayers(cr);
  /* 三、模块依赖图 —— 只有核心方言那条腿交得出来。 */
  const modPath = cr === undefined || cr === null ? undefined : cr.modPath;
  if (modPath === undefined || modPath === null || modPath.size === 0) {
    stderr('omni: --stat：这门语言的前端还没交出模块图（只有核心方言 .omni 那条腿有）\n');
    return;
  }
  const model = statModel({
    modPath, imports: cr.ast.imports, stats: LAST_CGEN_STATS,
    funcs: cr.mod === undefined ? undefined : cr.mod.funcs,
  });
  const out = STAT.out === undefined ? null : STAT.out;
  if (out !== null && out !== undefined) {
    const text = out.endsWith('.json') ? statJson(model) : statDot(model);
    writeText(out, text);
    stderr(`omni: 依赖图 -> ${out}（${out.endsWith('.json') ? 'json' : 'dot：dot -Tsvg 出图'}）\n`);
  }
  /* 落了盘也照样印那张表：一张图不看的时候，表就是答案。 */
  stderr(statTable(model));
}

/** 字节数印成 1.5G / 12.8M / 900K —— 只给人看，所以一位小数就够。
    M 那一档带小数是要紧的：追膨胀时"12M -> 12M"什么都没说，而 12.8M -> 11.6M 说了。 */
function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)}G`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}

/** 毫秒印成 1m12s / 6.7s / 340ms —— 与 fmtBytes 同一个路数，给人看的。 */
function fmtDur(ms) {
  const s = ms / 1000;
  if (s >= 60) return `${Math.trunc(s / 60)}m${Math.round(s % 60)}s`;
  if (s >= 1) return `${s.toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * 构建流水账：**核心一档、插件一档**。
 *
 * 从前一次 `npm run native` 只在最后说一句"多久"，而"分语言之后总体积涨了 50%"这件事
 * 压根看不见 —— 核心与 12 格插件各自多大、各自花多久，得人拿 wc 一个个去量。核心与插件
 * 走的是同一个 `buildNative`，所以账记在那里，命令收尾时印一次。
 *
 * 记的是**生成的 C**（行/字节）与产物大小，两样分开：C 那一侧是膨胀，产物那一侧是 cc
 * 的结果，压缩比不一样，混成一个数就没法判断该往哪儿下刀。
 */
let TALLY = [];

/**
 * 前端那一段的耗时（读文件、解析、检查、降级），由**叫 compile 的那一处**填。
 *
 * 它不在 buildNative 里面：那时 mod 已经在手上了。而流水账要能对上墙上时间 —— 不含前端的
 * 行加起来永远少一截，看的人只能猜那一截去哪了。所以留这一格，tally 取走时清零。
 */
let FE_MS = 0;

/** 数换行。`split('\n').length` 在 22 MB 的串上要多申一整个数组，这条路上不值得。 */
function nlCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n = n + 1;
  return n;
}

function tally(name, isPlugin, cText, binBytes, genMs, ccMs) {
  TALLY.push({
    name, plugin: isPlugin, cBytes: cText.length, cLines: nlCount(cText),
    bin: binBytes, feMs: FE_MS, genMs, ccMs,
  });
  FE_MS = 0;
}

/** 一档的合计（核心那档一行，插件那档 12 行）。 */
function tallySum(rows) {
  const t = { n: rows.length, cBytes: 0, cLines: 0, bin: 0, feMs: 0, genMs: 0, ccMs: 0 };
  for (const r of rows) {
    t.cBytes = t.cBytes + r.cBytes;
    t.cLines = t.cLines + r.cLines;
    t.bin = t.bin + r.bin;
    t.feMs = t.feMs + r.feMs;
    t.genMs = t.genMs + r.genMs;
    t.ccMs = t.ccMs + r.ccMs;
  }
  return t;
}

function tallyRow(label, t) {
  stderr(`  ${label.padStart(4)} ${String(t.n).padStart(3)} 份`
    + `  C ${fmtBytes(t.cBytes).padStart(6)} / ${String(t.cLines).padStart(7)} 行`
    + `  产物 ${fmtBytes(t.bin).padStart(6)}`
    + `  前端 ${fmtDur(t.feMs).padStart(6)} + 发射 ${fmtDur(t.genMs).padStart(6)}`
    + ` + cc ${fmtDur(t.ccMs).padStart(6)}\n`);
}

/** 收尾时印流水账。一份产物就不印分档（那时它自己就是全部，vStep 已经说过了）。 */
function vTally() {
  if (TALLY.length < 2) { TALLY = []; return; }
  const core = TALLY.filter((r) => !r.plugin);
  const plug = TALLY.filter((r) => r.plugin);
  stderr('omni: 构建流水账（core / plugin）\n');
  if (core.length > 0) tallyRow('核心', tallySum(core));
  if (plug.length > 0) tallyRow('插件', tallySum(plug));
  tallyRow('合计', tallySum(TALLY));
  TALLY = [];
}

function vStep(msg) {
  /* **算一步的耗时与攒起来这件事与 `-v` 无关**（第一百四十七片第五格）：`--stat` 那张
   * 「时间去哪儿了」的表就是这些步骤攒出来的 —— 构建统计不只是依赖，还有时间。
   * 从前这一格第一句就是 `if (!VERBOSE) return;`，于是不带 `-v` 时连 `vMark` 都不动。 */
  const now = nowMs();
  const d = Math.trunc(now - vMark);
  vMark = now;
  const rss = Math.trunc(maxRssBytes());
  const grew = rss > vRss;
  vRss = rss;
  if (STAT !== null) STEPS.push([msg, d, rss]);
  if (!VERBOSE) return;
  /* 峰值常驻内存**只在它长了的时候**印：它是单调的，每行都印是噪声，而"是哪一步把它顶上去
     的"才是要看的那件事。这一格与耗时同等重要 —— 这条腿上墙上时间的大头常常是内存压力而
     不是 CPU（量出来的：emit-c 编译器自己一趟 35.6s 墙 / 25.9s 用户 / 峰值 1.56 GB /
     页回收 147 万，同一步在不同轮次能差两倍）。 */
  stderr(`omni: ${msg}  [${d}ms${grew ? ` peak ${fmtBytes(rss)}` : ''}]\n`);
}

/**
 * 按源文件的产出分布（`--stats`）。印到 **stderr** —— stdout 上是产物，测试里逐字节比对。
 *
 * 回答的是"这 42 万行是谁撑起来的"：单体构建里这件事从前压根没有答案，而"看不见"正是
 * 分文件构建之前最贵的那一笔。共用的那几样（字面量池、容器实例化、成员派发器、内联的运行时）
 * 摊给任何一个源文件都不对，所以单列一行 —— 它等于总字节减掉所有函数的字节。
 */
function vStats(cText, stats) {
  if (!STATS) return;
  const rows = [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  let sum = 0;
  for (const r of rows) sum = sum + r[1].bytes;
  const total = cText.length;
  const pct = (n) => (total > 0 ? `${(n * 100 / total).toFixed(1)}%` : '0.0%');
  stderr(`omni: 产出分布  共 ${fmtBytes(total)} / ${rows.length} 个源文件\n`);
  for (const r of rows) {
    stderr(`  ${pct(r[1].bytes).padStart(6)}  ${fmtBytes(r[1].bytes).padStart(7)}`
      + `  ${String(r[1].lines).padStart(7)} 行  ${String(r[1].funcs).padStart(5)} fn  ${r[0]}\n`);
  }
  stderr(`  ${pct(total - sum).padStart(6)}  ${fmtBytes(total - sum).padStart(7)}`
    + `  ${''.padStart(7)}       ${''.padStart(5)}     (共用：字面量池 / 容器 / 成员派发器 / 运行时)\n`);
}

/* `-v` 走管线表那一份渲染（ADR-0018 决策五，分片 2 后半）。
 *
 * `--explain` 与 `-v` 必须是**同一份数据的两种印法**，不然它们迟早对不上。做法：`vBegin`
 * 把 `--explain` 造的那张表接过来（列宽于是与 `--explain` 印的完全一样），实现每做完一格
 * 叫一次 `vNext(verb)`，那一行就带着耗时落到 stderr 上。
 *
 * `vNext` 要**核对 verb**：表是 `plan-c.js` 造的、叫的是实现，两边各改一处就会错位 ——
 * 错位之后印出来的每一行都在骗人。所以对不上就直接骂，而且骂在 `-v` 上（不开 `-v` 不受
 * 影响，那条路上一个字节都不多）。 */
let LIVE = null;

function vBegin(plan) {
  if (!VERBOSE || plan === null) return;
  LIVE = { plan, i: 0 };
  stderr(renderSummary(plan));
  vMark = nowMs();
}

function vNext(...verbs) {
  if (LIVE === null) return;
  /* 好几格一起报的情形（`vNext('read', 'cpp', 'lower')`）：实现那一侧只有一次调用能量
   * （`lowerCNative` 一趟就把读文件、预处理、降级全做了），拆不开。那就**只把耗时挂在
   * 最后一格上**、并且注明是一起量的 —— 前面几格印一个 `⋯` 而不是编一个数出来。 */
  for (let k = 0; k < verbs.length; k++) {
    const s = LIVE.plan.stages[LIVE.i];
    if (s === undefined || s.verb !== verbs[k]) {
      throw new OmniError(`internal: 管线表与实现错位 —— 第 ${LIVE.i + 1} 格表里是`
        + ` '${s === undefined ? '（没有了）' : s.verb}'，实现叫的是 '${verbs[k]}'`
        + '（改了 cli/plan-c.js 或实现里的 vNext，两边要一起改）');
    }
    const last = k === verbs.length - 1;
    if (!last) {
      stderr(`${renderStage(LIVE.plan, LIVE.i)}  ⋯\n`);
      LIVE.i++;
      continue;
    }
    const now = nowMs();
    const d = Math.trunc(now - vMark);
    vMark = now;
    const line = renderStage(LIVE.plan, LIVE.i, d);
    stderr(`${line}${verbs.length > 1 ? `（这 ${verbs.length} 格一起量）` : ''}\n`);
    LIVE.i++;
  }
}


/**
 * WAT（WebAssembly 文本格式）-> OIR。S 表达式那条路径上的第一个真语法前端，
 * 也是 OIR 的第三个生产者 —— 边界与理由见 frontend-wat/lower.js 的文件头。
 */

function compile(path, argv = []) {
  const r = compileFront(path, argv);
  // 摇树（第一百〇六刀）：所有前端都是"把库整份降下来"，从入口不可达的那些函数一个都不发。
  // `OMNI_PRUNE=0` 关掉 —— 要对比"摇没摇"两份产物时用。
  if (env('OMNI_PRUNE') !== '0' && r !== undefined && r.mod !== undefined) {
    /* `--plugin NAME` 那一支：NAME 是摇树的另一个根（见 prune.js 的根三）。 */
    const pi = argv.indexOf('--plugin');
    const n = pruneFuncs(r.mod, pi >= 0 && argv[pi + 1] !== undefined ? [argv[pi + 1]] : []);
    if (n.after !== n.before) vStep(`prune  ${n.before} -> ${n.after} funcs（摇掉 ${n.before - n.after}）`);
  }
  return r;
}

/* 前端在这儿登记（ADR-0021 S3）：内建的现在就登记，`dlopen` 出来的插件在
 * `omni_plugin_init` 里调同一个 registerLang —— 这一层看不出内建与外挂的区别。
 * 核心方言（.omni / .omnid / .omnis）不登记：它跟 driver 是一体的，永远在核心里。 */
/* asy 那一份拿着核心给的宿主服务过日子（ADR-0021 S4）：印记那三格是驱动侧的
 * 缓存格式，AST 缓存的键沿用了它 —— 那处层次串门记在 lang/asy.js 的文件头里。 */

/**
 * 交给插件的那一格宿主服务（ADR-0021 的 S4）。
 *
 * 内建与外挂用**同一份** —— 内建就是核心自己调一次 register，外挂是 `dlopen` 之后
 * `omni_plugin_init` 拿这一格调同一个 register。两条路只差登记的时刻，形状一模一样，
 * 于是"把一门语言从内建搬成插件"不必改它一行。
 */
/**
 * 编译器读一份**模块源码**时过这儿（ADR-0021 的 S4）。
 *
 * 平时就是 readText。只有一份要换：`lang/builtin.js` 交的是 `builtin-core.js` 的内容 ——
 * 于是那几门语言的 `import` 在编出来的产物里根本不存在，链接器不会去读它们。
 *
 * **这是默认，不是一个档**：编出来的核心就是 js -> c，别的语言各自一格
 * `plugins/omni-lang-*.dylib`（`build --fat` 才把它们全编进核心，那是逃生门）。
 * 从源码跑的那条腿不过这个接缝（它走自己的 import），所以开发腿一直是全的 ——
 * node 没有同步 ESM import，装不动插件，只能这样。
 *
 * 换在这一层而不是让语言自己判：**编进来哪几门是构建的决定**，不是某一门语言的事。
 */
function readModule(p) {
  /* 三份 builtin 的分工与"为什么这条规则单独一份"见 lang/builtin-pick.js：
     迟装那一份（builtin.js）只给从源码跑的这条腿，编的时候必须换成 fat 或 core。 */
  const alt = builtinAlt(p, LANGS_FAT);
  if (alt !== null) {
    vStep(`builtins ${LANGS_FAT ? 'fat ' : 'core'}  ${alt}`);
    return readText(alt);
  }
  return exists(p) ? readText(p) : null;
}

function pluginApi() {
  return {
    registerLang: registerLang,
    registerTarget: registerTarget,
    registerRunner: registerRunner,
    registerCap: registerCap,
    /* 迟装（ADR-0023 S7）：内建那几门先只**声明**，真被问到才装进来。插件那条路不用它
       （dlopen 出来的那一格已经在内存里了，直接 register 就是）。 */
    declareProvider: declareProvider,
    log: vStep,
    /* 印记那三格与 srcIdNote 是驱动侧产物缓存的格式（asy 的 AST 缓存借了它 ——
       那处层次串门记在 lang/asy.js 的文件头里）；incDirs / findCC 也是驱动的事。 */
    inpPath: inpPath,
    inpOk: inpOk,
    inpField: inpField,
    srcIdNote: srcIdNote,
    incDirs: incDirs,
    findCC: findCC,
    readModule: readModule,
  };
}

/**
 * 自动发现：约定目录里放着的每一格插件都装上（ADR-0021 的 S4）。
 *
 * **没有开关。** "带哪些语言"是那个目录的内容，不是命令行上的白名单 —— 装了就有、
 * 没装就没有。目录不在就是没装插件，那不是错。
 *
 * 只认约定的名字（`omni-lang-<名字>` / `omni-target-<名字>`）与本平台的后缀：目录里放着
 * 别的东西（README、旧版本的备份）不该被当成插件去 dlopen。真装不上要**响错**
 * （pluginLoad 里三种坏法各说清下一步），不许悄悄跳过 —— 悄悄跳过就成了
 * "我明明装了它，它却说没这门语言"。
 */
/* 内建那一串（ADR-0021 S4）：收在 lang/builtin.js 里 —— 编薄核心时换掉那一份就行。 */
registerBuiltins(pluginApi());

/**
 * 插件摆在**产物旁边**：`dist/omni` 的插件就是 `dist/plugins/`（ADR-0021 的 S4）。
 *
 * 启动时不许要参数 —— 装哪些插件是**布局**说的，不是命令行说的。所以按顺序试几处：
 * 产物同级的 `plugins/`（装好的样子）、上一层与上两层（开发时把核心搁在 dist/build 那种），
 * 最后是 `<当前目录>/dist/plugins` —— 从源码跑的那条腿走这一条：它装不动，但要**看见**
 * 有哪几格，才能在用到那门语言时说"装了但这条腿加载不了"。
 */
function pluginsDir() {
  const cands = [join(installDir(), 'plugins'), join(installDir(), '..', 'plugins'),
    join(installDir(), '..', '..', 'plugins')];
  /* `<当前目录>/dist/plugins` 只给**装不动插件的那条腿**（从源码跑的 JS 腿）留着：它要的是
     "看见有哪几格"，好在用到那门语言时说"装了但这条腿加载不了"。编出来的核心不能吃这一条 ——
     当前目录是偶然的，量到过：`/tmp` 底下一份 `--fat` 的核心，因为 cwd 恰好是仓库，
     去装了仓库 dist/plugins 里的插件，然后报 `symbol not found '_g_CALL_LDRET'`
     （它自己没 `--extern`，本来也不该装谁）。 */
  if (!pluginsOk()) cands.push(join(cwd(), 'dist', 'plugins'));
  return cands.find((d) => isDir(d)) ?? null;
}

/**
 * 已经装上的插件（绝对路径）。
 *
 * 为什么要这一格：`buildSelf` 链那一步走的是 `subMain(['c','link', …])`，而 `subMain`
 * 会再跑一遍 `discoverPlugins()` —— 于是原生腿上 `-v` 会看到**十二行 plugin 印两遍**，
 * 中间那一遍纯属白做（同一批 `.dylib` 重新 dlopen 一次，量到 674ms）。
 * dlopen 本身是幂等的（同一个句柄），可我们这一侧的注册表不是，重复注册也没有意义。
 */
const PLUGINS_LOADED = new Set();

function discoverPlugins() {
  const dir = pluginsDir();
  if (dir === null) return;
  /* **只认本平台那个后缀**（上面文件头说的就是这一条，而代码从前两个都收）。
     为什么要紧：同一个仓库先在 macOS 编一遍、再在 Linux 容器里编一遍，`dist/plugins`
     里就同时躺着 `.dylib` 与 `.so` —— 两个都收的话，macOS 这一趟会去 dlopen 那份 ELF，
     `pluginLoad` 当场报"装不上"，而那格插件根本不是给这台机器的。 */
  const ext = dsoExt(hostOs());
  for (const f of readDir(dir)) {
    const named = f.startsWith('omni-lang-') || f.startsWith('omni-target-');
    if (!named || !f.endsWith(ext)) continue;
    /* 这条腿装不动（node / JS 腿没有 dlopen）：记下名字，等真用到那门语言才响 ——
       理由与那句话本身都在 plugin.js 的 UNLOADABLE 那一段。 */
    if (!pluginsOk()) {
      const dot = f.lastIndexOf('.');
      const head = f.startsWith('omni-lang-') ? 'omni-lang-'.length : 'omni-target-'.length;
      noteUnloadable(f.slice(head, dot < 0 ? f.length : dot));
      continue;
    }
    const p = join(dir, f);
    if (PLUGINS_LOADED.has(p)) continue;   // 嵌套那一趟（c link）不再装一遍
    PLUGINS_LOADED.add(p);
    vStep(`plugin ${f}`);
    pluginLoad(p, pluginApi());
  }
}


/**
 * **`#lang` 那一格**（ADR-0037 的事情一）：一份文件的第一行说自己该交给哪台读入器。
 *
 * 默认**关着**。为什么默认关：ADR-0009 立的规矩是"一份文件的语言由后缀决定，不猜"——
 * `#lang` 是那条规矩的一个 opt-in 例外，不是它的替代。开法两处（不设第三处）：
 * 命令行 `--lang-directive`、环境 `OMNI_LANG_DIRECTIVE=1`（后者给 `spawn` 出去的孩子继承用，
 * 与 `OMNI_PROF` 同一手法）。
 *
 * 关着的时候遇到 `#lang` **当场报**并给出开法 —— 静默当注释是最坏的一种（同 `--profile` 认腿）。
 */
let LANG_DIRECTIVE = false;

/**
 * 头一行的 `#lang <名字> [参数…]`。没有就回 null。
 *
 * 只看**第一行**（允许前面是空行与 shebang）：位置固定才有"一眼看得出这是什么"的价值，
 * 而且不必扫整份文件。`#` 这个字在 s-expr 的 idchar 表里（`sexpr/read.js` 的 IDCHAR），
 * 于是这一行对读入器就是个普通 atom；而 C / js / jnc 那几门里行首 `#lang` 都不是合法代码，
 * 所以"被误当程序"这件事在装着的语言上都不成立。
 */
function langDirectiveOf(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    if (i === 0 && t.startsWith('#!')) continue;      // shebang
    const m = /^#lang[ \t]+(\S+)[ \t]*(.*)$/.exec(t);
    if (m === null) return null;
    return { name: m[1], rest: m[2].trim(), line: i + 1 };
  }
  return null;
}

/** 装着的读入器印成一行（`langNames()` 是唯一那份名单，声明了还没装的也算） */
function langsSay() {
  const have = langNames();
  return have.length === 0 ? '这份 omni 里一门语言都没装' : have.join(' / ');
}

/**
 * 这一趟按**哪门语言**读这份文件（ADR-0037 的 D3）。三处按固定优先级：
 *
 *   `#lang` 行  >  命令行 `--lang`  >  后缀
 *
 * 三处给了**不同**答案就报，并印出每一处各说了什么 —— "最后一个赢"那种默默择一，
 * 出错时人根本不知道自己在编哪门语言。
 *
 * 回 `{ l, why }`：`l` 是那门语言（`null` = 落到核心方言那一支），`why` 是它由哪一处定的。
 */
function pickLang(path, argv) {
  const byExt = lang(path);
  const li = argv.indexOf('--lang');
  const byFlag = li >= 0 && argv[li + 1] !== undefined ? argv[li + 1] : null;
  const dir = LANG_DIRECTIVE && exists(path) ? langDirectiveOf(readText(path)) : null;
  /* 关着的时候也要**看一眼**：看到了就报，不是当注释混过去。 */
  if (!LANG_DIRECTIVE && exists(path)) {
    const peek = langDirectiveOf(readText(path));
    if (peek !== null) {
      throw new OmniError(`${basename(path)}:${peek.line}: #lang 这一格默认关着 —— `
        + '一份文件的语言默认只由后缀决定（ADR-0009）。'
        + '开法：加 `--lang-directive`，或 `OMNI_LANG_DIRECTIVE=1`。'
        + `装着的读入器：${langsSay()}`);
    }
  }
  const names = [];
  if (dir !== null) names.push(['#lang 行', dir.name]);
  if (byFlag !== null) names.push(['--lang', byFlag]);
  if (byExt !== null) names.push(['后缀', byExt.name]);
  /* 冲突：两处以上说了话而且说的不是同一门。**报**，不择一。 */
  const distinct = [];
  for (const [, n] of names) if (!distinct.includes(n)) distinct.push(n);
  if (distinct.length > 1) {
    throw new OmniError(`${basename(path)}: 这份文件该按哪门语言读，几处说的不是同一个 —— `
      + names.map(([w, n]) => `${w} 说 ${n}`).join('、')
      + '。按 #lang 走就删掉 --lang（或改文件名），按后缀走就删掉那一行');
  }
  if (dir !== null) {
    /* `#lang omni` = 核心方言那一支。它**不在**语言注册表里（核心不是插件），所以单列一格 ——
     * 少了它，一份写着 `#lang omni` 的 `.omni` 会被报成"没有 omni 这台读入器"，而那句话是假的。 */
    if (dir.name === 'omni') return { l: null, why: '#lang omni' };
    const l = langByName(dir.name);
    if (l === null) {
      throw new OmniError(`${basename(path)}:${dir.line}: 没有 '${dir.name}' 这台读入器`
        + `（装着的是 ${langsSay()}）`);
    }
    return { l, why: `#lang ${dir.name}` };
  }
  if (byFlag !== null) {
    const l = langByName(byFlag);
    if (l === null) {
      throw new OmniError(`--lang ${byFlag}：没有这门语言（装着的是 ${langsSay()}）`);
    }
    return { l, why: `--lang ${byFlag}` };
  }
  return { l: byExt, why: '后缀' };
}

function compileFront(path, argv) {
  const { l, why } = pickLang(path, argv);
  if (l !== null) {
    if (why !== '后缀') vStep(`lang  ${basename(path)} 按 ${why} 交给 ${l.name}`);
    return l.compile(path, argv);
  }
  /* 不是核心方言、又没有哪门语言认它：**响着拒**，别拿核心方言去解析。
     量到过（薄核心上跑 `.asy`）：落到核心方言之后报的是 `undefined function 'write'` ——
     那句话把人往错的方向带，真相是"这份 omni 里没有 asy 这门语言"。 */
  const core = path.endsWith('.omni') || path.endsWith('.omnid') || path.endsWith('.omnis');
  if (!core) {
    /* 一格语言都没装是**正常**的一种状态（ADR-0021 S4）：核心里什么前端都没有，
       连 js 都是插件。那时候别印"这份 omni 带着 "后面跟一个空 —— 直说没装。 */
    const have = langNames();
    throw new OmniError(`不认识 ${basename(path)} 这种扩展名：`
      + (have.length === 0 ? '这份 omni 里一门语言都没装' : `这份 omni 带着 ${have.join(' / ')}`)
      + '（语言各自一格 plugins/omni-lang-<名字> 插件）');
  }
  return compileProgram(path, undefined, modeFor(path, argv));
}


/**
 * 上一趟 asyText 读过的文件（主文件在第一格）。产物缓存的依赖清单用它 ——
 * 模块是**加载期**才知道的（`import` 在源码里），所以只能事后取。
 */

/**
 * 编译器自己那一份的印记：src/core 底下每个文件的「路径 + 改动时间 + 字节数」。
 * 产物缓存的键里带它 —— 改了降级器或后端，缓存整片失效。
 * 目录与文件**问文件系统**（isDir），不按名字猜。原先按"名字里有没有点"分
 * —— 在 src/core 底下确实成立（目录都没有后缀，文件都有），但装好的那份里
 * 编译器自己就叫 `dist/src/host/omni`、没有后缀，于是它被当成目录走进去，
 * readdir 一个普通文件：`ENOTDIR: not a directory, scandir '…/dist/src/host/omni'`。
 * 一条"在源码树里恰好成立"的命名约定不能当成布局的判据。
 *
 * **这里原先只走了 `installDir()`**（那是 `src/core/host`），于是改了
 * frontend-asy/ 底下任何一处降级器，印记都不动、产物缓存整片误命中 —— 量到过：
 * 同一份 `path r=(0,0); r=r--(10,0); r=r..(20,10);` 在改完前端之后仍然出旧图
 * （直线而不是曲线），`rm -rf .omni-cache/asy-js` 之后才对。这与第七十九刀那次
 * "产物名只取基名"是同一类错：一个会跑错程序的缓存。所以往上走一级，走全 src/core；
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
 * 一切中间文件与缓存的根搬到了 `host/cache.js` —— `glr/load.js` 也要它，而模块作用域的
 * 名字必须全程序唯一（两处各写一个 `cacheRoot()` 会被链接器骂）。
 */

/**
 * 一次性的工作目录（生成的 `.c`、链出来的 `a.out`、写缓存前的暂存…）。
 *
 * **名字是确定的**，不是 mkdtemp 那种随机名：从前靠系统清 `/tmp` 才不攒垃圾，
 * 搬进仓库之后随机名就等于每跑一趟多一个目录。同一个 kind + key 的下一趟原地盖掉。
 * 代价写在明处：**并发跑同一个输入会撞**（同一份源码同时编两遍本来也会争缓存那一格）。
 */
/**
 * 链接图（`c link --map <文件>`）：一行一格 `0x<地址> 0x<长度> <名字>`，按地址升序。
 *
 * 为什么要它：ELF 可执行文件里我们**不写 `.symtab`**（见 elf_exe.js 那句注释），于是
 * profile 那一侧没有任何地方能把地址翻成名字。地址 -> 名字这一步只有链接器答得出来。
 *
 * **长度那一格是必须的**（第一百六十五片量到的教训）：`omni_prof.c` 查表时要判
 * 「这个地址真落在这个符号里头吗」。没有长度就只能拿"下一格的地址"当界，而表的最后
 * 一格没有下一格 —— 那一格会把它后面所有 libc 的地址都吞掉（量到过：`atexit` /
 * `_end` / `__TMC_END__` 这种假名字）。confidently wrong 比只印地址坏得多。
 */
function writeLinkMap(path, syms) {
  if (path === undefined || path === null || path === '' || !Array.isArray(syms)) return;
  const lines = syms.map((s) => `0x${s.addr.toString(16)} 0x${(s.size ?? 0).toString(16)} ${s.name}`);
  writeText(path, `${lines.join('\n')}\n`);
}

function workDirFor(kind, key) {
  const dir = join(cacheRoot(), 'work', key === '' ? kind : `${kind}-${key}`);
  mkdirAll(dir);
  return dir;
}

/**
 * 暂存目录的名字**要能读**：拿产物/源码的文件名，不拿它的哈希。
 *
 * 从前这儿是 `hash16(路径)`：路径与哈希一对一，所以哈希**没有任何去重收益**，
 * 只是把 `work/c-omni` 变成了 `work/c-75d7a0838ed4f474`。攒起来之后那 657 个目录
 * 里没有一个看得出是谁的（量过：518 MB，一格都没被回收过）。
 * 代价照旧写在明处：不同目录下的同名文件共用一格暂存 —— 它是暂存，本来就要被盖掉。
 */
function workName(p) {
  const base = String(p === undefined || p === null ? '' : p).replace(/^.*\//, '');
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' ? 'anon' : safe;
}

/** 人看的大小。 */
function mbOf(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * `omni cache ls | gc | clean`。
 *
 * 为什么这一格是命令而不是一句 `rm -rf`：**"该扔什么"是有判据的**（暂存 vs 缓存、
 * 多久没动、总量上限），而写成 shell 就等于每个人自己猜一遍。
 */
function cacheCmd(args, argv) {
  const sub = args[0] === undefined ? 'ls' : args[0];
  const root = cacheRoot();
  if (sub === 'ls') {
    const list = cacheList();
    let total = 0;
    for (const e of list) total = total + e.bytes;
    stdout(`${root}  合计 ${mbOf(total)}\n`);
    const now = Date.now();
    for (const e of list) {
      const age = e.newest === 0 ? '空' : `${Math.round((now - e.newest) / 86400000)} 天前`;
      stdout(`  ${e.name.padEnd(14)} ${mbOf(e.bytes).padStart(9)}  最后动过 ${age}\n`);
    }
    return 0;
  }
  if (sub === 'gc' || sub === 'clean') {
    const di = argv.indexOf('--days');
    const mi = argv.indexOf('--max-mb');
    const opts = {
      all: sub === 'clean',
      days: di >= 0 ? Number(argv[di + 1]) : 14,
      maxMb: mi >= 0 ? Number(argv[mi + 1]) : undefined,
    };
    if (argv.includes('-n')) {
      /* 只说不做：把"会扔哪几格"算出来印出来（同一套规矩，只是不动手）。 */
      const now = Date.now();
      let would = 0;
      for (const e of cacheList()) {
        let hit = opts.all || e.name === 'work';
        if (!hit && opts.days >= 0 && e.newest > 0 && now - e.newest > opts.days * 86400000) hit = true;
        if (!hit) continue;
        would = would + e.bytes;
        stdout(`会扔 ${e.name}  ${mbOf(e.bytes)}\n`);
      }
      stdout(`合计 ${mbOf(would)}（-n：什么都没动）\n`);
      return 0;
    }
    const dropped = cacheGc(opts);
    let freed = 0;
    for (const e of dropped) freed = freed + e.bytes;
    for (const e of dropped) stderr(`omni cache: 扔了 ${e.name}（${mbOf(e.bytes)}）\n`);
    stderr(`omni cache: 腾出 ${mbOf(freed)}\n`);
    return 0;
  }
  throw new OmniError(`omni cache：没有 '${sub}' 这一格 —— 有 ls / gc / clean`);
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
 * `.omni-cache/run-exe` 里，源码与它引的库都没动就直接 exec。
 *
 * 为什么必须有这一条：node 上那一路（模块产物 / 整份 JS）早就有缓存了，而自举出来的
 * 原生二进制一趟都没有 —— 量出来 `run tests/asy/cases/03-quotes.asy` **每趟 12s**
 * （AST 读回来 3.4s + 前端 5.0s + 发 C 2.5s + clang 0.5s），而这 12s 的输入
 * 一个字节都没变。命中之后剩下的只有 exec。
 *
 * 印记比 JS 那份多一格 **cc**：同一份源码用 clang 与用 tcc 链出来的是两个可执行文件。
 * 依赖清单与 jsCache 同一套（`路径\t改动时间\t字节数`，事后从 cap('asy.deps')() 取）。
 * `OMNI_NO_EXECACHE=1` 关掉（对照用）。
 */
function exeCacheDir() {
  /* 名字是 `run-exe` 而不是从前的 `asy-exe`：这一格是**所有** `omni run` 走 C 那条腿时
     的产物缓存（.omni / .js / .sx / .asy 都进它），叫 asy 只是它最早为 .asy 加的。
     那个旧名字让 `-v` 的日志自相矛盾 —— 跑一份 `.omni` 却看到
     `c link -> …/asy-exe/e-….bin`，读的人第一反应是"路径串了"。 */
  return join(cacheRoot(), 'run-exe');
}
function exeCacheStamp(cc) {
  // 编译器与**它的 flags** 都在印记里：`OMNI_OPT=2` 与默认 -O0 是两个可执行文件。
  // **`OMNI_PROFILE` 也得在**：它改的是生成的 C（插桩），不是 flags；不进印记的话
  // 开过一次 profile 之后，后面不带开关的运行会命中缓存、复用那份**带插桩**的二进制，
  // 于是量出来的时间被抬高、stderr 还多出 prof 那几行 —— 正是拿这条腿量性能时最坑的一种。
  // `--profile cc|stub` 同一个理由（第一百四十七片）：那两档也改二进制。
  // **`sample` 不进**：它一个字节都不改，只是运行期多一个环境变量 —— 进了印记反而
  // 让「同一份二进制，采一趟、再不采一趟」白编两遍。
  const profEnv = env('OMNI_PROFILE') === '1' ? '|prof' : '';
  const profFlag = PROF !== null && PROF.mode !== 'sample' ? `|prof:${PROF.mode}` : '';
  return `e1|${jsCacheStamp()}|cc:${cc}|${ccFlags(cc).join(' ')}${profEnv}${profFlag}`;
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
  /* `<hash>.out`，不是从前的 `e-<hash>.bin`：生成的 C 与目标文件的名字都跟着产物走
     （`buildNative` 里 `${basename(outPath)}.c`），于是旧名字让日志里出现
     `e-….bin.c` / `e-….bin.c.o` 这种东西 —— 同一份源码在 `run-c` 那条路上叫
     `a.out.c`。`.out` 与那边同形，看一眼就知道是"一个可执行文件"。 */
  return join(exeCacheDir(), `${hash16(path)}.out`);
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
/**
 * 前端手上已经有文本了，把这份内容的身份记进印记备忘 —— 省得下面真要哈希时再读一遍文件。
 * 入口在驱动这一侧：`srcIdMemo` 是产物缓存的备忘，前端只是"顺手告诉一声"（经 api 递进来）。
 * `hash` 是个 thunk：只有真要存的时候才算。
 */
function srcIdNote(p, mtime, len, hash) {
  const had = srcIdMemo.get(p);
  if (had === undefined || had.mtime !== mtime || had.len !== len) {
    srcIdMemo.set(p, { mtime: mtime, len: len, hash: hash() });
  }
}

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
/**
 * 读一份产物旁边那格 `.stamp` —— **只有这一处解析它**（ADR-0042 的第 0 步）。
 *
 * 从前 `load` / `mrec` / 清单里那格 `w|` 各自 `split('|')` 解一遍同一种文本：
 * 三处解析一种格式，换格式必漏一处，而漏了的症状是**静默复用旧产物**
 * （那三个 bug 的现场记在下面几段注释里）。所以先把读法收成一处，
 * 再换实现（索引 + 一格键）时就只动这一个函数。
 *
 * 回 `{text, cs, fields, mainTag}`；文件不在回 null。
 * `fields` 是去掉头一格（编译器印记）之后的那些，`mainTag` 是 `main:…` 那一格（没有就 null）。
 */
function stampRead(dir, name) {
  const p = join(dir, `${name}.stamp`);
  if (!exists(p)) return null;
  const text = readText(p);
  const all = text.split('|');
  let mainTag = null;
  for (const f of all) if (f.startsWith('main:')) mainTag = f;
  return { text, cs: all[0], fields: all.slice(1), mainTag };
}

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
    const secP = join(dir, `${nm}.sec`);
    const wkP = join(dir, `${nm}.wk`);
    const st = stampRead(dir, nm);
    if (st === null || !exists(join(dir, `${nm}.js`)) || !exists(secP) || !exists(wkP)) return null;
    if (st.cs !== cs) return null;
    for (let i = 0; i < st.fields.length; i++) {
      const f = st.fields[i];
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
    const nm = cap('asy.unitName')(info);
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
      const nm = cap('asy.unitName')(info);
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
        unpack: cap('asy.astUnpack'),
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
  const mainWord = cap('asy.mainWord')(path);
  const mainTag = `main:${mainWord}`;
  const r = cap('asy.unitTexts')(path, asyModsSkip(dir, cs, mainTag));
  // ADR-0015 第一步与第二步：指纹与归属先只打印不接线，好验两样都与"入口是谁"无关。
  if (env('OMNI_ASY_FP') === '1') {
    const fps = asyFps([...r.units, ...r.reused], cs);
    for (const n of [...fps.keys()].sort()) vStep(`asy 指纹  ${fps.get(n)}  ${n}`);
    for (const [nm, own] of r.owners === undefined ? [] : r.owners) {
      vStep(`asy 归属  ${own === '' ? '<运行时>' : own}  ${nm}`);
    }
  }
  writeText(join(dir, 'omni_rt.js'), cap('jsgen.runtimeModule')());
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
    const mod = cap('sx.textToMod')(u.name, u.text, `omni_init_${cap('asy.jsUnitSym')(u.name)}`);
    writeText(jsPath, target('js').emit(mod, { esm: true }));
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
  for (const n of names) lines.push(`import { omni_init_${cap('asy.jsUnitSym')(n)} } from './${n}.js';`);
  lines.push(`import { omni_init_${cap('asy.jsUnitSym')(r.entry)} } from './${r.entry}.js';`);
  for (const n of names) lines.push(`omni_init_${cap('asy.jsUnitSym')(n)}();`);
  lines.push(`omni_init_${cap('asy.jsUnitSym')(r.entry)}();`);
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
    const st = stampRead(dir, nm);
    if (st === null || st.mainTag === null) return '-';
    return st.mainTag;
  };
  const man = [asyModsEnv(), cs, r.entry];
  for (const u of r.units) man.push(`u|${u.name}|${u.key}|${fstamp(u.key)}|${mrec(u.name)}`);
  for (const u of r.reused) man.push(`u|${u.name}|${u.key}|${fstamp(u.key)}|${mrec(u.name)}`);
  // **omni_weak 那一份也要记一格**：它的内容由整个程序决定（名字却必须固定 ——
  // 库那几份 `.js` 里写死的是 `from './omni_weak.js'`），所以换个入口跑一趟就会把它盖掉。
  // 记下这一趟那份的印记，下一趟对不上就老老实实重来。
  // 量出来的样子（没有这一格时）：`run tri`、`run curve`、再 `run tri` —— 第三趟命中清单，
  // 拿的却是 curve 那份 weak，报 `s_…_shipout__d0_2_3_4_5_6_7_8_9` 不是它的导出。
  const wstamp = stampRead(dir, r.weak);
  if (wstamp !== null) man.push(`w|${wstamp.text}`);
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
  const m = path === undefined ? '' : cap('asy.fileUnitName')(path);
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
  const nm = cap('asy.fileUnitName')(path);
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






/**
 * 入口 -> 模块图 -> 检查 -> OIR。
 * 依赖不再靠"提到 json 就整体拼进来"的猜测（旧的 libsFor），而是靠源码里写下的 import（ADR-0009）。
 * `--mode` 只覆盖入口文件的模式；被导入模块的模式由它自己的后缀决定。
 */
function compileProgram(path, text, mode) {
  const diags = new Diagnostics();
  const { decls, imports, files, modPath } = loadProgram({ path, text, mode, diags, templates: LANG_DIRECTIVE });
  diags.throwIfErrors();
  vStep(`front end  ${path}  mode ${mode}, ${files.length} files, ${decls.length} decls, ${imports.size} imports`);
  const program = { kind: 'Program', decls, imports };
  const mod = check(program, diags, mode);
  diags.throwIfErrors();
  vStep(`check -> OIR  ${mod.funcs.length} funcs, ${mod.structs.length} structs`);
  /* `files` 带出去（第一百四十七片第二格）：`--stat` 要「模块 id -> 名字」才画得出依赖图。
   * 摆在返回值上而不是塞进 `program`：`program` 是**语言那一层的形状**（检查器吃它），
   * 而模块清单是构建那一层的账 —— 两件事，别混。 */
  return { ast: program, mod, diags, files, modPath };
}

/** 生成的 C 交给谁：`--cc` 先说，没给才看 `OMNI_CC`（两处都没给 = `self`）。 */
function ccPick() {
  if (CC !== null && CC !== '') return CC;
  return env('OMNI_CC');
}

/** 找一个可用的 C 编译器：tcc 最快，适合开发循环；clang/gcc 用于发布 */
let findCCMemo = '';
function findCC() {
  /* `--cc` 不进 memo：那一格是「这一趟」的话，而 memo 是进程级的
   * （同一条进程里 `build --plugins` 会连着编好几份，但它们同属这一趟）。 */
  const explicit = ccPick();
  if (explicit) return explicit;
  if (findCCMemo !== '') return findCCMemo;
  for (const cc of ['tcc', 'clang', 'gcc', 'cc']) {
    const r = spawn('which', [cc], 'c');
    if (r[0] === 0 && r[1].trim()) { findCCMemo = cc; return findCCMemo; }
  }
  throw new OmniError('no C compiler found (tried tcc, clang, gcc, cc; '
    + 'override with --cc or OMNI_CC)');
}

/**
 * **自带的那台 C 编译器是默认**（第一百四十一片）：生成的 C 交给我们自己那台 C 前端
 * （`omni c obj`）、再交给我们自己的链接器（`omni c link`）——一个外部 C 编译器都不借。
 *
 * 要走外部 cc 就明说：`--cc clang`（或 `tcc` / `gcc` / `cc` / 一条路径），也可以用
 * `OMNI_CC=clang` —— **`--cc` 比它优先**。`self` 那个值两处都还认，只是现在它就是缺省。
 *
 * 覆盖到哪儿：可执行文件、可重定位的 `.o`、插件那格共享库（`--shared`）。arm64 macOS 上
 * 共享库要补一句 `codesign -f -s -` 才 dlopen 得动（tcc 自己也喊，`tccmacho.c:2243`）。
 *
 * **代价是量出来的，摆在这儿**（arm64 macOS，同一份生成的 C；括号里是第一百四十二到
 * 一百四十五片那四刀之前的数）：
 *   核心产物   我们 35.4M（52.3M） /  clang 11.7M   —— 3.0x（曾 4.5x）
 *   `.text`（20 份运行时）我们 551488（880624） / tcc 310616 —— 1.78x（曾 2.85x）
 *   编译时间（进程内 20 份）冷 613ms / tcc 217ms   —— 2.8x（少发指令省下的，被多出来的
 *     引用计数与窥孔判断吃回去了；这一栏基本没动）
 * 剩下的差距还是「没有寄存器分配」那一类：**跨语句**的值仍旧过栈格 —— 缓存只在一段
 * 直线代码里成立（见 `arm64/from_mir.js` 的 `POOL`）。单条上已经追平：
 * `int add(int,int)` 我们 52 字节、tcc 60 字节。
 */
function selfCC() {
  const v = ccPick();
  return !v || v === 'self';
}

/**
 * 本机是哪个架构。与 `hostIsDarwin` 同一条路子（问一次 `uname` 记住）——
 * `process.arch` 不在封闭 ABI 里（ADR-0011 决策 2），这份源码要能被自己编译。
 */
let ARCH_CACHE = '';
function hostArch() {
  if (ARCH_CACHE === '') {
    const r = spawn('uname', ['-m'], 'c');
    const m = r[0] === 0 ? r[1].trim() : '';
    ARCH_CACHE = (m === 'arm64' || m === 'aarch64') ? 'arm64' : 'x86_64';
  }
  return ARCH_CACHE;
}

/**
 * 自带的那几份 sysroot 在 `src/sysroot/<arch>-<os>`：精简系统头 + `lib/*.def` 符号预设 +
 * 那一份自带 libc 的源码。`--sysroot` 不给时按目标取它（第一百四十六片）。
 *
 * 找法与插件那一格同一个路子（`installDir()` 往上数几层都试一遍）：从源码跑时
 * `installDir()` 是 `src/core/<某一格>`，装过之后层数可能少一层。
 *
 * 取不到**抛错**，不悄悄退回本机：交叉编译按本机的头编出来的东西，要到目标机器上跑
 * 才发现不对 —— 那笔账最贵。自带的是哪几个目标一并印出来。
 */
function bundledSysroot(tgt) {
  const name = `${tgt.arch}-${tgt.os}`;
  const dirs = [join(installDir(), '..', '..', 'sysroot'), join(installDir(), '..', 'sysroot')];
  for (const d of dirs) {
    const p = join(d, name);
    if (isDir(p)) return p;
  }
  const have = [];
  for (const d of dirs) {
    if (!isDir(d)) continue;
    for (const f of readDir(d)) if (f.includes('-') && isDir(join(d, f))) have.push(f);
  }
  throw new OmniError(`没有 ${name} 那一份 sysroot`
    + (have.length > 0 ? `（自带的有：${[...new Set(have)].sort().join('、')}）` : '')
    + ' —— 自己给一份：--sysroot DIR');
}

/**
 * 优化档。**默认 -O0**：这条腿在测试轴上的角色是"另一份语义实现"，不是性能基线，
 * 而 clang -O2 在这些几百行的翻译单元上就是纯粹的等待（量过：run-c 一次 0.42s -> 0.28s，
 * 五条腿 × 四十个用例乘起来就是半分钟）。要性能数字的场合显式开：`OMNI_OPT=2`。
 * 语义不因此改变 —— 逐个运算的语义靠的是下面那条 `-ffp-contract=off`，与档位无关。
 *
 * **三维那一档反过来：跑的时间远大于编的时间，而且档位是逐字节中性的**（2026-09-07 量的）。
 * pdb（119576 个三角）每趟 shipout 的 asy 层前置 / 解析 / 光栅：
 *   -O0   5.87s / 13.17s   0.82s   0.28s
 *   -O1   1.47s /  3.59s   0.38s   0.08s     ← 约 4 倍
 *   -O2   1.07s /  2.90s   0.36s   0.07s
 * 八个例子（sacylinder3D / splitpatch / twistedtubes / trefoilknot / hyperboloid /
 * filesurface / triangles / twoSpheres）在 -O1 上位图不同字节数与 -O0 **一个不差** ——
 * 有 `-ffp-contract=off` 兜着，档位不动浮点结果。代价是编译变慢（判据上一个例子
 * 3.1s→8.7s，全是 clang 的时间）。所以"默认哪一档"是按**例子的规模**分的两件事，
 * 要改默认值得先想清楚这一点（ADR 级）。
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
  // -pthread：入口可能跑在一条大栈的线程上（omni_run_entry），编译与链接两边都要这一位。
  // macOS 上 pthread 就在 libSystem 里、这个开关等于空操作；glibc 2.34 起也已并进 libc。
  return isTcc(cc) ? ['-I', RUNTIME_DIR]
    : [optFlag(), '-std=c99', '-ffp-contract=off', '-w', '-pthread', '-I', RUNTIME_DIR];
}

/**
 * 这台 cc 是 tcc 吗 —— 按**基名**认，不按整条命令认。
 *
 * 从前两处写的是 `cc === 'tcc'`，于是 `OMNI_CC=/…/.omni-cache/tcc-build/tcc`（指着一份
 * 自己编出来的 tcc，正是对照量它的时候要写的那一路）走的是 clang 那一支：
 * 量到的报错是 `tcc: error: unsupported linker option '-stack_size'`。
 * `tcc-x86_64`/`i386-tcc` 这种带前后缀的交叉名也按 tcc 算 —— 它们认的开关是同一套。
 */
function isTcc(cc) {
  const b = basename(cc);
  return b === 'tcc' || b.startsWith('tcc-') || b.endsWith('-tcc');
}

/**
 * **主线程的栈**（只在链接可执行文件时给）。macOS 上主线程栈的大小是链接期定死的
 * （默认 8MB），而 `omni_run_entry` 宁可留在主线程也不想开线程 —— 因为 AppKit 只能在
 * 真主线程上首次初始化（GLFW 的 `glfwInit` 一进去就是它），挪到别的线程上是一个
 * 没有任何输出的 SIGTRAP（ADR-0022 J4d 量的）。给到 512MB，两个条件就一起满足了：
 * 栈够深（编译器自己那条递归要它）+ 还在主线程上。
 *
 * 只保留地址空间，页用到才落地。Linux 上主线程栈按 `ulimit -s` 动态长，链接期没有
 * 这个开关，也不需要 —— 那边的 GUI 库不挑线程；`omni_run_entry` 自己会去问
 * `getrlimit`，不够大就照旧开线程。tcc 不认这个 `-Wl,`，那条腿走线程回退。
 *
 * 平台从 `uname -s` 来而不是 `process.platform`：这份源码要能被自己编译，而
 * `process.platform` 不在封闭 ABI 里（ADR-0011 决策 2）。问一次 `uname` 记住 ——
 * 和 `jobCount()` 问 `getconf` 是同一条路子。
 */
let DARWIN_CACHE = 0;
function hostIsDarwin() {
  if (DARWIN_CACHE === 0) {
    const r = spawn('uname', ['-s'], 'c');
    DARWIN_CACHE = (r[0] === 0 && r[1].trim() === 'Darwin') ? 1 : 2;
  }
  return DARWIN_CACHE === 1;
}

/**
 * 本机的操作系统名（我们这套目标名字：`osx` / `linux` / `win32`）与目标文件格式。
 *
 * **为什么要有这两格**（第一百四十七片）：`omni c obj|link|cpp|tcc` 那一组的
 * `--arch` / `--os` 默认值从前写死是 `arm64` + `osx`（`macho`）—— 那是写这几条命令时
 * 手边那台机器。在 x86_64 Linux 上不给开关就等于**默认交叉编译到 macOS**：出来的 `.o`
 * 是 Mach-O，本机的 clang / ld 一律不认，而错误信息（"file format not recognized"）
 * 离真正的原因隔着两层。默认值应当是「这台机器」，交叉编译才是要明说的那一路。
 *
 * `uname -s` 认不出来的（MSYS 那一族印 `MINGW64_NT-…`、Cygwin 印 `CYGWIN_NT-…`）
 * 归到 `win32`；`uname` 本身跑不起来（真 Windows 的 cmd）也归它 —— 那三家里
 * 只有 Windows 会让 `uname` 缺席。
 */
let OS_CACHE = '';
function hostOs() {
  if (OS_CACHE === '') {
    const r = spawn('uname', ['-s'], 'c');
    const s = r[0] === 0 ? r[1].trim() : '';
    if (s === 'Darwin') OS_CACHE = 'osx';
    else if (s === 'Linux') OS_CACHE = 'linux';
    else OS_CACHE = 'win32';
  }
  return OS_CACHE;
}

/** 一个目标名 -> 目标文件格式。`osx` 是 Mach-O、`win32` 是 PE、其余（linux）是 ELF。 */
function fmtOfOs(os) {
  if (os === 'osx') return 'macho';
  if (os === 'win32') return 'pe';
  return 'elf';
}

/**
 * 共享库在这个平台上的后缀。**插件的文件名按它拼**（`omni plugins` 与自举链两处都是）。
 *
 * 为什么值得单独一格：从前那个名字写死 `.dylib`，而链接时「加不加 Mach-O 那两个开关」
 * 又是**看名字**决定的 —— 于是 Linux 上 `OMNI_CC=gcc` 编插件时把 `-undefined
 * dynamic_lookup` 递给了 GNU ld，报的是 `cannot find dynamic_lookup: No such file or
 * directory`（它把 `dynamic_lookup` 当成了一份输入文件）。名字与开关都该问平台。
 */
function dsoExt(os) {
  if (os === 'osx') return '.dylib';
  if (os === 'win32') return '.dll';
  return '.so';
}

function mainStackFlags(cc) {
  if (isTcc(cc) || !hostIsDarwin()) return [];
  return ['-Wl,-stack_size,0x20000000'];
}

/**
 * 源码里 `(lib …)` 说的那些库，摆到**链接命令**上（ADR-0022 的 J4c/J4d）。
 *
 * JIT 那条腿走的是 `--lib`/`--dl`（`runViaJit`），AOT 这两条（`run-llvm` 的产物与 C 后端的
 * 产物）走的就是这儿 —— 少了它，一个 `import "…/libglfw.dylib"` 的程序在 AOT 上是一串
 * undefined symbol，而 JIT 上跑得好好的。同一份源码在两条腿上要么都行要么都不行，
 * 这种不对称本身就是错。
 *
 * 预登记的系统库按表走（`libm` -> `-lm`，`libc` 什么都不加）；表外的当**路径**，原样写上去
 * （`.dylib`/`.so` 直接给链接器，与 `dlopen` 那侧写的是同一个文件）。
 */
function libLinkArgs(libs) {
  const out = [];
  const seen = new Set();
  for (const raw of libs ?? []) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const l = resolveLib(raw);
    const sys = cSysLib(l);
    if (sys !== null) {
      if (sys.link !== null) out.push(sys.link);
      continue;
    }
    /* macOS 的 **framework**：`(lib "OpenGL.framework")` -> `-framework OpenGL`。
       为什么要单列这一格：GL 的符号不在 libglfw 里，而在 OpenGL.framework 里，而那个
       framework 的二进制**在 dyld 的共享缓存里、磁盘上没有那个文件** —— 把路径原样交给
       链接器是链不上的（JIT 那侧 dlopen 反而行，见 `frameworkPath`）。 */
    if (l.endsWith('.framework')) {
      if (!hostIsDarwin()) {
        throw new OmniError(`(lib "${l}")：framework 是 macOS 的东西，这台机器不是`);
      }
      out.push('-framework');
      out.push(l.slice(0, l.length - '.framework'.length));
      continue;
    }
    out.push(l);
  }
  return out;
}

/**
 * 同一份 `(lib …)`，摆到**我们自己那台链接器**的命令行上（`omni c link`）。
 *
 * 与 `libLinkArgs`（外部 cc 那一路）差的只有"怎么说"：`c link` 的位置实参是**目标文件**，
 * 所以库不能原样写上去（会报 `elf: 这不是一个 ELF 文件`），要过 `--dylib`；
 * framework 走 `-framework`（那一支自己去 SDK 里找 `.tbd` stub）。
 *
 * 为什么要这一份而不是让 `c link` 也认裸路径：位置实参的含义**只能有一个** ——
 * 目标文件与库混在一处，"这份 `.o` 写错了扩展名"与"这份库不是这个架构"就分不出来了。
 */
function selfLibArgs(libs) {
  const out = [];
  const seen = new Set();
  for (const raw of libs ?? []) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const l = resolveLib(raw);
    const sys = cSysLib(l);
    if (sys !== null) {
      if (sys.link !== null) out.push(sys.link);
      continue;
    }
    if (l.endsWith('.framework')) {
      if (!hostIsDarwin()) {
        throw new OmniError(`(lib "${l}")：framework 是 macOS 的东西，这台机器不是`);
      }
      out.push('-framework');
      out.push(l.slice(0, l.length - '.framework'.length));
      continue;
    }
    out.push('--dylib');
    out.push(l);
  }
  return out;
}

/** `Foo.framework` 在磁盘上的那个二进制（JIT 那侧 `dlopen` 要一个路径）。 */
function frameworkPath(l) {
  const n = l.slice(0, l.length - '.framework'.length);
  return `/System/Library/Frameworks/${n}.framework/${n}`;
}

/** `(lib "libomnigo")` 这个**逻辑名**（并发那一档，见 `goLib`）。 */
const GO_LIB_NAME = 'libomnigo';

/**
 * **并发那一档的动态库**（`libomnigo`）：G/M/P 调度器 + channel + `go f(x)` 的门面。
 *
 * 与 `glPlugin` 差两处，都是有意的：
 *   - 这一格**编不出来就是硬错误**。GL 那边找不到库回落 CPU 光栅器（答案一样、只是慢），
 *     而一个 `go f()` 的程序没有调度器**没有回落** —— 悄悄同步跑就是错答案。
 *   - 它是源码里 `(lib "libomnigo")` 指的那个库，所以不走 dlopen 的默认路径，
 *     而是由 `resolveLib` 把这个**逻辑名**换成下面这个绝对路径（emit 的时候还不知道
 *     缓存目录在哪儿，所以名字必须是机器无关的）。
 *
 * 缓存键 = 那几份源码的 mtime/大小 + 编译器，产物落在 `.omni-cache/go/<key>/`。
 */
function goLib() {
  if (!isDir(SCHED_DIR)) throw new OmniError(`(lib "${GO_LIB_NAME}")：找不到 ${SCHED_DIR}`);
  const srcs = ['omni_sched.c', 'omni_chan.c', 'omni_go.c'].map((f) => join(SCHED_DIR, f));
  const hdrs = ['omni_sched.h', 'omni_chan.h', 'omni_go.h', 'omni_atomic.h']
    .map((f) => join(SCHED_DIR, f));
  for (const f of [...srcs, ...hdrs]) {
    if (!exists(f)) throw new OmniError(`(lib "${GO_LIB_NAME}")：缺 ${f}`);
  }
  const cc = findClang();
  const ext = hostIsDarwin() ? 'dylib' : 'so';
  const key = hash16([cc, ext, ...[...srcs, ...hdrs]
    .map((f) => `${f}:${mtimeMs(f)}:${fileSize(f)}`)].join('|'));
  const dir = join(cacheRoot(), 'go', key);
  const lib = join(dir, `${GO_LIB_NAME}.${ext}`);
  if (exists(lib)) return lib;
  const stage = workDirFor('go-stage', key);
  const staged = join(stage, `${GO_LIB_NAME}.${ext}`);
  /* **`-install_name` 要写成"落定之后"那个路径**（量出来的）：macOS 默认把 `-o` 的
     那个路径写进库自己的 `LC_ID_DYLIB`，于是链上它的程序一跑就是
     `Library not loaded: …/work/go-stage-…/libomnigo.dylib` —— 暖存盘用完就没了。
     GL 那条腿不撞这一格是因为它走 dlopen（按路径装），不进链接命令。 */
  const r = spawn(cc, ['-O2', '-w', hostIsDarwin() ? '-dynamiclib' : '-shared',
    ...(hostIsDarwin() ? ['-install_name', lib] : []),
    '-fPIC', '-o', staged, ...srcs, '-I', SCHED_DIR, '-lpthread'], 'c');
  if (r[0] !== 0) {
    throw new OmniError(`(lib "${GO_LIB_NAME}")：${cc} 编不过并发那一档的运行时`);
  }
  mkdirAll(join(cacheRoot(), 'go'));
  if (!exists(dir)) rename(stage, dir);
  const got = exists(lib) ? lib : staged;
  vStep(`go rt     ${got}`);
  return got;
}

/**
 * 一句 `(lib …)` 里的名字**落到这台机器上的那个东西**。
 *
 * 今天只有一格要换：`libomnigo` 是**我们自己的**运行时，它的路径是缓存目录里算出来的，
 * 而 emit 的那一刻还不知道（产物要机器无关，不然一份 `.sx` 换台机器就链不上）。
 * 别的名字原样回 —— 预登记的系统库与 framework 各有各的那一支，在下面几处认。
 */
function resolveLib(l) { return l === GO_LIB_NAME ? goLib() : l; }

/**
 * 三维那一档的 **OpenGL 后端插件**（`libomnigl`）。照 asy 自己的分法：它的
 * `libasyopengl.so` / `libasyvulkan.so` 也是运行期 dlopen 的（rendererloader.cc），
 * 拿不到就回落。所以这一格**只是"顺手编一下"，编不出来不算错** ——
 * `omni_r3.c` 那侧找不到库就走 CPU 光栅器。
 *
 * 为什么不并进 `runtimeObjects()`：那一堆是所有腿共用、连 tcc 也要编的，而这一份要
 * `-framework OpenGL`。混在一起就等于让 tcc 那条腿也依赖 GL（二进制对齐那把尺子会当场断）。
 *
 * 缓存键 = 源码的 mtime/大小 + 编译器；产物落在 `.omni-cache/gl/<key>/libomnigl.dylib`，
 * 路径**绝对**（子进程的 cwd 不一定是仓库根，相对路径 dlopen 会静默失败）。
 * 回 null = 这台机器上没有这条腿（不是 macOS、没源码、或者编不过）。
 */
function glPlugin() {
  // macOS 之外还没有实现（上下文那一段是 CGL）。判据用框架目录，不新增宿主 ABI。
  if (!exists('/System/Library/Frameworks/OpenGL.framework')) return null;
  if (!isDir(GL_DIR)) return null;
  const src = join(GL_DIR, 'omni_r3_gl.c');
  const hdr = join(GL_DIR, 'omni_gl.h');
  if (!exists(src) || !exists(hdr)) return null;
  const cc = findClang();
  const key = hash16([cc, `${mtimeMs(src)}:${fileSize(src)}`,
    `${mtimeMs(hdr)}:${fileSize(hdr)}`].join('|'));
  const dir = join(cacheRoot(), 'gl', key);
  const lib = join(dir, 'libomnigl.dylib');
  if (exists(lib)) return lib;
  const stage = workDirFor('gl-stage', key);
  const staged = join(stage, 'libomnigl.dylib');
  const r = spawn(cc, ['-O2', '-w', '-dynamiclib', '-o', staged, src,
    '-I', GL_DIR, '-framework', 'OpenGL'], 'c');
  if (r[0] !== 0) {
    vStep(`gl plugin  ${cc} 编不过，这一趟走 CPU 光栅器`);
    return null;
  }
  mkdirAll(join(cacheRoot(), 'gl'));
  if (!exists(dir)) rename(stage, dir);
  vStep(`gl plugin  ${exists(lib) ? lib : staged}`);
  return exists(lib) ? lib : staged;
}

/**
 * 作业数。`OMNI_JOBS` 覆盖（1 = 退回串行），否则问 `getconf` 拿在线核数，上限 16。
 * 问不出来就 4 —— 猜一个小的比猜一个大的安全（作业数超了核数只会互相抢）。
 */
let JOBS_CACHE = 0;
function jobCount() {
  if (JOBS_CACHE !== 0) return JOBS_CACHE;
  const o = env('OMNI_JOBS');
  if (o !== undefined && o !== '') {
    const n = Number(o);
    JOBS_CACHE = Number.isInteger(n) && n > 0 ? n : 1;
    return JOBS_CACHE;
  }
  const r = spawn('getconf', ['_NPROCESSORS_ONLN'], 'c');
  const n = r[0] === 0 ? Number(String(r[1]).trim()) : 0;
  JOBS_CACHE = Number.isInteger(n) && n > 0 ? (n > 16 ? 16 : n) : 4;
  return JOBS_CACHE;
}

/** sh 的单引号引法：把每个 `'` 换成 `'\''`，别的原样 —— 路径里有空格、`$`、`?` 都不怕。 */
function shQuote(s) {
  return `'${String(s).split("'").join("'\\''")}'`;
}

/**
 * 并行跑一批命令，等它们全都结束。回一条与入参同序的 `[status, out, out]`
 * （形状与 `spawn` 一致，两个流合在一起 —— 调用方要的是"哪一条挂了、它说了什么"）。
 *
 * **为什么不加宿主原语**：`spawn` 是同步的（node 那侧是 `spawnSync`），而 node 没有
 * "同步等多个"这一格。要么把整条 CLI 变成 async（那会传染到每一处），要么另开一个宿主 ABI
 * 再在两个宿主上各写一份、然后在错误归属上分叉。这儿走第三条：**生成一个 sh 脚本**，
 * 里头是 `cmd & cmd & wait`，每个作业把退出码写进自己的 rc 文件、两个流写进自己的 log。
 * 于是两个宿主共用同一份实现（都只是 `spawn` 一次 `/bin/sh`），没有可分叉的地方。
 *
 * **一批一批而不是一个池**：`wait -n` 要 bash 4.3，而 macOS 的 `/bin/sh` 是 bash 3.2；
 * `xargs -P` 又得在引号上玩花样。一批 N 个、批内并行、批间串行 —— 打包比真池差一点，
 * 可是 POSIX、可预测，而且这儿每个作业的耗时本来就在同一个量级。
 */
function spawnPar(jobs) {
  const n = jobCount();
  if (n <= 1 || jobs.length <= 1) {
    return jobs.map((j) => spawn(j[0], j.slice(1), 'c'));
  }
  /* 一批命令的 rc 与日志是**一次性**的：从前拿 `hash16(时刻)` 当键，于是每跑一趟
     多一个永不命中的目录。现在是暂存目录（进程号命名、建之前清空），末尾扔掉。 */
  const dir = scratchDir('par');
  const lines = ['#!/bin/sh'];
  for (let i = 0; i < jobs.length; i += n) {
    for (let k = i; k < jobs.length && k < i + n; k++) {
      const cmd = jobs[k].map(shQuote).join(' ');
      const log = shQuote(join(dir, `o${k}`));
      const rc = shQuote(join(dir, `r${k}`));
      lines.push(`{ ${cmd} > ${log} 2>&1; echo $? > ${rc}; } &`);
    }
    lines.push('wait');
  }
  const sh = join(dir, 'run.sh');
  writeText(sh, `${lines.join('\n')}\n`);
  const r = spawn('/bin/sh', [sh], 'c');
  const out = jobs.map((_, k) => {
    const rc = join(dir, `r${k}`);
    const log = join(dir, `o${k}`);
    // rc 文件不在 = 那一格根本没跑起来（sh 自己都没起来）：把 sh 的话交出去
    if (!exists(rc)) return [r[0] === 0 ? 1 : r[0], r[1], r[2]];
    const text = exists(log) ? readText(log) : '';
    return [Number(readText(rc).trim()), text, text];
  });
  /* 读完就扔：这一格是暂存，留着没有任何人会去看（而攒起来是 518 MB 的那半个来处）。 */
  dropScratch(dir);
  return out;
}

/**
 * 运行时的 .o 缓存。不缓存就是每次 build 都重编 8 个翻译单元：实测 757ms -> 73ms，10 倍。
 * 自举时编译器要反复重建自己，这条直接决定开发循环还能不能用。
 * 缓存键 = 编译器 + flags + 运行时目录下每个 .c/.h 的 mtime 与大小（改 omni.h 会让全部失效）。
 *
 * 未命中那一路**并行编**：20 个翻译单元串行量出来 3.0s，而它们互相无关。
 * 改运行时头文件时全表失效，所以这一路在开发循环里天天走。
 */
/**
 * 运行时那几十份源码的**内容**印记。
 *
 * 为什么是内容而不是 `mtime:size`（这一条是量出来的，两处 `runtimeObjects*` 共用）：
 * `RUNTIME_DIR` 在两种布局里是**两个目录** —— node 那条腿看 `src/runtime`，
 * `dist/omni` 看 `dist/share/runtime`（`build` 把源码抄过去，抄出来的 mtime 是新的）。
 * 于是 `mtime:size` 让两条腿的 key 永远不同：`npm run build:native` 刚编好的那 21 个
 * `.o` 明明就在 `.omni-cache/rt` 里，`dist/omni run` 也看同一个根，却一格都命中不了，
 * 只好自己重编 —— 每格约 2s，21 格四十多秒，任何 `--timeout` 都撑不住。
 * 内容相同就是同一份编译输入，所以印记只认字节。代价是每趟多读约 1 MB（几毫秒）。
 */
function runtimeDeps() {
  return readDir(RUNTIME_DIR).filter((f) => /\.[ch]$/.test(f)).sort()
    .map((f) => `${f}:${hash16(readText(join(RUNTIME_DIR, f)))}`);
}

function runtimeObjects(cc) {
  const flags = ccFlags(cc);
  const srcs = runtimeSources();
  const deps = runtimeDeps();
  const key = hash16([cc, ...flags, ...deps].join('|'));
  const dir = join(cacheRoot(), 'rt', key);
  const objs = srcs.map((p) => join(dir, `${basename(p, '.c')}.o`));
  if (objs.every((o) => exists(o))) {
    vStep(`runtime .o  ${objs.length} objects, cache hit ${dir}`);
    return objs;
  }

  // 先编进暂存目录再整体 rename：中断不会留下半个缓存
  // **每个进程自己一个暂存目录**（`scratchDir` 按进程号命名）：同一刻两个进程各建各的，
  // 不会撞文件名；而且用完就扔 —— 从前那个时间戳键每趟留一个目录（task #55 的后半截）。
  const stage = scratchDir('rt-stage');
  const staged = srcs.map((p) => join(stage, `${basename(p, '.c')}.o`));
  const rs = spawnPar(srcs.map((p, i) => [cc, ...flags, '-c', '-o', staged[i], p]));
  for (let i = 0; i < rs.length; i++) {
    if (rs[i][0] !== 0) {
      throw new OmniError(`omni runtime failed to compile with ${cc}:\n${rs[i][2]}`);
    }
  }
  // 目标已存在 = 别人先建好了，下面那句会用它（rename 到一个非空目录在两个宿主上都是硬错，
  // 而宿主的错误不是可以 catch 的异常，所以先看一眼）。父目录得先在，rename 才有地方落。
  mkdirAll(join(cacheRoot(), 'rt'));
  let kept = staged;
  if (!exists(dir)) rename(stage, dir);
  vStep(`runtime .o  ${srcs.length} objects compiled with ${cc}, ${jobCount()} jobs`);
  if (objs.every((o) => exists(o))) {
    /* 缓存那一份已经落地 -> 暂存里剩下的没人要了（`rename` 成功时它已经不在了，
       这一句管的是"别人先建好了"那一路）。 */
    dropScratch(stage);
    kept = objs;
  }
  return kept;
}

/**
 * 同一件事，**用我们自己那台 C 前端编**（`OMNI_CC=self`，第一百三十七片）。
 *
 * 与上面那一份的差别只有两处：编的人（`cObj` 而不是 spawn 外部 cc）与容器
 * （**ELF**：`omni c link` 读 ELF 目标文件、写 macho/pe，见 `omni c link --help`）。
 * 缓存的键里带上 `self` 与目标，所以两条路的 `.o` 各占一格、不会互相盖。
 *
 * 不并行：`cObj` 是本进程里的一趟编译（不是子进程），并行要另一台机器（`spawnPar`
 * 摆的是命令行）。量出来的代价是二十份 runtime 一趟 6.8s —— 缓存命中之后是 0。
 */
function runtimeObjectsSelf(arch, os) {
  const srcs = runtimeSources();
  const deps = runtimeDeps();
  const key = hash16(['self', arch, os, CROSS === null ? '' : CROSS.sysroot, ...deps].join('|'));
  const dir = join(cacheRoot(), 'rt', key);
  const objs = srcs.map((p) => join(dir, `${basename(p, '.c')}.o`));
  if (objs.every((o) => exists(o))) {
    vStep(`runtime .o  ${objs.length} objects, cache hit ${dir}`);
    return objs;
  }
  /* **一格一格地搬进暖存**，不是等 21 格全编完再整目录 rename 一次。
   *
   * 从前是后者，那就有一个不会自己好的坑：这 21 格过我们自己那台 C 前端每格约 2s，
   * 一共四十几秒；只要这一趟被 `--timeout` 掐掉（或者被 Ctrl-C、被 OOM 杀掉），
   * `rename` 就没走到，**已经编好的几格全扔了**。下一趟从零开始，再掐掉，再从零开始 ——
   * 在外面看就是"这条命令永远跑不完"，而且加大 timeout 也治不了（第一趟就得撑满全程）。
   * 量出来的：同一个 `OMNI_CACHE_DIR` 连跑三趟 `--timeout 10`，每趟都只到第 5 个 `.o`。
   *
   * 改成逐格 rename 之后：每一趟都把自己挣到的那几格留下，下一趟接着往后编（上面那句
   * `exists(objs[i])` 就是接力棒），几趟之后自然收敛；之后所有趟都走 cache hit。
   * 同一个卷上的 rename 是原子的，所以别的进程要么看见完整的 `.o`、要么看不见 ——
   * 顺带把「整目录 rename 的并发竞态」也一起消了。 */
  mkdirAll(dir);
  const stage = scratchDir('rt-stage-self');
  /* 交叉编译那一趟的头也从 sysroot 里取（与 `buildSelf` 同一格状态）。 */
  const sysIncs = CROSS === null ? undefined : sysIncDirs(['--sysroot', CROSS.sysroot]);
  let made = 0;
  for (let i = 0; i < srcs.length; i++) {
    if (exists(objs[i])) continue;   // 上一趟（也许被掐掉了）留下的，接着往下编
    const tmp = join(stage, `${basename(srcs[i], '.c')}.o`);
    const t0 = nowMs();
    cObj(srcs[i], tmp, arch, [RUNTIME_DIR], [], 'elf', os, sysIncs);
    rename(tmp, objs[i]);
    made++;
    /* **一格一行**。这一段从前一个字都不印：`buildSelf` 里那句 `c obj` 印的是**用户
       那一份**，运行时这 21 格走的是 cObj 自己（它不 vStep），而本函数的 vStep 在循环
       之后。于是 `-v` 看到的是"c obj 用户文件 [1994ms]"然后**四十秒的静默**，最后
       `超时`。那副样子指向"卡在某个没输出的地方"，谁看都会先去猜死循环。 */
    vStep(`runtime .o  [${i + 1}/${srcs.length}] ${basename(srcs[i])} -> ${fileSize(objs[i])} bytes`
      + `  ${Math.round(nowMs() - t0)}ms`);
  }
  vStep(`runtime .o  ${srcs.length} objects（这一趟编了 ${made} 格）`
    + '，用我们自己那台 C 前端');
  dropScratch(stage);           // 每格都 rename 走了，这儿只剩一个空目录
  return objs;
}

/**
 * workDir 给的时候，生成的 .c 就留在那里（名字跟着产物走）——
 * `omni bootstrap` 与 `build --work DIR` 要的是"中间产物留在构建目录里"：链断在哪一代
 * 都能直接翻出那份 C 来看。不给的时候落在 `.omni-cache/work/c-<产物名>` 底下，
 * 名字是确定的（从前是 /var/folders 里一个随机名，出了问题捞不着）。
 */
function buildNative(mod, outPath, workDir, plugin, extern, own, bind) {
  const dir = workDir === undefined ? workDirFor('c', workName(outPath)) : workDir;
  if (workDir !== undefined) mkdirAll(dir);
  /* 产物所在的目录得先有 —— `build -o dist/omni` 是**默认**的写法，而 dist 可能刚被删掉；
     不建的话 ld 报的是 `open() failed, errno=2 for 'dist/omni'`（量到过），
     那句话把人往"编译器坏了"上带。 */
  mkdirAll(dirname(outPath));
  const cPath = join(dir, `${basename(outPath)}.c`);
  const tGen0 = nowMs();
  const { text: cText, stats, syms } = cap('cgen.stats')(mod, {
    plugin: plugin, extern: extern === true, own: own === undefined ? null : own,
    bind: bind === undefined ? null : bind,
    /* `--profile stub`：发射期插的那一对计时（`profTable`）。别的两档不动生成的 C ——
     * `cc` 那一档是编译器自己插，`sample` 那一档一个字节都不改。 */
    profile: PROF !== null && PROF.mode === 'stub',
  });
  writeText(cPath, cText);
  /* `--stat` 要「每个模块发了多少 C」，而那份分布只有这儿有（cgen 回的）。摆成一格状态
   * 而不是改三处返回值：`buildNative` 有两条出口（self / 外部 cc），`buildSelf` 又是一条 ——
   * 加一格状态改一处，改返回形状要改三处。 */
  LAST_CGEN_STATS = stats;
  const tGen = nowMs() - tGen0;
  LAST_EMIT_BYTES = cText.length;
  /* C 腿上「按源码长起来的那一段」= cgen 那份按源文件的产出分布之和（总字节减掉它
   * 就是共用的那几样：字面量池、容器实例化、成员派发器、内联的运行时）。 */
  {
    let sum = 0;
    for (const r of stats.values()) sum += r.bytes;
    LAST_EMIT_PROG = sum;
  }
  vStep(`backend c  ${cText.length} bytes -> ${cPath}`);
  vStats(cText, stats);
  const libs = cAbiLibs(mod.cabi ?? []).map((l) => `-l${l}`);
  /* **自带的那台 C 编译器是默认**（第一百四十一片）：生成的 C 交给我们自己的 C 前端 +
   * 链接器，一个外部 cc 都不借。要走外部 cc 就给 `OMNI_CC=clang`（或 tcc/gcc/cc/路径）。
   * 岔口只有这一处，摆在 `libs` 之后、外部 cc 那一串开关之前。
   *
   * **`(lib …)` 那几格也要递下去**（llvm 轴的 glfw-tri @ run-c 那两格红）：从前只递了
   * `libs`（cabi 那一族的 `-lm` 之类），而源码里 `(lib "…/libglfw.dylib")` 与
   * `(lib "OpenGL.framework")` 说的那些**一格都没到我们的链接器**——于是同一份源码
   * 在 clang 那一支链得上、在我们自己这一支是一串 undefined symbol。两条腿不对称本身就是错
   * （`libLinkArgs` 头上那段注释说的正是这件事，只是那时只落在外部 cc 那一路上）。
   * 摆到命令行上的说法两支不同，见 `selfLibArgs`。 */
  if (selfCC()) {
    return buildSelf(mod, outPath, cPath, plugin, [...libs, ...selfLibArgs(mod.libs)],
      cText, tGen, extern, syms);
  }
  const cc = findCC();
  /* 插件是一格动态库，两处与可执行文件不同：
   *   - **不链运行时的 .o**：状态住在核心里（ADR-0021 的 S1），链进自己那一份就等于自带
   *     一套 realm / xprops / this 槽 —— 那正是要避开的坑。符号靠动态解析过去。
   *   - 平台看**这台机器**（`hostOs()`），不看输出的名字：Mach-O 默认不许留未定义符号，
   *     所以要 `-undefined dynamic_lookup`；ELF 留着就行。从前这一格问的是「名字是不是
   *     以 .dylib 结尾」—— 而那个名字从前在 Linux 上也是 `.dylib`，于是 `OMNI_CC=gcc`
   *     那一趟把 ld64 的开关递给了 GNU ld：`cannot find dynamic_lookup: No such file
   *     or directory`（它把开关的值当成输入文件了）。 */
  const shared = ['-fPIC', '-shared']
    .concat(hostOs() === 'osx' ? ['-undefined', 'dynamic_lookup'] : []);
  /* `--extern` 的可执行文件要把符号**导出**给插件解析（否则插件只能自带一份）：
     macOS / Linux 的 clang 都认 -Wl,-export_dynamic。 */
  const ex = extern === true ? ['-Wl,-export_dynamic'] : [];
  const cargs = plugin === undefined
    ? [...ccFlags(cc), ...mainStackFlags(cc), ...ex,
      /* `--profile cc`：编译器自己插桩。只给**生成的那一份 `.c`**——运行时自己不被插，
       * 否则 `clock_gettime` 那一对桩就计进去了，量出来的全是插桩自己（3.2 亿次调用 7.9s，
       * emit.js 里那段注释的原话）。`-finstrument-functions` 是 gcc 与 clang 都有的
       * 跨平台机制（Darwin 上 `-pg`/gprof 早就不出 `gmon.out` 了）。 */
      ...(PROF !== null && PROF.mode === 'cc' ? ['-finstrument-functions'] : []),
      cPath, ...runtimeObjects(cc),
      '-o', outPath, '-lm', ...libs, ...libLinkArgs(mod.libs)]
    : [...ccFlags(cc), ...shared, cPath, '-o', outPath, ...libs, ...libLinkArgs(mod.libs)];
  const tCc0 = nowMs();
  const r = spawn(cc, cargs, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`C backend produced code that ${cc} rejected:\n${r[2]}\n(kept at ${cPath})`);
  }
  vStep(`${cc}  ${cargs.length} args -> ${outPath}  ${fileSize(outPath)} bytes`);
  /* 这一份记进流水账（核心一档、插件一档，收尾时 vTally 印）。 */
  tally(basename(outPath), plugin !== undefined, cText, fileSize(outPath), tGen, nowMs() - tCc0);
  /* `--extern` 的产物旁边落一份 `.syms`：**这一份实际留下了哪些符号**。
     插件构建拿 `--bind <它>`，于是"核心有的绑过去、没有的自己发"是查表而不是猜 ——
     核心是按根剪过枝的，剪掉了什么只有它自己知道（见 emit.js 那格 bind 的注释）。 */
  if (extern === true) {
    writeText(`${outPath}.syms`, `${syms.join('\n')}\n`);
    vStep(`syms  ${syms.length} 个符号 -> ${outPath}.syms`);
  }
  return { cPath, cc };
}

/**
 * `OMNI_CC=self` 那一路（第一百三十七片）：生成的 C -> **我们自己那台 C 前端**的 `.o`
 * -> **我们自己的链接器**的可执行文件。一个外部 C 编译器都不借。
 *
 * 三条与外部 cc 那一路不同的地方，都是量出来的：
 *
 *   - 目标文件的容器是 **ELF**（`omni c link` 读 ELF、写 macho/pe）。按 macho 编的 `.o`
 *     交给它，报的是「macho: 还不会给 0 号架构写可执行文件」—— 那个 0 是把 Mach-O 的头
 *     当 ELF 的 `e_machine` 读出来的。
 *   - 链接要 `-lc -L <SDK>/usr/lib`（macOS 上 `__error` 一族在 libSystem 里），
 *     这一格与 `omni build x.c` 共用 `cDefaultLibs`。
 *   - 执行位得自己补（我们自己写字节，没有 `chmod 0777` 那一步）。
 *
 * 插件（`.dylib`/`.so`）也走这儿（第一百三十八片）：链接器早就有 `--shared` 那一格
 * （macho_exe 的 MH_DYLIB / elf_exe 的 ET_DYN），缺的只是这条路上没接过来。接法是三样：
 * `--shared`、**不链运行时的 .o**、`--install-name <基名>`（`LC_ID_DYLIB`）。
 * 少一句 `codesign -f -s -` 就 `dlopen` 不动 —— 量到的原话是
 * `missing code signature in <no uuid> '…/omni-lang-c.dylib'`；签名不属于链接器，
 * tcc 自己也是链完 `system("codesign …")`。可执行文件不签也跑得动，只有 dylib 非签不可。
 *
 * **「self 出的核心 + cc 出的插件」量过了**：装得上、跑得对。`--extern` 在外部 cc 上靠
 * `-Wl,-export_dynamic` 把符号导给插件 `dlopen` 解析，我们的链接器没有那个开关 ——
 * 而事实是不需要：Mach-O 的可执行文件里那些**非局部符号本来就在符号表里**，
 * 平坦命名空间的 `dlopen` 查得到。判据（同一份源码，两边分别建）：
 *
 *   `OMNI_CC=self omni build src/cli.js --extern -o dist/omni` + `npm run build:native`
 *   出的 `dist/plugins` 摆在一起 -> `omni run tests/cases/01_basics.omni` 与解释器逐字节相同
 *
 * 一处**与本改动无关的粗糙边**顺手量到了：那个二进制放在 `/tmp/sd/omni` 这种
 * 「上面没有几层目录」的地方时，`.omni-cache` 会被解析到 `/`，报
 * `cannot mkdir '/.omni-cache': Read-only file system` —— 摆成 `…/repo/dist/omni`
 * （与 `dist` 同形）就好。那是 `installDir` 那条「往上数几层」的规矩，不是这一路的事。
 */
function buildSelf(mod, outPath, cPath, plugin, libs, cText, tGen, extern, syms) {
  /* 交叉编译（`--sysroot`）那一趟：目标由 `CROSS` 说，头与库都从 sysroot 里取；
   * 本机那一趟一个字不变。 */
  const arch = CROSS === null ? hostArch() : CROSS.arch;
  const os = CROSS === null ? (hostIsDarwin() ? 'osx' : 'linux') : CROSS.os;
  const fmt = fmtOfOs(os);
  const sysIncs = CROSS === null ? undefined : sysIncDirs(['--sysroot', CROSS.sysroot]);
  const sysArgs = [
    ...(CROSS === null ? [] : ['--sysroot', CROSS.sysroot]),
    /* `--libc self` 也要递下去（第一百四十片）：那次 `c link` 是**这儿**发的，
     * 而「链哪一份 libc」是链接那一步的事 —— 与 `--sysroot` 同一条路。 */
    ...(LIBC === null ? [] : ['--libc', LIBC]),
  ];
  const t0 = nowMs();
  const obj = `${cPath}.o`;
  /* `--profile cc` 那一趟：**生成的这一份**要插桩（第一百五十片第三格）。运行时那二十份
   * 走 `runtimeObjectsSelf`，一份都不插 —— 收集器（`omni_prof.c`）也在里头，插它就是栈爆。 */
  cObj(cPath, obj, arch, [RUNTIME_DIR], [], 'elf', os, sysIncs,
    PROF !== null && PROF.mode === 'cc');
  vStep(`c obj（我们自己那台 C 前端）  ${cPath} -> ${obj}  ${fileSize(obj)} bytes`);
  /* 插件与可执行文件在链接这一步只差三样：`--shared`、**不链运行时的 .o**（状态住在核心里，
   * ADR-0021 的 S1）、以及**那个库自己的名字**（Mach-O 是 `--install-name` 写 `LC_ID_DYLIB`，
   * 不给这一格 macho_exe 会喊「造 dylib 要知道输出的文件名」；ELF 是 `--soname` 写
   * `DT_SONAME` —— 两个格式各认自己那一个，给错的那个会被静静地忽略）。核心里那些符号
   * 留成未定义 —— 造共享库时 `relocate_syms` 那道筛子整个撤掉（`tccelf.c`：
   * `|| s1->output_type != TCC_OUTPUT_EXE`），由 `dlopen` 在平坦命名空间里解析。 */
  const rt = plugin === undefined ? runtimeObjectsSelf(arch, os) : [];
  const sh = plugin === undefined ? []
    : ['--shared', fmt === 'macho' ? '--install-name' : '--soname', basename(outPath)];
  /* `--stdlib` 一个词把「默认 libc + crt + 入口 `_start`」都带上（见 `c-link` 那一段）；
   * 共享库那一路它自己夹掉 crt。
   *
   * **主线程的栈也要给**（Mach-O 可执行文件那一格）：外部 cc 那一路一直递着
   * `-Wl,-stack_size,0x20000000`（`stackFlags`），我们自己这台链接器从前一直写 0 ——
   * 于是 `omni_run_entry` 判定"栈不够"，把入口挪到自己开的那条线程上，而 macOS 上
   * AppKit 只能在真主线程上首次初始化：`glfwInit` 当场 SIGTRAP，一个字节的输出都没有
   * （llvm 轴 glfw-tri @ run-c 那两格红就是它）。dylib 没有 `LC_MAIN`，所以只给可执行文件。 */
  const stk = fmt === 'macho' && plugin === undefined ? ['--stack-size', String(0x20000000)] : [];
  const rc = subMain(['c', 'link', obj, ...rt, '-o', outPath,
    '--arch', arch, '--os', os, '-f', fmt, ...sh, '--stdlib', ...stk, ...sysArgs, ...libs, '-q',
    /* `--profile` 这一趟顺手落一份链接图：Linux 上 profile 的每一格否则只是裸地址
       （见 writeLinkMap / profMapResolve）。不开 profile 时一个字节都不多写。 */
    ...(PROF === null ? [] : ['--map', `${outPath}.map`])]);
  if (rc !== 0) throw new OmniError(`OMNI_CC=self：链接没过（C 留在 ${cPath}）`);
  if (PROF !== null) {
    PROF.map = `${outPath}.map`;
    /* 告诉子进程：你那份二进制的地址 -> 名字在这。子进程（链好的可执行文件）在报告期
       读这份图，用它翻 `backtrace` 拿到的裸地址。两侧都做翻名字的原因是：
       - 子进程（`omni_prof.c`）自己翻：`cc` 那一档的**标准输出**（`按自用排前 20 行`）
         就在子进程里印，那一段看不见 CLI 的事后翻。
       - CLI 事后翻（`profMapResolve`）：折叠栈落到了文件里，CLI 读回来再过五张表，
         那一段子进程已经退了。两遍翻是独立的：哪一遍先跑都行，都能改善结果。 */
    setEnv('OMNI_PROF_MAP', PROF.map);
  }
  /* 执行位（tcc 在 `tcc_output_file` 里 chmod 0777；我们自己写字节，所以自己补一句 ——
   * 少了它只能看着 `Permission denied`）。 */
  spawn('chmod', ['+x', outPath], 'c');
  /* arm64 macOS 上共享库**没签名就 dlopen 不了**（量到的原话：`missing code signature
   * in <no uuid> '…/omni-c.dylib'`）。签名不在链接器里 —— tcc 自己也是链完
   * `system("codesign -f -s - <文件>")`（`tccmacho.c:2243`，configure 开 CONFIG_CODESIGN），
   * 所以这一句与 tcc 同口径。可执行文件走到这儿不签也跑得动（量过），只有 dylib 非签不可。 */
  if (plugin !== undefined && hostIsDarwin()) spawn('codesign', ['-f', '-s', '-', outPath], 'c');
  vStep(`c link（我们自己的链接器）  -> ${outPath}  ${fileSize(outPath)} bytes`);
  if (extern === true) {
    writeText(`${outPath}.syms`, `${syms.join('\n')}\n`);
    vStep(`syms  ${syms.length} 个符号 -> ${outPath}.syms`);
  }
  tally(basename(outPath), plugin !== undefined, cText, fileSize(outPath), tGen, nowMs() - t0);
  return { cPath, cc: 'self' };
}

/**
 * 把**默认那一套插件**编出来，外加它们要的数据（ADR-0021 的 S4）。
 *
 * `core` 是核心产物的路径（旁边那份 `.syms` 决定哪些符号绑过去）；`dir` 是插件的落点，
 * 数据落在 `dirname(dir)/share`。`want` 给 null 就是全套。
 *
 * 单独成一个函数是因为**两处要它**：`omni plugins` 那条命令，与自举链
 * （N1 建好之后得先有插件，否则它连 `emit c` 都做不了 —— 核心里一格后端都没有）。
 */
function buildPluginSet(core, dir, want, argv) {
  const symsPath = `${core}.syms`;
  if (!exists(symsPath)) {
    throw new OmniError(`找不到 ${symsPath} —— 核心得用 \`build --extern\` 编（那时才落 .syms）`
      + '；`npm run native` 会把核心与插件一次做齐');
  }
  const bind = new Set(readText(symsPath).split('\n').filter((s) => s !== ''));
  mkdirAll(dir);
  /* 插件的入口摆在 `src/plugin/`。从源码跑时 installDir() 是 `src/core/<某一格>`，
     编出来的核心在 dist 底下 —— 两条腿的相对位置不同，所以按顺序试，试不着就直说。 */
  const cands = [join(installDir(), '..', '..', 'plugin'), join(installDir(), '..', 'plugin'),
    join(cwd(), 'src', 'plugin')];
  const srcDir = cands.find((d) => isDir(d));
  if (srcDir === undefined) {
    throw new OmniError(`找不到插件入口那个目录（试过 ${cands.join('、')}）—— plugins 要源码树`);
  }
  let n = 0;
  let tot = 0;
  for (const p of PLUGIN_SET) {
    if (want !== null && !want.includes(p.name)) continue;
    const out = join(dir, `omni-${p.name}${dsoExt(hostOs())}`);
    const tFe0 = nowMs();
    const { mod } = compile(join(srcDir, `${p.name}.js`), [...argv, '--plugin', pluginRegName(p.name)]);
    FE_MS = nowMs() - tFe0;
    buildNative(mod, out, undefined, pluginRegName(p.name), true, p.own, bind);
    n += 1;
    tot += fileSize(out);
    /* 一格一行：产物多大、它那份 C 多大/多少行、发射与 cc 各花多久。这一行从前只有产物
       大小 —— 而要判断"哪一格膨胀了"看的是 C 那一侧（cc 的压缩比每格不一样）。 */
    const row = TALLY[TALLY.length - 1];
    stderr(`omni: plugin ${basename(out).padEnd(26)} ${fmtBytes(fileSize(out)).padStart(6)}`
      + `  C ${fmtBytes(row.cBytes).padStart(6)} / ${String(row.cLines).padStart(6)} 行`
      + `  ${fmtDur(row.feMs).padStart(6)} + ${fmtDur(row.genMs).padStart(6)}`
      + ` + ${fmtDur(row.ccMs).padStart(6)}\n`);
  }
  stderr(`omni: ${n} 格插件，合计 ${fmtBytes(tot)} -> ${dir}/ ${optFlag()}\n`);
  /* 数据跟着搬（host/data.js 那一串候选根里的 `<产物同级>/share`）：核心自己要的那几个
     目录在 CORE_DATA，插件各自要的写在 plugin-set.js 的 `data` 里。数据不是代码，
     编译器不会把它们编进产物 —— 不搬的话装好的 omni 一跑 `.asy` 就说找不到语法文件。 */
  const share = join(dirname(dir), 'share');
  const files = [];
  for (const c of CORE_DATA) {
    const d = dataDir(c.dir, c.probe);
    /* 只抄这一层的**文件**：`lib` 底下还有 `lib/asy`（那是 asy 插件的数据，跟着那一格走），
       当文件抄会在 readText 上炸。 */
    if (d !== null) for (const f of readDir(d)) if (!isDir(join(d, f))) files.push(`${c.dir}/${f}`);
  }
  for (const p of PLUGIN_SET) {
    if (want !== null && !want.includes(p.name)) continue;
    for (const rel of p.data ?? []) {
      if (!rel.endsWith('/')) { files.push(rel); continue; }
      const d = dataPath(rel.slice(0, rel.length - 1));
      if (d !== null) for (const f of readDir(d)) files.push(`${rel}${f}`);
    }
  }
  let nd = 0;
  for (const rel of files) {
    const src = dataPath(rel);
    if (src === null) continue;
    mkdirAll(dirname(join(share, rel)));
    writeText(join(share, rel), readText(src));
    nd += 1;
  }
  stderr(`omni: ${nd} 份数据 -> ${share}/\n`);
  return { plugins: n, data: nd };
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
  const dir = wi >= 0 ? argv[wi + 1] : workDirFor('run', workName(srcPath));
  if (wi >= 0) mkdirAll(dir);
  const exe = cached === null ? join(dir, 'a.out') : cached;
  const built = buildNative(mod, exe, wi >= 0 ? dir : undefined);
  if (cached !== null) exeCachePut(srcPath, built.cc, cap('asy.deps')());
  /* 三维那一档的 GL 插件：顺手编一下、把**绝对路径**放进环境，子进程 dlopen 它。
     `OMNI_GL_LIB` 已经给了就不动（标定时要能指别的库）；编不出来就什么都不设，
     运行时那侧找不到库自然走 CPU 光栅器。 */
  if (env('OMNI_GL_LIB') === undefined || env('OMNI_GL_LIB') === '') {
    const lib = glPlugin();
    if (lib !== null) setEnv('OMNI_GL_LIB', lib);
  }
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

/**
 * node 那条腿上的 FFI 扩展（ADR-0038）：把 `cffiSource(mod)` 发出来那份 C 编成一格 `.node`。
 *
 * **这是备选那条路**（`OMNI_FFI=cc`）—— 默认走注入（`ffiInject`）。留着它的理由是它
 * 更通用：谁的 cc 都行、什么 C 都吃得下，而注入那条路只吃我们自己那台 C 前端认得的 C。
 *
 * 内容寻址（生成的 C + 链接命令 + 编译器 → `hash16`），落在 `.omni-cache/ffi/<key>/`。
 * 内容寻址没有失效问题：声明改一个字、库换一个路径、编译器换一个，键就变。
 *
 * 与插件那格共用同一套开关：`-fPIC -shared`，macOS 上再加 `-undefined dynamic_lookup`
 * —— N-API 那几个符号在**宿主进程**（node 自己）里，不在任何库里，所以链接时必须允许
 * 未定义符号。ELF 上默认就允许，什么都不用加（那一格从前踩过：把 ld64 的开关递给
 * GNU ld，报的是 `cannot find dynamic_lookup`）。
 *
 * 编不过是**硬错误**（与 `glPlugin` 那格"编不过就走 CPU 光栅器"不同）：这份程序里有
 * `(ccall …)`，没有这个扩展它一句都跑不了，回落成一句"符号不可用"是把原因藏起来。
 */
function ffiAddon(mod) {
  const src = cffiSource(mod);
  const cc = findClang();
  const libs = libLinkArgs(mod.libs);
  const key = hash16([cc, src, libs.join(' ')].join('|'));
  const dir = join(cacheRoot(), 'ffi', key);
  const addon = join(dir, 'omni_ffi.node');
  if (exists(addon)) return addon;
  const stage = workDirFor('ffi-stage', key);
  const cPath = join(stage, 'omni_ffi.c');
  writeText(cPath, src);
  const staged = join(stage, 'omni_ffi.node');
  const shared = ['-fPIC', '-shared']
    .concat(hostIsDarwin() ? ['-undefined', 'dynamic_lookup'] : []);
  const args = ['-O2', '-w', ...shared, '-I', RUNTIME_DIR, cPath, '-o', staged, ...libs];
  const r = spawn(cc, args, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`node ffi：那份发出来的 N-API 扩展 ${cc} 编不过（ADR-0038）：\n${r[2]}\n`
      + `（那份 C 留在 ${cPath}）`);
  }
  mkdirAll(join(cacheRoot(), 'ffi'));
  if (!exists(dir)) rename(stage, dir);
  const out = exists(addon) ? addon : staged;
  vStep(`node ffi  ${src.length} 字节 C + ${libs.join(' ')} -> ${out}`);
  return out;
}

/**
 * 那格**固定的**注入宿主（ADR-0038 第二刀）：与被注入的程序无关，所以整台机器上只编一次。
 *
 * 内容寻址的键是它自己那两份源码 + 编译器。装进来之后回它的 exports
 * （`page` / `mem` / `protect` / `dlopen` / `sym` / `init` 六个口子）。
 *
 * 这一格还是要一次外部 cc —— 但**只有一次、而且与程序无关**，所以它不在每次运行的账上
 * （与 `buildJitHost` 同一个立场）。将来可以随发行版预编好。
 */
let FFI_HOST = null;
function ffiHost() {
  if (FFI_HOST !== null) return FFI_HOST;
  const src = join(JIT_DIR, 'omni_ffi_host.c');
  const hdr = join(RUNTIME_DIR, 'omni_napi.h');
  if (!exists(src)) throw new OmniError(`node ffi：注入宿主的源码不见了：${src}`);
  const cc = findClang();
  const key = hash16([cc, readText(src), readText(hdr)].join('|'));
  const dir = join(cacheRoot(), 'ffi-host', key);
  const node = join(dir, 'omni_ffi_host.node');
  if (!exists(node)) {
    const stage = workDirFor('ffi-host', key);
    const staged = join(stage, 'omni_ffi_host.node');
    const shared = ['-fPIC', '-shared']
      .concat(hostIsDarwin() ? ['-undefined', 'dynamic_lookup'] : []);
    const r = spawn(cc, ['-O2', '-w', ...shared, '-I', RUNTIME_DIR, src, '-o', staged], 'o');
    if (r[0] !== 0) {
      throw new OmniError(`node ffi：注入宿主 ${cc} 编不过（ADR-0038）：\n${r[2]}`);
    }
    mkdirAll(join(cacheRoot(), 'ffi-host'));
    if (!exists(dir)) rename(stage, dir);
    if (!exists(node)) {
      FFI_HOST = dlopenAddon(staged);
      vStep(`ffi host  ${staged}`);
      return FFI_HOST;
    }
  }
  FFI_HOST = dlopenAddon(node);
  vStep(`ffi host  ${node}`);
  return FFI_HOST;
}

/**
 * 那份 C 编成一格**可重定位**的 `.o`（我们自己那台 C 前端，`-f elf`）。
 *
 * 内容寻址（就是那份 C 的内容 + 目标）。**这一格必须缓存**：注入那条路每次运行都要
 * 重新铺映像，而"编"那一步是纯函数 —— 不缓存的话热路径上它比 cc 那条路更慢
 * （量过：编一趟 47ms，而 cc 那条路热的时候只剩一次 1.85ms 的 dlopen）。
 *
 * 为什么是 ELF 而不是 Mach-O：`link/elf_merge.js` 的 `linkObjects` 吃的是 ELF ——
 * 我们那台 C 前端的 `-f` 与目标是**分开拨**的两格（tcc 的 `-c` 在所有目标上都写 ELF）。
 */
function ffiObject(mod) {
  const src = cffiSource(mod);
  const arch = hostArch();
  const os = hostOs();
  const key = hash16([src, arch, os].join('|'));
  const dir = join(cacheRoot(), 'ffi-obj');
  const objPath = join(dir, `${key}.o`);
  /* `readBinary` 回的是 latin1 的串（宿主那一层就这么定的），链接器要按字节看
     —— 与 `elf-r` 那一支里的 `bytesOf` 是同一句话。 */
  const bytesOf = (p) => {
    const s = readBinary(p);
    const b = new Uint8Array(s.length);
    for (let k = 0; k < s.length; k++) b[k] = s.charCodeAt(k);
    return b;
  };
  if (exists(objPath)) return bytesOf(objPath);
  const stage = workDirFor('ffi-obj', key);
  const cPath = join(stage, 'omni_ffi.c');
  writeText(cPath, src);
  const staged = join(stage, 'omni_ffi.o');
  cObj(cPath, staged, arch, [RUNTIME_DIR], [], 'elf', os, undefined, false);
  mkdirAll(dir);
  /* 先落临时名再 rename：两个进程同时跑同一份程序时，谁都不会读到半个 `.o`。 */
  if (!exists(objPath)) rename(staged, objPath);
  return bytesOf(exists(objPath) ? objPath : staged);
}

/**
 * **注入**（默认那条路，ADR-0038 第二刀）：那份 C -> 机器码 -> 这个进程里的一块内存。
 *
 * 五步，次序不能动（错了就是 SIGBUS 或者跑到旧字节上）：
 *   1. `(lib …)` 里**不是预登记系统库**的那些先 `dlopen(RTLD_GLOBAL)` —— 系统库本来就
 *      在这个进程里（`sym('printf')` 在一次 dlopen 都没做的时候就查得着，量过）；
 *   2. 铺映像（`flatImage`）：布局、GOT、桩子、重定位，装载地址由 `mem()` 给；
 *   3. 字节写进那块内存（宿主给的是 external ArrayBuffer，所以是**零拷贝**的一次 set）；
 *   4. 一段一段 `protect` —— `.text` 那段 `rx` 并刷指令缓存；
 *   5. `init` 跳进 `napi_register_module_v1`，拿它回的那格对象。
 *
 * osx 上那个**前缀下划线**是平台事实（`cObj` 里 `prefix: os === 'osx' ? '_' : ''`），
 * 而 `dlsym` 要的是不带的 —— 这一格归调用方剥，`flatImage` 不认识平台。
 */
function ffiInject(mod) {
  const h = ffiHost();
  for (const raw of mod.libs ?? []) {
    const lib = resolveLib(raw);
    if (cSysLib(lib) !== null) continue;
    const p = lib.endsWith('.framework') ? frameworkPath(lib) : lib;
    if (h.dlopen(p) !== true) throw new OmniError(`node ffi：装不上那个库：${p}`);
  }
  const obj = ffiObject(mod);
  let mem = null;
  const img = flatImage({
    objs: [obj],
    page: h.page(),
    reserve: (n) => { mem = h.mem(n); return Number(mem.addr); },
    resolve: (name) => {
      const a = h.sym(name.startsWith('_') ? name.slice(1) : name);
      return a === 0n ? null : Number(a);
    },
  });
  new Uint8Array(mem.buf).set(img.bytes, 0);
  for (const r of img.ranges) h.protect(r.addr, r.len, r.mode);
  const entry = img.syms.get('_napi_register_module_v1')
    ?? img.syms.get('napi_register_module_v1');
  if (entry === undefined) {
    throw new OmniError('node ffi：铺出来的映像里找不着 napi_register_module_v1');
  }
  vStep(`ffi inject  ${img.size} 字节铺在 0x${img.base.toString(16)}，`
    + `${img.ranges.length} 段（${obj.length} 字节 .o，我们自己那台 C 前端编的）`);
  return h.init(entry);
}

/**
 * 这一趟的 `$cffi` 从哪儿来：**默认注入**，`OMNI_FFI=cc` 走编到文件那条备选。
 *
 * 注入那条路要一个装得动 addon 的宿主（node）；装不动就自动退到 cc 那条 ——
 * 那不是"降级"，是那条路本来就更通用。
 */
function ffiPrepare(mod) {
  const how = env('OMNI_FFI');
  if (how !== 'cc' && hasAddonLoader()) {
    publishCffi(ffiInject(mod));
    return;
  }
  setEnv('OMNI_FFI_ADDON', ffiAddon(mod));
}

function buildLlvm(mod, outPath, workDir) {  const mir = lowerToMir(mod);
  const errs = verifyMir(mir);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  const ir = target('llvm').emit(mir);
  const dir = workDir === undefined ? workDirFor('ll', workName(outPath)) : workDir;
  if (workDir !== undefined) mkdirAll(dir);
  const llPath = join(dir, `${basename(outPath)}.ll`);
  writeText(llPath, ir);
  vStep(`backend llvm  ${ir.length} bytes -> ${llPath}`);
  const cc = findClang();
  const args = [optFlag(), '-w', '-ffp-contract=off', '-pthread', ...mainStackFlags(cc),
    '-I', RUNTIME_DIR, llPath, ...runtimeObjects(cc), '-o', outPath, '-lm',
    ...libLinkArgs(mir.libs)];
  const r = spawn(cc, args, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`llvm backend produced IR that ${cc} rejected:\n${r[2]}\n(kept at ${llPath})`);
  }
  vStep(`${cc}  ${args.length} args -> ${outPath}  ${fileSize(outPath)} bytes`);
  return { llPath, cc };
}

function runViaLlvm(mod, argv, srcPath) {
  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : workDirFor('run-ll', workName(srcPath));
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
 * 还有一层间接没去掉：ORC 那一段在 `src/jit/omni_jit.c` 里，node 这一侧是 spawn 它。
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
  /* 宿主符号表（ADR-0022 决策 2）：与宿主一起编。它进缓存键 —— 表里多一行就该重编，
     否则"补了符号还是报 unresolved"会让人去怀疑编译器。 */
  const symSrc = join(JIT_DIR, 'omni_jit_symbols.c');
  if (!exists(symSrc)) throw new OmniError(`jit host source is missing: ${symSrc}`);

  const objs = runtimeObjects(cc);
  const key = hash16([cc, ver[1].trim(), src, mtimeMs(src), fileSize(src),
    symSrc, mtimeMs(symSrc), fileSize(symSrc), ...mainStackFlags(cc), ...objs].join('|'));
  const dir = join(cacheRoot(), 'jit', key);
  const exe = join(dir, 'omni-jit');
  if (exists(exe)) {
    vStep(`jit host  cache hit ${exe}`);
    return exe;
  }
  /* 运行时的 .o 直接链进宿主，地址由 omni_jit_symbols.c 里那张表**按名字摆进 JIT**
     （ADR-0022 决策 2）。所以从前那句 `-Wl,-export_dynamic` 不再需要了 ——
     去掉它正是"进程符号表不再是解析路径"的可观测形式：留着的话这条断言就没法验。 */
  const stage = workDirFor('jit-stage', key);
  const staged = join(stage, 'omni-jit');
  const args = ['-O2', '-w', '-pthread', ...mainStackFlags(cc), '-I', inc[1].trim(),
    '-I', RUNTIME_DIR, src, symSrc,
    ...objs, '-L', libdir[1].trim(), '-lLLVM', '-lm', '-o', staged];
  const r = spawn(cc, args, 'o');
  if (r[0] !== 0) throw new OmniError(`the jit host failed to build with ${cc}:\n${r[2]}`);
  mkdirAll(join(cacheRoot(), 'jit'));
  if (!exists(exe)) rename(stage, dir);
  vStep(`jit host  built with ${cc} + LLVM ${ver[1].trim()} -> ${exists(exe) ? exe : staged}`);
  return exists(exe) ? exe : staged;
}

function runViaJit(mod, argv, srcPath) {
  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : workDirFor('run-jit', workName(srcPath));
  if (wi >= 0) mkdirAll(dir);
  const mir = lowerToMir(mod);
  const errs = verifyMir(mir);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  const ir = target('llvm').emit(mir);
  const llPath = join(dir, 'jit.ll');
  writeText(llPath, ir);
  vStep(`backend llvm  ${ir.length} bytes -> ${llPath}`);
  const host = buildJitHost();
  /* 要装的动态库（`(lib …)`，ADR-0022 的 J4c）：预登记的系统库只要一个 `--dl`（去问进程的
     动态符号表 —— 它们本来就在这个进程里，而 macOS 上它们连磁盘上的文件都不是），
     别的按路径 `--lib`。宿主那侧默认是**关**的，所以这几个开关一个都不能少（决策 2）。 */
  const jitArgs = [llPath];
  let wantDl = false;
  for (const raw of mir.libs ?? []) {
    const lib = resolveLib(raw);
    const sys = cSysLib(lib);
    if (sys !== null) { wantDl = true; continue; }
    /* framework 那一格（`(lib "OpenGL.framework")`）：链接期是 `-framework OpenGL`，
       这一侧要一个**路径** —— 共享缓存里的那个二进制，磁盘上没有文件但 dlopen 认它。 */
    jitArgs.push('--lib', lib.endsWith('.framework') ? frameworkPath(lib) : lib);
  }
  if (wantDl) jitArgs.push('--dl');
  /* **对象码缓存**（J7）：键是「这份 IR 的内容 + 那个宿主二进制」——宿主的路径里已经编进了
     编译器、LLVM 的版本与运行时的 .o（见 buildJitHost 的缓存键），所以把它算进去就够了。
     内容寻址于是没有失效问题：IR 改一个字节就是另一个文件。落在 `.omni-cache/jitobj/`。
     写不下来不算错（宿主那侧就是这么处理的）—— 缓存是可选的。 */
  const objDir = join(cacheRoot(), 'jitobj');
  mkdirAll(objDir);
  jitArgs.push('--objcache', join(objDir, `${hash16([host, ir].join('|'))}.o`));
  const code = spawn(host, jitArgs, 'i')[0];
  vStep(`orc jit ${llPath}  exit=${code}`);
  return code;
}



/**
 * `omni run x.asy -f svg` / `omni run x.asy -o x.svg`（ADR-0015 那一节）。
 *
 * 这一段做的事只有一件：**设宿主的两格设置**（格式、落地文件名）。往下所有腿都是
 * 从那两格读的 —— 本进程 eval 的 JS 读 `process.env`、spawn 出去的 node 与链好的
 * 可执行文件继承环境。所以：
 *   - 产物缓存的印记（`jsCacheStamp`）**一个字都不用改**：格式不进产物；
 *   - 同一份编好的东西，`-f svg` 与不带 `-f` 跑的是同一个文件，只是设置不同。
 * 这是量出来的判据：格式一旦住进某个模块的变量（或者往源码头上贴一句
 * `asy__defaultformat = "svg";`），缓存就得按格式分叉 —— 那就是"被模块锁定"。
 *
 * 与真 asy 的对照：真 asy 的 `-f` 由 settings.cc 填 `settings::outformat`，
 * 那也是个运行期的全局。`-o x.svg` 猜格式是**我们的加法**（真 asy 的 `-o` 只定名字），
 * 理由是这一层只认两种格式，后缀已经把话说全了。
 *
 * 只认 eps 与 svg：别的（pdf/png…）这一层真的没有，猜一个"最像的"出去等于悄悄给错东西。
 */
function asyRunSetup(path, rest) {
  if (!path.endsWith('.asy')) return;
  const oi = rest.indexOf('-o');
  const out = oi >= 0 ? rest[oi + 1] : null;
  const fi = rest.indexOf('--format');
  let fmt = fi >= 0 ? rest[fi + 1] : null;
  if (fmt === null && out !== null) {
    const dot = out.lastIndexOf('.');
    const ext = dot < 0 ? '' : out.slice(dot + 1);
    if (ext === 'svg') fmt = 'svg';
    else if (ext === 'eps' || ext === 'ps') fmt = 'eps';
    else {
      throw new OmniError(`run ${basename(path)}: 从 '-o ${out}' 猜不出格式`
        + '（这一层只有 .eps/.ps 与 .svg）—— 要么换个后缀，要么显式给 -f eps|svg');
    }
  }
  if (fmt !== null && fmt !== 'eps' && fmt !== 'svg') {
    throw new OmniError(`run ${basename(path)}: 没有 -f ${fmt} 这一格 —— `
      + 'asy 这一层只出 eps 与 svg（真 asy 的 pdf/png 是再交给 gs/ImageMagick 的，'
      + '那一路还没做）');
  }
  if (fmt !== null) setEnv('OMNI_ASY_OUTFORMAT', fmt);
  if (out !== null) setEnv('OMNI_ASY_OUTNAME', out);
}

/**
 * 那份**默认 libc** —— tcc 在 `tcc_add_runtime` 里加的东西。
 *
 * macOS 上是 libSystem，我们经 SDK 的 `libc.tbd` 拿它的导出表（`macho_load_tbd`，
 * 已经有了）。少这一格的时候 `_printf`/`_clock` 全报「符号没有定义」——
 * 而那不是链接器的毛病，是**没人把 libc 递给它**。
 *
 * Linux 上是 glibc：`-lc` 落到 `/usr/lib/libc.so`（一份 ld 脚本），crt 那三个 `.o`
 * 由 `cCrt()` 单独交（次序不一样，见那儿）。
 */
function cDefaultLibs(os) {
  if (os === 'osx') return ['-lc', '-L', cap('c.usrLib')()];
  /* **Linux**：与 macOS 同一句话 —— `-lc`。`elf-link` 那一格现在自己会找库、会认
   * ld 脚本（`ldscript.js`，照 tcc 的 `tcc_load_ldscript`），于是
   * `/usr/lib/libc.so` 那份 `GROUP ( libc.so.6 libc_nonshared.a AS_NEEDED ( … ) )`
   * 展开成什么由**这台机器上的脚本**说，不再由我们把三个库名写死在这儿猜
   * （从前那三行路径清单就是 stdout / fmod / atexit 三笔账一条条堆出来的）。
   *
   * libm 单列一格：glibc 2.34 起数学函数并进了 libc，但**符号表里那一份**在有些
   * 发行版上仍旧只从 `libm.so.6` 露出来（量到的：Arch 的容器里链 `fmod` 报「找不到」，
   * 而 libc.so.6 已经在表上了）。找得着就带上 —— 找不着的那种正是并进去了的。 */
  if (os !== 'linux') return [];
  const out = ['-lc'];
  for (const p of ['/usr/lib/libm.so', '/usr/lib/x86_64-linux-gnu/libm.so',
    '/usr/lib/aarch64-linux-gnu/libm.so', '/usr/lib/libm.so.6', '/lib64/libm.so.6']) {
    if (exists(p)) { out.push('-lm'); break; }
  }
  return out;
}

/**
 * crt 那三个 `.o`（`tccelf_add_crtbegin` / `tccelf_add_crtend`）。
 *
 * 为什么非有不可：ELF 上内核**直接跳到 `e_entry`**，栈上没有返回地址。入口指着 `main`
 * 的时候程序跑得完、印得对，`main` 一 `return` 就 `ret` 到栈上那格 argc 上去 ——
 * x86_64 容器里量到的正是这个：fib 印完 `196418` / `999794999321` 之后 SIGSEGV（139）。
 * `_start` 是 glibc 的 `crt1.o` 给的，它把 `main` 交给 `__libc_start_main`，
 * 后者拿 `main` 的返回值去调 `exit`。
 *
 * tcc 的规矩（`tccelf.c:1761` / `:1796`，glibc 那一支）：**只加 `crt1.o` 与 `crti.o`**
 * （crtbegin.o 不加 —— 所以 `__dso_handle` 由 `libtcc1.a` 自己给，见 `elf_exe.js`），
 * 末尾补 `crtn.o`；找的路径是 `CONFIG_TCC_CRTPREFIX`（`tcc.h:272`），默认
 * `<sysroot>/usr/lib`，配了 triplet 的还多一层 `/usr/lib/<triplet>`。
 * 入口名不给的时候查的是 `_start`（`tccelf.c:2717`）。
 *
 * 次序有讲究：`crt1.o` `crti.o` 在**前**，`crtn.o` 在**最后** —— `_init` / `_fini`
 * 的开头一半在 crti、结尾一半在 crtn，中间夹着各家的 `.init` 片段。
 *
 * @returns `{pre, post}`，两串位置参数（`.o` 的路径）；这台机器上找不着就都是空的
 */
function cCrt(os) {
  if (os !== 'linux') return { pre: [], post: [] };
  const dirs = ['/usr/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/lib64'];
  const find = (name) => {
    for (const d of dirs) {
      const p = `${d}/${name}`;
      if (exists(p)) return p;
    }
    return null;
  };
  const one = find('crt1.o');
  const i = find('crti.o');
  const n = find('crtn.o');
  if (one === null || i === null || n === null) return { pre: [], post: [] };
  return { pre: [one, i], post: [n] };
}

/**
 * tcc 的「编 + 链一步走」：`tcc x.c` 是把 x.c 编成一个临时目标文件再链，
 * 而我们的 `c link` 只吃 `.o`。少这一层的时候，`.c` 被当成目标文件读进去 ——
 * 量出来的指纹就是那句 `macho: 还不会给 34460 号架构写可执行文件`
 * （34460 是把源码第 18、19 个字节当 ELF 的 `e_machine` 读出来的）。
 *
 * 为什么不在 `cmd-tcc.js` 里做：那一份是**纯翻译**（不碰文件系统、可测），
 * 而这一步要真编译、要落临时文件。
 */
function tccPrepLink(argv) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const arch = val('--arch') ?? hostArch();
  const os = val('--os') ?? hostOs();
  const out = [];
  let nSrc = 0;
  for (const a of argv) {
    if (!a.endsWith('.c')) { out.push(a); continue; }
    /* 目标文件的容器**永远是 ELF**（tcc 的 `-c` 在所有目标上都写 ELF，见 ADR-0017）。 */
    const obj = join(workDirFor('c-tcc', workName(a)), `${basename(a, '.c')}.o`);
    mkdirAll(dirname(obj));
    cObj(a, obj, arch, incDirs(argv), defArgs(argv), 'elf', os, sysIncDirs(argv));
    vStep(`c front end + codegen  ${a} -> ${obj}`);
    out.push(obj);
    nSrc++;
  }
  if (!argv.includes('-nostdlib')) out.push(...cDefaultLibs(os));
  /* crt 那三个 `.o`：`crt1.o`/`crti.o` 摆在所有输入的**前面**，`crtn.o` 摆最后
   * （`tccelf_add_crtbegin` / `tccelf_add_crtend` 的次序）。共享库与 `-nostdlib` 不加。
   * 入口跟着换成 `_start` —— 那是 crt1.o 给的名字，也是 tcc 不给 `-e` 时查的名字。 */
  const crt = argv.includes('-nostdlib') || argv.includes('--shared')
    ? { pre: [], post: [] } : cCrt(os);
  if (crt.pre.length !== 0) {
    out.unshift(...crt.pre);
    out.push(...crt.post);
    if (!out.includes('-e')) out.push('-e', '_start');
  }
  return { argv: out, nSrc, out: val('-o') ?? 'a.out', os };
}

/**
 * `omni run x.c` —— **编 + 链 + 跑**（自带的 C 前端 + 自带的代码生成 + 自带的链接器）。
 *
 * 为什么默认不是解释器：那一条是 **oracle**（`omni c run`），libc 一条一条往上补，
 * 而且慢一个数量级 —— BBP 那份量出来 24.5 s，这条路 1.0 s（clang -O0 是 0.4 s）。
 * 要解释执行就明说：`omni c run x.c`。
 *
 * 产物摊在工作目录里（`-q` 让链接那一步别印产物摘要）：`run` 的 stdout 归被跑的程序，
 * 与 `.asy` 那条路同一条规矩。
 */
/**
 * `.c` 那条腿上**交给外部 cc 的那一趟**（第一百四十七片第六格）。
 *
 * 从前 `run x.c --cc clang` 与 `run x.c --profile …` 两个开关都被**悄悄忽略**：那条腿
 * 一路走我们自己的 C 前端 + 链接器，谁都没问过 `CC` 与 `PROF`。量到的原话（用户那一趟）：
 * `omni run -v BBP_Formula.c --profile sample --cc clang` 印的是「c front end + codegen」
 * ——也就是**我们自己那台**，而且一份 profile 都没出。收下开关一声不响是最坏的一种。
 *
 * 现在这一格把两根线都接上，办法是**把这一趟整个交给那台 cc**（那时插桩由它做）：
 *   `--profile cc`      加 `-finstrument-functions`，并把 `src/runtime/omni_prof.c` 一起编进去
 *                       （那份收集器的 `__cyg_profile_func_enter` 自己 `atexit` 挂报告）
 *   `--profile stub`    在这条腿上与 `cc` 是同一件事（见下面 `instr` 那一格）
 *   `--profile sample`  同样编进 `omni_prof.c`，再加一格构造器 TU 调 `omni_prof_env_init()`
 *                       （用户的 `main` 不是我们的，没有 `omni_host_init` 那一步）
 *   没有 profile        就是「用那台 cc 编一编、链一链」——`--cc` 这一格本来就该管这个
 *
 * 回 `null` 表示这一趟不该走这条路（`--cc self` 或者没给）；调用方接着走自己那条
 * （那条路上三档也都齐了，见 `cFileSelfProf`）。
 */
function cFileViaCc(path, argv, exe) {
  const cc = ccPick();
  if (!cc || cc === 'self') return null;
  const mode = PROF === null ? null : PROF.mode;
  const objs = [];
  const flags = ['-O2', '-g'];
  /* `.c` 输入这条腿上 **`cc` 与 `stub` 是同一件事**：那份 C 不经我们的发射器，所以"发射期
   * 插的那一对"在这儿只能理解成"插桩" —— 谁编的谁插（我们自己那台前端也会插了，
   * 见 `emitProfCall`）。两个名字都落到 `-finstrument-functions` 上，不多一句拒绝。 */
  const instr = mode === 'cc' || mode === 'stub';
  if (instr || mode === 'sample') {
    flags.push('-I', RUNTIME_DIR);
    /* **收集器自己不能被插桩**：`omni_prof.c` 里那对钩子一旦也带上 `-finstrument-functions`，
     * 进入钩子又触发钩子 —— 量到的就是当场 `Segmentation fault: 11`（栈爆）。所以它
     * 单独先编成一个 `.o`（不带那面开关），再和用户那份一起链。 */
    const pobj = join(dirname(exe), 'omni_prof.o');
    const prc = spawn(cc, ['-O2', '-g', '-I', RUNTIME_DIR, '-c',
      join(RUNTIME_DIR, 'omni_prof.c'), '-o', pobj], 'c')[0];
    if (prc !== 0) throw new OmniError(`${cc} 编不过收集器 omni_prof.c（退出码 ${prc}）`);
    objs.push(pobj);
    if (instr) flags.push('-finstrument-functions');
    if (mode === 'sample') {
      /* 采样那条栈是靠**帧指针**往上走的（`ucontext` 拿到 fp 再一格格串）—— `-O2` 默认
       * 会省掉它，省掉就只剩最外那一帧。这一格明着要回来。 */
      flags.push('-fno-omit-frame-pointer');
      /* 采样那一档要有人在启动时叫一句 `omni_prof_env_init()` —— 用户的 `main` 不是我们的，
       * 所以发一格只有构造器的 TU（gcc/clang 都认这个属性；`--cc self` 那一路走不到这儿）。 */
      const shim = join(dirname(exe), 'omni_prof_boot.c');
      writeText(shim, 'void omni_prof_env_init(void);\n'
        + '__attribute__((constructor)) static void omni_prof_boot(void) { omni_prof_env_init(); }\n');
      const sobj = join(dirname(exe), 'omni_prof_boot.o');
      const src = spawn(cc, ['-O2', '-c', shim, '-o', sobj], 'c')[0];
      if (src !== 0) throw new OmniError(`${cc} 编不过采样启动那一格（退出码 ${src}）`);
      objs.push(sobj);
    }
  }
  /* `-lm`：数学库在 Linux 上是单独一份（macOS 上并进 libSystem，多给这一格也无害）。
   * `.c` 输入里 `sqrt`/`pow` 太常见，少这一格会在链接那一步倒。 */
  const args = [...flags, path, ...objs, '-o', exe, '-lm'];
  const rc = spawn(cc, args, 'c')[0];
  vStep(`${cc} ${mode === null ? '' : `--profile ${mode} `}${path} -> ${exe}`);
  if (rc !== 0) throw new OmniError(`${cc} 编不过 ${path}（退出码 ${rc}）`);
  return exe;
}

/**
 * **`--direct`：一份 `.js` 原样交给 node**（第一百四十八片第二格）。
 *
 * 从前 `omni run x.js` 只有一条路：前端 -> OIR -> 发一份 JS -> 在本进程里 eval。
 * 量到的账（`bench/fib.js`，823 字节）：
 *   我们那一轮   发出来 371770 字节（裁过还有 192735），整趟 459ms，其中 442ms 在 exec 上
 *   直接给 node  823 字节，整趟 113ms（含 node 自己的启动）
 * 输入本来就是这门语言的源码，那一轮**在很多用途上是纯开销**（看一眼输出、量一段性能）。
 *
 * **为什么是开关而不是默认**：两条路的语义不是同一格。我们那一轮上有 ADR-0011 那层
 * （int = i64 的规范形、按字节的字符串、按值捕获的闭包…），直路上没有 —— 直路就是 node
 * 自己的语义。要「我们那套语义」就别给这个开关；要「就是 node」才给。
 *
 * 只对 `.js` / `.mjs` 成立：别的后缀 node 读不懂，当场说清而不是把一份 `.omni` 塞给 node
 * 让它报一句莫名其妙的语法错。
 */
function runJsDirect(path, args) {
  if (!path.endsWith('.js') && !path.endsWith('.mjs')) {
    throw new OmniError(`--direct 是「原样交给 node」这一格，只认 .js / .mjs：${path} 不是。`
      + '别的语言要先过我们这一轮（去掉 --direct 就是那条路）');
  }
  const pre = profNodeArgs();
  const st = spawn('node', [...pre, path, ...args], 'i')[0];
  vStep(`node ${pre.join(' ')}${pre.length > 0 ? ' ' : ''}${path}  exit=${st}（--direct：没过我们这一轮）`);
  profNodeFinish();
  return st;
}

/**
 * **`.c` 输入 + `--cc self` 上的 profile**（第一百五十片第二、三格）。
 *
 * 用户那句话：「self 没有任何一条路径不可做，毕竟我们最后部署的机器不一定有外部 cc。」
 * 两档现在都成立，要的东西我们**自己都有**：
 *
 *   `sample`：一、把收集器（`src/runtime/omni_prof.c`）编成一格 `.o` —— 我们自己那台 C
 *       前端本来就在编整份运行时（`OMNI_CC=self` 那条闭环）；二、启动时叫一句
 *       `omni_prof_env_init()`。外部 cc 那条路用的是构造器属性，而我们这台前端不必依赖
 *       那个：**把用户的 `main` 改个名**（`-Dmain=omni_user_main`，预处理层，任何 C
 *       编译器都认），再发一格自己的 `main` 先开采样、再调它。
 *   `cc` / `stub`：**我们自己那台前端插桩**（`-finstrument-functions` 的复刻，见
 *       `emitProfCall`）。这一档只要把收集器链进去 —— 那对钩子第一次被调到时自己
 *       `atexit` 挂报告，没有启动那一步要做。
 *
 * 于是一个外部编译器都不借，`.c` 输入上采样与精确插桩两档都量得到。
 *
 * 回 `{ defs, objs, instr }`：`defs` 要接到用户那一份的宏定义上，`objs` 要一起链进去，
 * `instr` 说的是「用户那一份要不要插桩」。没开 profile 就回 `null`。
 */
function cFileSelfProf(dir, arch, os, sysIncs) {
  if (PROF === null) return null;
  const mode = PROF.mode;
  const pobj = join(dir, 'omni_prof.o');
  /* **收集器自己绝不能被插桩**（与 `cFileViaCc` 里那一格同一个理由）：钩子里再触发钩子
   * 就是栈爆。所以这一趟不给 `instr` —— 它是 `cObj` 最后那个参数，默认关着。 */
  cObj(join(RUNTIME_DIR, 'omni_prof.c'), pobj, arch, [RUNTIME_DIR], [], 'elf', os, sysIncs);
  vStep(`c obj（我们自己那台）  omni_prof.c -> ${pobj}`);
  if (mode !== 'sample') {
    /* 插桩那两档（`cc` / `stub`）：钩子自己挂报告，不用那格 `main` 包装。 */
    vStep('插桩（我们自己那台前端复刻 -finstrument-functions）');
    return { defs: [], objs: [pobj], instr: true };
  }
  const shim = join(dir, 'omni_prof_boot.c');
  writeText(shim, 'void omni_prof_env_init(void);\n'
    + 'int omni_user_main(int argc, char **argv);\n'
    + 'int main(int argc, char **argv) { omni_prof_env_init(); return omni_user_main(argc, argv); }\n');
  const sobj = join(dir, 'omni_prof_boot.o');
  cObj(shim, sobj, arch, [], [], 'elf', os, sysIncs);
  vStep(`c obj（我们自己那台）  ${shim} -> ${sobj}（改名 main + 开采样）`);
  /* 宏的形状是 `[名字, 值]` 的数组（见 `defArgs`）—— 不是命令行那种 `-Dk=v` 串。 */
  return { defs: [['main', 'omni_user_main']], objs: [pobj, sobj], instr: false };
}

function runCFile(path, argv) {
  const ai = argv.indexOf('--arch');
  const si = argv.indexOf('--os');
  const arch = ai >= 0 ? argv[ai + 1] : hostArch();
  const os = si >= 0 ? argv[si + 1] : hostOs();
  const fmt = fmtOfOs(os);
  const dir = workDirFor('run-c-exe', workName(path));
  mkdirAll(dir);
  const obj = join(dir, `${basename(path, '.c')}.o`);
  const exe = join(dir, basename(path, '.c'));
  const { flags, prog } = cSplitArgs(argv);
  /* `--cc`（以及 `--profile`）先说话：给了外部编译器就整趟交给它 —— 从前这两个开关
   * 在这条腿上被悄悄忽略（见 `cFileViaCc` 头上那段量到的原话）。 */
  const via = cFileViaCc(path, argv, exe);
  if (via === null) {
    /* 我们自己那台前端 + 链接器这条路上的 profile：收集器、那格 main 包装、以及
       「用户那一份要不要插桩」都在这儿说定（见上）。 */
    const sp = cFileSelfProf(dir, arch, os, sysIncDirs(flags));
    cObj(path, obj, arch, incDirs(flags),
      [...defArgs(flags), ...(sp === null ? [] : sp.defs)], 'elf', os, sysIncDirs(flags),
      sp !== null && sp.instr);
    vStep(`c front end + codegen  ${path} -> ${obj}`);
    const rc = subMain(['c', 'link', obj, ...(sp === null ? [] : sp.objs), '-o', exe,
      '-f', fmt, '--arch', arch, '--os', os, '--stdlib', '-q']);
    if (rc !== 0) return rc;
    /* tcc 在 `tcc_output_file` 里给可执行文件补执行位（chmod 0777）—— 我们自己写字节，
     * 所以这一格得自己补，不然只能看着 `Permission denied`。 */
    if (os !== 'win32') spawn('chmod', ['+x', exe], 'c');
    vStep(`link  ${exe}`);
  }
  const st = spawn(exe, prog, 'i')[0];
  vStep(`exec ${exe}  exit=${st}`);
  return st;
}

/**
 * `omni build x.c` —— 编 + 链，出一个可执行文件，**不跑**。
 *
 * 与 `runCFile` 是同一条腿，差别只有两处：产物落在 `-o` 给的地方（默认是当前目录下的
 * 同名文件，与 `omni build x.omni` 一个规矩），以及印一行产物摘要（`build` 的契约是
 * 「出产物」，那一行是它的输出）。
 */
function buildCFile(path, rest) {
  const ai = rest.indexOf('--arch');
  const si = rest.indexOf('--os');
  const arch = ai >= 0 ? rest[ai + 1] : hostArch();
  const os = si >= 0 ? rest[si + 1] : hostOs();
  const fmt = fmtOfOs(os);
  const oi = rest.indexOf('-o');
  const out = oi >= 0 ? rest[oi + 1] : basename(path, '.c');
  const { flags } = cSplitArgs(rest);
  const obj = join(workDirFor('build-c', workName(path)), `${basename(path, '.c')}.o`);
  mkdirAll(dirname(obj));
  const via = cFileViaCc(path, rest, out);
  if (via === null) {
    cObj(path, obj, arch, incDirs(flags), defArgs(flags), 'elf', os, sysIncDirs(flags));
    vStep(`c front end + codegen  ${path} -> ${obj}`);
    const rc = subMain(['c', 'link', obj, '-o', out,
      '-f', fmt, '--arch', arch, '--os', os, '--stdlib', '-q']);
    if (rc !== 0) return rc;
    if (os !== 'win32') spawn('chmod', ['+x', out], 'c');
  }
  stderr(`omni: built ${out} via ${via === null ? `自带的 C 前端 + ${fmt} 链接器` : ccPick()}\n`);
  return 0;
}

/* ---- `omni run --timeout SEC`（整趟的墙上时限）
 *
 * 默认 **30 秒**：一条会挂住的腿（asy 里一个不收敛的循环、等 stdin 的子进程）从前是
 * 「终端上一直坐着」，而这是**跑**这个动词最该有的一格保护。`--timeout 0` 撤掉它。
 *
 * 时限本身由宿主拿着（`runTimeout`）—— 只有它能中断两种"跑"：子进程那一路是
 * `spawnSync` 的时限，本进程那一路（`evalJs` / 解释器）是另一根线程上的看门狗。
 * 这儿留一份**同样的截止时刻**，用来在回到这一层的时候判断"这一趟是不是被时限打断的"：
 * 子进程被杀之后 `spawn` 是**正常返回**的，退出码分不出"超时"与"程序自己失败了"。
 *
 * 印字的人有两个（子进程那一路是这儿、本进程那一路是看门狗），但那句话只有一份 ——
 * 文本是造好之后交给宿主的，不是两边各写一遍。
 */
const RUN_TIMEOUT_DEFAULT_S = 30;
let RUN_DEADLINE = 0;
let RUN_TIMEOUT_MSG = '';

function armRunTimeout(rest) {
  const i = rest.indexOf('--timeout');
  const raw = i >= 0 ? rest[i + 1] : null;
  let sec = RUN_TIMEOUT_DEFAULT_S;
  if (raw !== null && raw !== undefined) {
    /* `30s` 也收：写时限的人十个有九个会带那个单位。 */
    const t = raw.endsWith('s') ? raw.slice(0, -1) : raw;
    sec = Number(t);
    if (t === '' || !(sec >= 0) || sec === Infinity) {
      throw new OmniError(`run: --timeout 要一个秒数（0 = 不限），拿到的是 '${raw}'`);
    }
  }
  if (sec === 0) return;
  RUN_TIMEOUT_MSG = `omni: 超时 —— 这一趟跑过了 ${sec}s（--timeout），已中止\n`;
  RUN_DEADLINE = nowMs() + sec * 1000;
  runTimeout(sec * 1000, RUN_TIMEOUT_MSG);
}

/**
 * **量自己**（第一百五十片）：`omni --profile sample glr …` —— 开关摆在**动词前面**
 * 就是「量这一趟 omni 自己」，摆在动词后面还是「量被跑的那个程序」。
 * 读法与 `node --cpu-prof script.js` 一致：谁在前面就量谁。
 *
 * 这一格回 `{ mode, hz, out, rest }`（`rest` 是剥掉前缀之后的真 argv），
 * 没有前缀就回 `null` —— 那时一个字节都不改，老路照走。
 *
 * 只认三格：`--profile MODE`、`--profile-out FILE`、`--profile-with WHO`。
 * 别的开关（`-v` 之类）**不剥** —— 它们是那个动词的话，不是这一格的。
 */
function selfProfPrefix(argv) {
  let i = 0;
  let mode = null;
  let out = null;
  let who = null;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--profile') { mode = argv[i + 1] ?? 'sample'; i += 2; continue; }
    if (a === '--profile-out') { out = argv[i + 1] ?? null; i += 2; continue; }
    if (a === '--profile-with') { who = argv[i + 1] ?? null; i += 2; continue; }
    break;
  }
  if (mode === null && out === null && who === null) return null;
  const colon = mode === null ? -1 : mode.indexOf(':');
  const hz = colon < 0 ? 0 : Number(mode.slice(colon + 1));
  return {
    mode: mode === null ? 'sample' : (colon < 0 ? mode : mode.slice(0, colon)),
    hz: Number.isFinite(hz) ? hz : 0,
    out,
    who: who ?? 'builtin',
    rest: argv.slice(i),
  };
}

/**
 * 量自己那一趟怎么落地 —— **两条腿两个答案，理由都在"采样器什么时候能开"上**：
 *
 *   node 腿   V8 的采样器**只能在进程启动时**开（`--cpu-prof`），所以把自己**重新 exec
 *             一遍**：`node --cpu-prof … src/cli.js <原样 argv>`。一次都不用编。
 *   native 腿 `dist/omni` 里**已经链着我们自己那台采样器**（量出来的：
 *             `nm dist/omni | grep omni_prof` = 4 格），而它的定时器**任何时刻都能开** ——
 *             所以那条腿的正解是「当场开」，连子进程都不必多开，更不必重编自己。
 *             这一格现在还差一根线：`omni_prof_sample_start` 还没进 C ABI 表
 *             （`hir/c_abi.js`）—— 那是任务 #46。在它接上之前，这儿明说那条**不用重编**
 *             的等价写法：`OMNI_PROF=sample:hz ./dist/omni …`。
 *
 * 防递归：给孩子带一格 `OMNI_PROF_SELF=1`，孩子看见就不再 re-exec（照常干活）。
 */
function runSelfProfile(p) {
  if (p.who !== 'builtin') {
    throw new OmniError(`--profile-with ${p.who}：现在只有 builtin（我们自己那台）。`
      + '系统那几台（macOS 的 /usr/bin/sample、Linux 的 perf、Instruments 的 xctrace）'
      + '不用重编就能 attach，但要一格转换器把它们的输出摊成折叠栈 —— 记在任务 #47');
  }
  if (!hasJsEngine()) {
    throw new OmniError('这一代（原生构建）量自己还差一根线：采样器**已经在这个二进制里**'
      + '（不用重编），但把它当场打开那一格 op 还没进 C ABI（任务 #46）。'
      + `现在用等价的写法，一次都不用编：OMNI_PROF=sample${p.hz > 0 ? `:${p.hz}` : ''}`
      + ` OMNI_PROF_OUT=/tmp/omni.folded <这个二进制> ${p.rest.join(' ')}`
      + '，回来 `omni flame /tmp/omni.folded --table`');
  }
  if (p.mode !== 'sample') {
    throw new OmniError(`--profile ${p.mode}（量自己）：node 腿上只有 sample —— `
      + 'cc 要外部 C 编译器插桩（那是量生成的 C 用的），stub 是我们发射期插的那一对'
      + '（量被编译的程序用的）。量自己就 `--profile sample[:hz]`');
  }
  const dir = workDirFor('prof-self', hash16(p.rest.join(' ')));
  mkdirAll(dir);
  const file = join(dir, 'self.cpuprofile');
  if (exists(file)) writeText(file, '');
  const us = p.hz > 0 ? Math.max(1, Math.round(1000000 / p.hz)) : 0;
  const pre = ['--cpu-prof', '--cpu-prof-dir', dir, '--cpu-prof-name', 'self.cpuprofile',
    ...(us > 0 ? ['--cpu-prof-interval', `${us}`] : [])];
  const script = join(installDir(), '..', 'cli.js');
  setEnv('OMNI_PROF_SELF', '1');
  const st = spawn('node', [...pre, script, ...p.rest], 'i')[0];
  vStep(`node --cpu-prof ${script} ${p.rest.join(' ')}  exit=${st}（量自己那一趟）`);
  const raw = exists(file) ? readText(file) : '';
  if (raw === '') {
    stderr('omni: 量自己：node 没落下 .cpuprofile —— 这个 node 版本没有 --cpu-prof？\n');
    return st;
  }
  const folded = cpuProfileToFolded(raw);
  if (p.out !== null) {
    writeText(p.out, folded);
    stderr(`omni: 折叠栈 -> ${p.out}（量自己 · node 腿 · V8 采样器）\n`);
    return st;
  }
  profViews(folded, `omni prof（量自己：${p.rest.join(' ')}）`, 'us');
  return st;
}

/**
 * 回到这一层了：到点了就是被时限打断的那一趟（子进程那一路）。印那句话、回 124。
 *
 * 本进程那一路走不到这儿 —— 看门狗那一枪之后没有"之后"，那句话由它自己印。
 */
function runTimedOut() {
  if (RUN_DEADLINE === 0 || nowMs() < RUN_DEADLINE) return false;
  stderr(RUN_TIMEOUT_MSG);
  return true;
}

/**
 * 嵌套地跑一趟 `main`（链一次、先把几份 `.c` 编成 `.o` …）。
 *
 * 与直接调 `main` 的差别只有一件事：内层**不重置**那几格全局开关（`MAIN_NEST`）。
 * 于是外层的 `-v` / `--stats` 一路活到最后一行，而内层那一趟也照外层的开关记账。
 */
function subMain(argv) {
  MAIN_NEST++;
  /* 内层抛出去的时候这个计数就不还原了 —— 那一趟整个是要失败退出的，
   * 而 `main` 没有 try/finally（这一层不为「反正要退出」的路径加结构）。 */
  const rc = main(argv);
  MAIN_NEST--;
  return rc;
}

function main(argv) {
  /**
   * **量自己那一格摆在最前面**（第一百五十片）：`omni --profile sample glr …` ——
   * 开关在动词**前面**就是「量这一趟 omni 自己」。要在 `findCmd` 之前剥掉它，
   * 因为命令树是按「第一个词是不是动词」走的，前缀里那几格开关会把它拦在门口。
   *
   * 孩子那一趟（带着 `OMNI_PROF_SELF=1`）**只剥不量**：它就是被量的那个进程，
   * 再量一次就是无限递归。
   */
  const selfP = selfProfPrefix(argv);
  if (selfP !== null) {
    if (env('OMNI_PROF_SELF') === '1') return main(selfP.rest);
    return runSelfProfile(selfP);
  }
  /* 分派走命令树（ADR-0018 决策四）：走到哪个节点、那个节点认识哪些带值开关，都由
   * `cli/cmds.js` 那份数据说 —— 顶层不再认识 `--image-base` / `-isystem` 这种语言与格式
   * 特有的东西。从前这儿有一坨 26 个 `||` 在列举全程序每一个带值开关，那就是耦合的
   * 物理形式（见 `cli/tree.js` 头上那段）。 */
  const { node, path: cpath, rest: raw } = findCmd(ROOT, argv);
  /* 别名铺平成规范名（`-f` -> `--format`）：底下那 28 段实现是自己在 `rest` 上找开关的，
   * 不认识新加的短写法 —— 量到过 `c obj -f elf` 出来是 Mach-O。见 `canonicalize`。 */
  const rest = canonicalize(node, raw);
  // --verbose 要在做任何事之前生效，否则第一步的耗时就丢了。
  // `-v` 只有在**这个节点没把它当别的意思**时才算 --verbose（`omni c cpp -v` 是 tcc 的 -v）。
  //
  // 这儿曾经紧跟着一行 `VERBOSE = rest.includes('--verbose') || rest.includes('-v')` ——
  // 上一片加 `ownsVerbose` 时旧的那行没删掉，而它在后面，于是**把这一行整个盖掉了**。
  // 没门抓到它：`omni c cpp -v` 的那些门只比 stdout，而 `--verbose` 写 stderr。
  //
  // **嵌套那几趟不重置这三格**（见 `MAIN_NEST` 那段）：内层的 argv 里没有 `-v`，
  // 重置一次就把外层的账掐断了。内层照样按外层的开关印自己的步骤。
  const nested = MAIN_NEST > 0;
  if (!nested) {
    VERBOSE = rest.includes('--verbose') || (!ownsVerbose(node) && raw.includes('-v'));
    STATS = rest.includes('--stats');
    LANGS_FAT = rest.includes('--fat');
    /* `--sysroot DIR`：头与库都只从 DIR 里取。目标由 `--arch`/`--os` 说。
     *
     * **不给 `--sysroot` 也能交叉编译**（第一百四十六片）：目标与本机不同、或者要
     * `--libc self`（那一份 libc 的头就在 sysroot 里）时，按目标去取**自带的那一份**
     * `src/sysroot/<arch>-<os>`。于是常用的两条写法各少一个开关：
     *   omni build x.omni --arch x86_64 --os linux     （交叉到 Linux）
     *   omni build x.omni --libc self                  （本机，纯静态）
     * 取不到就明着骂（自带的只有两个目标）—— 悄悄按本机编出来的东西，拿到目标机器上
     * 才发现不对，那笔账最贵。
     *
     * **只有 `build`/`run`/`plugins` 这几条推**：`omni c obj|link` 是**低一层的工具**
     * （对着 `cc` 的口径），那一层「头从哪儿来」得写明白 —— 判据里那些交叉编探子正是
     * 靠「不给 sysroot 就用本机 SDK 的头」在跑的，推一手会悄悄换掉它们的尺子。 */
    const bi = rest.indexOf('--libc');
    LIBC = bi < 0 ? null : rest[bi + 1];
    const si = rest.indexOf('--sysroot');
    const infer = node.key === 'build' || node.key === 'run' || node.key === 'plugins';
    if (si >= 0) {
      CROSS = { ...cTgt(rest), sysroot: rest[si + 1] };
    } else if (infer) {
      const tgt = cTgt(rest);
      const cross = tgt.arch !== hostArch() || tgt.os !== hostOs();
      CROSS = (cross || LIBC === 'self') ? { ...tgt, sysroot: bundledSysroot(tgt) } : null;
    } else {
      CROSS = null;
    }
    /* `--cc CC`：生成的 C 交给谁（`self` = 我们自己那台）。比 `OMNI_CC` 优先。 */
    const ci = rest.indexOf('--cc');
    CC = ci < 0 ? null : rest[ci + 1];
    /* `--no-trim`：不裁产物里的运行时那一段（逃生门，见 `NO_TRIM` 头上那段）。 */
    NO_TRIM = rest.includes('--no-trim');
    /* `--lang-directive`：认不认第一行的 `#lang`（ADR-0037，默认不认）。
     * 环境那一格是给 `spawn` 出去的孩子继承用的（自举链里那几趟子进程），与 `OMNI_PROF` 同一手法。 */
    LANG_DIRECTIVE = rest.includes('--lang-directive') || env('OMNI_LANG_DIRECTIVE') === '1';
    /* `--profile MODE`（第一百四十七片）：`cc` | `sample[:hz]` | `stub`。
     *
     * 三档落在三个**不同的时刻**，所以这一格要早解析：`stub` 改的是发射期（生成的 C 里
     * 多一对计时），`cc` 改的是外部 cc 的开关（`-finstrument-functions`），`sample` 一个
     * 字节都不改二进制 —— 它是运行期的环境变量。前两档进可执行文件的缓存印记，后一档不进。 */
    const pi = rest.indexOf('--profile');
    if (pi < 0) {
      PROF = null;
    } else {
      const raw = rest[pi + 1] === undefined ? 'cc' : rest[pi + 1];
      const colon = raw.indexOf(':');
      const mode = colon < 0 ? raw : raw.slice(0, colon);
      const hz = colon < 0 ? 0 : Number(raw.slice(colon + 1));
      if (mode !== 'cc' && mode !== 'sample' && mode !== 'stub') {
        throw new OmniError(`--profile ${raw}：认的是 cc | sample[:hz] | stub`
          + '（cc = 编译器自己插桩，sample = 定时器采样，stub = 我们发射期插的那一对）');
      }
      const oi = rest.indexOf('--profile-out');
      PROF = { mode, hz: Number.isFinite(hz) ? hz : 0, out: oi < 0 ? null : rest[oi + 1] };
      /* **认腿**（第一百四十七片第四格）：后端不只有 C 一条，而三档各只在有那台机制的腿上
       * 成立。不成立就当场报（`profCheckLeg` 里那几句），不许收下开关然后印一张空表。
       * 第二个实参是**源文件**（`srcArg`）—— 从前这儿错传了 `cpath`（那是**命令**路径，
       * 像 `['run']`），于是 `.c` 那条腿一次都没认出来：量到的原话是
       * `run x.c --profile sample --cc clang` 报「js 这条腿上没有这台机器」。 */
      PROF.leg = profLeg(node.key, srcArg(node, rest), rest);
      profCheckLeg(mode, PROF.leg);
      /* `--profile-out x.svg`：**火焰图**。运行时那一层只会写折叠栈（它在信号里，不该
       * 干渲染这种事），所以这儿把落点换成 `x.svg.folded`，收尾时再摊成 SVG
       * （见底下那个汇合点）。给 `.folded` 之类别的后缀就原样落，不多此一举。 */
      if (PROF.out !== null && PROF.out !== undefined && PROF.out.endsWith('.svg')) {
        PROF.svg = PROF.out;
        PROF.out = `${PROF.out}.folded`;
      }
      /* 从前这儿有一句「`cc` 那一档要外部编译器」的硬拒绝。作废了（第一百五十片第三格）：
       * 我们自己那台 C 前端现在**有** `-finstrument-functions` 的等价物（`emitProfCall`），
       * 两条 C 腿（生成的 C 与 `.c` 输入）上都是它插的桩。别的腿上仍旧没有这台机器，
       * 那由 `profCheckLeg` 按腿说 —— 不再按"编译器是谁"一刀切。 */
      /* `sample` 是运行期的事：设进环境，`spawn` 出去的孩子自己继承（与 `-f svg` 同一个手法）。 */
      if (mode === 'sample') setEnv('OMNI_PROF', hz > 0 ? `sample:${hz}` : 'sample');
      if (PROF.out !== null && PROF.out !== undefined) {
        setEnv('OMNI_PROF_OUT', PROF.out);
      } else if (PROF.leg === 'c' || PROF.leg === 'c-src') {
        /**
         * **没给 `--profile-out` 时也把折叠栈捞回来**（第一百四十九片）：C 那几条腿的表是
         * 孩子自己印的（`omni_prof.c` 的 atexit），而热路径 / 调用树 / 调用边这三张只有
         * **CLI 这一层**算得出来 —— 它要那份聚合回溯。所以偷偷给它一个落点，回来自己读。
         *
         * **三档都要**（第四格补的）：`cc` / `stub` 那两档的影子栈本来就在手边，
         * 记下来的调用栈是**精确**的（权重是微秒的自用时间），比采样估的还准 ——
         * 用户那句话是对的：backtrace 不是只有采样才做得到。
         *
         * 只有 C 那两条腿走这儿：js 腿的 stub 收集器在被跑的那份 JS 里，账从
         * `profJsFinish` 那条路回来（那边直接拿到折叠栈，不落盘）。
         *
         * `tmpOut` 与 `out` 分开记：`out` 是用户要的产物（要印一句"落在哪儿"），
         * `tmpOut` 是这一趟的中间物（不印路径，只印那几张表）。
         */
        PROF.tmpOut = join(
          workDirFor('prof-folded', hash16(`${srcArg(node, rest) ?? ''}|${mode}|${hz}`)),
          'omni.folded',
        );
        mkdirAll(dirname(PROF.tmpOut));
        if (exists(PROF.tmpOut)) writeText(PROF.tmpOut, '');
        setEnv('OMNI_PROF_OUT', PROF.tmpOut);
      }
    }
    /* `--stat`（第一百四十七片第二格）：构建统计与模块依赖图。 */
    STAT = rest.includes('--stat') ? { out: null } : null;
    const si2 = rest.indexOf('--stat-out');
    if (si2 >= 0) {
      if (STAT === null) STAT = {};
      STAT.out = rest[si2 + 1];
    }
  }
  /* 发现插件摆在这儿而不是模块作用域：一来 `-v` 刚解析出来，装了哪几格才印得出来；
     二来插件装不上是**响错**，那句话得走 main 的错误出口（模块作用域抛出来的话，
     连 `omni help` 都印不出来了 —— 一格坏插件不该让整个 CLI 说不出话）。 */
  /* 计时的基准点在这儿起：发现插件是**第一步**，而 vMark 从前是等到进管线才置的 ——
     量出来的：第一行印成 `[1789012444800ms]`（拿 0 当基准，等于整个 epoch）。
     嵌套那几趟不动它：内层这一趟本身就是外层的一个步骤，重置一次外层那一行的耗时就少了。 */
  if (!nested) vMark = nowMs();
  discoverPlugins();
  if (!nested) vMark = nowMs();
  /* `--help` 在**任何一级**都由同一个函数处理：`findCmd` 走到第一个不是子命令名的记号就停，
   * 所以 `omni c --help` 落在 `c` 上、`omni c link --help` 落在 `link` 上，不必特判。 */
  if (argv.length === 0 || rest.includes('--help') || rest.includes('-h')) {
    stdout(renderHelp(node, cpath));
    return 0;
  }
  if (cpath.length === 0) {
    throw new OmniError(`unknown command '${argv[0]}'\n${renderHelp(ROOT, [])}`);
  }
  /* 组节点（`omni c`、`omni glr`）少了子命令就印它的清单。`glr` 那一组自己也带 `key`
   * （旧的扁平写法 `omni glr FILE.grammar FILE...`），所以判据是「有子命令可选、可一个
   * 位置参数都没给」，不是「有没有 key」。 */
  if ((node.children ?? []).length > 0 && rest.filter((a) => !a.startsWith('-')).length === 0) {
    stdout(renderHelp(node, cpath));
    return rest.length === 0 ? 0 : 1;
  }
  if (node.key === undefined) {
    stdout(renderHelp(node, cpath));
    return 1;
  }
  /* **出 JS 产物的那两条得全内建**（ADR-0021 的 S4）：JS 宿主没有 dlopen（host/native.js
     的 pluginsOk），装不动插件 —— 编出来的 `omni.mjs` 要是也只剩驱动，那它一门语言都不认，
     自举链第二道门槛（C2 = C1 emit-js）当场报"这份 omni 里一门语言都没装"。
     C 那条产物照旧是薄核心 + plugins/。 */
  if (node.key === 'emit-js' || node.key === 'build-js') LANGS_FAT = true;
  /* `omni c tcc`（决策三）：它自己一套解析器（tcc 的 `-v`/`-r`/`-f` 与 omni 的不同义），
   * 翻成「哪一条 omni 命令 + 那条命令的 argv」之后**原路再走一遍** —— 实现一份都不复制，
   * 而且别处的规矩（别名铺平、`splitArgv`、`--explain`、`-v` 那张表）自动都适用。
   *
   * 这一段**必须在 `splitArgv` 之前**：`c tcc` 这个节点故意不声明 flags（声明了反而会被
   * 按 omni 的规矩动手），而 `splitArgv` 现在见到不认识的开关就骂 —— 排在后面的话
   * `c tcc -B … -c …` 会被自己这一层挡下来。 */
  if (node.key === 'c-tcc') {
    const t = tccTranslate(raw, (m) => new OmniError(m), { arch: hostArch(), os: hostOs() });
    const AT = {
      cpp: ['c', 'cpp'], 'c-obj': ['c', 'obj'], 'c-run': ['c', 'run'],
      'elf-r': ['c', 'elf-r'], 'elf-link': ['c', 'elf-link'],
      'macho-link': ['c', 'macho-link'], 'pe-link': ['c', 'pe-link'],
    };
    if (AT[t.key] === undefined) throw new OmniError(`c tcc: 还翻不到 '${t.key}'`);
    /* 链接那三条要先把 `.c` 编成 `.o`（tcc 的「编 + 链一步走」），并补上默认 libc。 */
    if (t.key === 'elf-link' || t.key === 'macho-link' || t.key === 'pe-link') {
      const p = tccPrepLink(t.argv);
      const rc = subMain([...AT[t.key], ...p.argv]);
      if (rc === 0 && p.os !== 'win32') spawn('chmod', ['+x', p.out], 'c');
      return rc;
    }
    return subMain([...AT[t.key], ...t.argv]);
  }
  const { args } = splitArgv(node, rest, (m) => new OmniError(m));
  /* 位置参数就是「文件」：链接器与 `glr` 要一整串，别的只看第一个。 */
  const files = args;
  let cmd = node.key;
  let path = args[0];

  if (cmd === 'help') {
    stdout(args[0] === 'legacy' ? renderLegacy(LEGACY) : renderHelp(ROOT, []));
    return 0;
  }
  /* `emit FORM FILE`（决策一）：把那 9 条 `emit-*`/`ast`/`oir`/`mir`/`sx` 收成一个动词
   * 加一个枚举。这一片只做**翻译**——底下还是原来那几段实现。 */
  if (cmd === 'emit') {
    const FORMS = {
      js: 'emit-js', c: 'emit-c', llvm: 'emit-llvm', spirv: 'emit-spirv',
      asy: 'emit-asy', ast: 'ast', oir: 'oir', mir: 'mir', sx: 'sx',
    };
    const form = args[0];
    cmd = FORMS[form];
    if (cmd === undefined) {
      throw new OmniError(`emit: 不认识形态 '${form}'；有 ${Object.keys(FORMS).join(' ')}`);
    }
    path = args[1];
    /**
     * **`.c` 的形态不是同一套**：C 的终点是 MIR，它**不经过 OIR**（`case 'c-mir'` 那条腿
     * 是 `cMir`：预处理 -> C 前端 -> MIR，中间没有 OIR 这一层）。
     *
     * 从前这一格漏了，`emit mir x.c` 一路掉到 omni 的前端上报
     * `unexpected character: "#"` —— 与 `run`/`build` 那两处是**同一个 bug**：
     * 「前端由扩展名选」这条规矩得在每一个入口都写一遍，漏一个就是一个假象。
     */
    if (path !== undefined && path !== null && path.endsWith('.c')) {
      if (form === 'mir') cmd = 'c-mir';
      /* `js`：MIR -> JS 源码（ADR-0013）。它与 `emit mir` 是同一条腿的两个出口 ——
       * 一个是给人读的 IR，一个是给 V8 吃的产物。**声明了就得能用**：`run x.c
       * --backend js` 跑的就是这段文本，那 `emit js x.c` 就得能把它印出来。 */
      else if (form === 'js') cmd = 'c-emit-js';
      /* `llvm`：C -> **原生** MIR -> LLVM IR（ADR-0022 的 J4）。C 是外部符号最多的一条腿
       * （libc 那一族全是 extern 函数与 CCALL），所以它同时是"LLVM 这条腿能不能调外部
       * C 函数"的验收面。 */
      else if (form === 'llvm') cmd = 'c-emit-llvm';
      else {
        throw new OmniError(`emit ${form} x.c: 没有这一条 —— C 的终点是 MIR，`
          + '不经过 OIR，所以 `.c` 只有 `omni emit mir`（IR）、`omni emit js`'
          + '（MIR -> JS 源码）与 `omni emit llvm`（原生 MIR -> LLVM IR）；'
          + '要目标文件用 `omni c obj`，要可执行文件用 `omni build`');
      }
    }
  }
  /* `run` 的时限（默认 30s，见 armRunTimeout）。摆在这儿而不是各条腿里：`--backend` 会
   * 把 `run` 换成另一条 case（`run-c`/`interp`/`c-run`…），而判据是**用户敲的那个动词**
   * （`node.key`）—— 一条腿都不能漏，漏掉的那条就是「按了 --timeout 却还在挂着」。 */
  if (node.key === 'run') armRunTimeout(rest);
  /**
   * **借来的那些语言也是这条链的前端**，与 `.c` 同一条规矩（前端按扩展名选）。
   *
   * 它们的前端出来的是**核心方言**（`.sx`），而 `.sx` 这条输入下游什么都齐了：
   * lower -> OIR -> MIR -> 原生 / js / llvm，加上 `--cc`、`OMNI_MIR_OPT`、摇树、
   * profile、增量暖存。所以这儿只做一件事：译出那份 `.sx`、落进暖存、把 `path` 换成它，
   * 剩下的照 `.sx` 原样走 —— 下游一行都不用再写一遍。
   *
   * 后缀名单**从 `langs.js` 那张表算**（`borrowedExts()`），不在这儿手抄：加一门语言
   * 只改登记那一处。映射还没接住的形状照旧报"这一格还没接"（有名有姓，退出码 1）。
   *
   * **已经有主的后缀不抢**（`lang(path) !== null`）：`.lua` 有一台自己的读入器
   * （`lua.toSx` 那格插件，比这边的映射全），抢过来就是把一条已经通的路换成一条有缺口的路。
   * 量到过：`run ext/lua/examples/basics.lua` 从"跑出答案"变成"这一格还没接：sumto"。
   *
   * 从前这条线只存在于 `bench/go/run.js` 里的两条命令（先 `--backend core -o x.sx`，
   * 再 `build x.sx`）：命令行上没有任何一条路能从 `.go` 走到二进制。
   *
   * **只在"编这份源码"那几个动词上接管**（run / build / emit / check）。`glr parse x.ss`、
   * `c obj x.c` 那些动词吃的是**这份文件本身**，把 `path` 换掉就等于换了它们的输入 ——
   * 量到过：不加这条判断，`glr` 与 `sexpr` 两套判据整套翻红。
   *
   * `--engine graph` 给了就不接管 —— 那是点名要另一层的后端（interp/js/wat/c/sx）。
   */
  if (path !== undefined && path !== null && !rest.includes('--engine')
      && ['run', 'build', 'emit', 'check'].includes(node.key)
      && lang(path) === null && borrowedExts().some((e) => path.endsWith(e))) {
    const sx = coreSxText(path, rest);
    if (sx === null) return 1;
    /* 内容定址：同一份源码只译一次，改一个字就换一格目录 —— 陈旧产物不会被误用。
     * 文件名保留原来的主干（`pt.go` -> `pt.sx`），这样 `build` 不给 `-o` 时默认名还是 `pt`。 */
    const sxDir = join(cacheRoot(), 'src-sx', hash16(sx));
    mkdirAll(sxDir);
    const sxPath = join(sxDir, `${basename(path, path.slice(path.lastIndexOf('.')))}.sx`);
    if (!exists(sxPath)) writeText(sxPath, sx);
    if (VERBOSE) stderr(`omni: ${path} -> ${sxPath}（核心方言，${sx.length} 字节）\n`);
    path = sxPath;
    files[0] = sxPath;
  }
  /**
   * **`--engine graph`（第十八批）：切到节点图那台机器**（ADR-0033 + 契约五问）。
   *
   * 摆在这儿的理由与 `.c` 那一处一模一样：下面那张 `--backend` 表会把 `run` 改写成
   * 别的动词（`--backend interp` -> `cmd = 'interp'`），改写完就绕过 `case 'run'` 里
   * 按扩展名分派的那条规矩。而图这一层的 `--backend` 是**它自己那四条**
   * （interp / sx / js / wat），与 OIR 那条腿的同名参数不是一回事 ——
   * **分派必须在 backend 翻译之前**。
   *
   * 语言由 `--lang` 定，没给才按后缀猜（`graph/langs.js`）。
   */
  if (node.key === 'run' && rest.includes('--engine')) {
    const ei = rest.indexOf('--engine');
    const eng = ei + 1 < rest.length ? rest[ei + 1] : null;
    if (eng === 'graph') {
      if (path === undefined || path === null) throw new OmniError('run --engine graph 要一个源文件');
      return runGraphFile(path, rest);
    }
    if (eng !== null && eng !== 'omni') {
      throw new OmniError(`没有 --engine ${eng} 这一条 —— 现在两台：omni（默认，前端 -> OIR -> 后端）`
        + '与 graph（节点图 + 契约五问，见 `omni run --help`）');
    }
  }
  /* `run --stat` 在 js 那条腿上现在**有账可报**（时间 + 各层的账，见 `statReport`）；
   * 别的腿（llvm / jit / interp）还没接上那张表 —— 一声不响是最坏的，所以说一句。 */
  if (node.key === 'run' && STAT !== null && !rest.includes('--engine')
    && rest.indexOf('--backend') >= 0) {
    stderr('omni: run --stat：这一趟的后端还没接上那张表 —— js 腿（默认）与 '
      + '`--engine graph` 有，`build --stat` 上是全的\n');
  }
  /* `build --engine graph -o OUT`：把那条腿的产物落成文件（wat / sx 有产物，
   * js 与 interp 各有一句说清为什么没有 —— 见 `graph/run.js` 的 buildGraphFile）。 */
  if (node.key === 'build' && rest.includes('--engine')) {
    const ei = rest.indexOf('--engine');
    const eng = ei + 1 < rest.length ? rest[ei + 1] : null;
    if (eng === 'graph') {
      if (path === undefined || path === null) throw new OmniError('build --engine graph 要一个源文件');
      return buildGraphFile(path, rest);
    }
    if (eng !== null && eng !== 'omni') {
      throw new OmniError(`没有 --engine ${eng} 这一条 —— 现在两台：omni 与 graph`);
    }
  }
  /* `run`/`build --backend B`（决策一）：同样先只做翻译。 */
  if (cmd === 'run' || cmd === 'build') {
    const bi = rest.indexOf('--backend');
    const b = bi >= 0 ? rest[bi + 1] : null;
    /**
     * **`.c` 先由扩展名说话，再谈 backend。**
     *
     * C 的终点是 **MIR**，不是 OIR —— 所以它那几条腿与 omni 的不是一套：
     *   - `native`（默认）：自带 C 前端 + 自带代码生成 + 自带链接器，编 + 链（+ 跑）
     *   - `interp`：C -> MIR -> MIR 解释器（那是 oracle，慢一个数量级）
     *   - `js`/`llvm`/`jit`：**没有**这条路（`backend-js` 吃的是 OIR）
     *
     * 从前这一格漏了：`--backend interp` 把 `cmd` 换成 `'interp'`，`.c` 就绕过了
     * `case 'run'` 里那条按扩展名分派的规矩，一路掉到 omni 的前端上 ——
     * 报的是 `unexpected character: "#"`。分派**必须在 backend 翻译之前**。
     */
    if (path !== null && path !== undefined && path.endsWith('.c')) {
      const native = b === null || b === 'native' || b === 'c';
      if (cmd === 'run') {
        if (native) return runCFile(path, rest);
        if (b === 'interp') cmd = 'c-run';
        /* `js`：C -> MIR -> **JS 源码** -> `new Function`（ADR-0013）。
         * 这一条是 JS 宿主上 C 的**快**路：解释器落在 10 倍上，这一条贴着「编成 JS」
         * 那条 1.5 倍的基线 —— 差别不是 dispatch，是「不再有解释循环」。
         * 它也是**浏览器里跑 C** 的那条路。 */
        else if (b === 'js') cmd = 'c-run-js';
        else {
          throw new OmniError(`run x.c: 没有 --backend ${b} 这一条 —— C 的终点是 MIR，`
            + '只有 native（默认：编 + 链 + 跑）、js（MIR -> JS 源码，node 宿主上最快的那条）'
            + '与 interp（MIR 解释器，oracle）三条');
        }
      } else if (native) {
        return buildCFile(path, rest);
      } else if (b === 'js') {
        /* `build --backend js`：出一份**能直接 `node` 跑**的 JS。它不是自足的 ——
         * 线性内存与 libc 走这棵树里的 `mir/js_rt.js`（那一份只是转发表，实现在
         * `interp/builtin.js` 与 `interp/libc.js`）。为什么不内联那两份进产物：
         * 那就是两处实现，而「五方逐字节相同」这道门要求只有一份。 */
        const oi = rest.indexOf('-o');
        const out = oi >= 0 ? rest[oi + 1] : `${basename(path, '.c')}.js`;
        const { flags, prog } = cSplitArgs(rest);
        const mir = cap('c.toMir')(path, incDirs(flags), defArgs(flags), prog, sysIncDirs(flags), cTgt(flags));
        const text = emitMirJs(mir, { rtImport: join(installDir(), '..', 'mir', 'js_rt.js') });
        writeText(out, text);
        stderr(`omni: built ${out} (${text.length} 字节，MIR -> JS；`
          + '运行时来自这棵树里的 mir/js_rt.js)\n');
        return 0;
      } else if (b === 'interp') {
        /* `.c` 那条腿的解释器吃 **MIR**（不经过 OIR），所以 `--backend interp` 的产物
         * 就是那份 MIR。**声明了就得能用** —— `build --help` 里列了它，那它就得落一个文件，
         * 而不是回一句「没有这一条」。 */
        const oi = rest.indexOf('-o');
        const out = oi >= 0 ? rest[oi + 1] : `${basename(path, '.c')}.mir`;
        const { flags, prog } = cSplitArgs(rest);
        const text = printMir(cap('c.toMir')(path, incDirs(flags), defArgs(flags), prog, sysIncDirs(flags), cTgt(flags)));
        writeText(out, text);
        stderr(`omni: built ${out} (${text.length} 字节，MIR —— 解释器吃的就是这一层；`
          + '喂回去跑还差「可回读的 IR」那一格，见 ADR-0018)\n');
        return 0;
      } else {
        throw new OmniError(`build x.c: 没有 --backend ${b} 这一条 —— C 有 native`
          + '（编 + 链）、js（MIR -> JS 源码）与 interp（出 MIR）三条');
      }
    }
    const MAP = {
      run: { c: 'run-c', llvm: 'run-llvm', jit: 'run-jit', interp: 'interp', js: 'run' },
      build: { llvm: 'build-llvm', c: 'build', native: 'build', js: 'build-js', interp: 'build-interp' },
    };
    /* `.c` 那几条已经在上面按扩展名定完了（`c-run` / `c-run-js`），**不能再进这张表** ——
     * 这张表是 OIR 那条腿的。少这一句就是「backend 又抢在扩展名前面」那个老 bug 的
     * 第四次（前三次分别在 run / build / emit 上）。 */
    if (b !== null && cmd !== 'c-run' && cmd !== 'c-run-js') {
      const t = MAP[cmd][b];
      if (t === undefined) {
        /**

         * `--backend interp` 该出什么？**「解释器能吃的那份 IR 文件」** —— 这是对的，
         * 与 native 出可执行文件、js 出 `.js` 是同一条契约。
         *
         * 缺的不是一个开关，是 **IR 的可回读形态**：现在两个 IR 落地的形式都**只写不读** ——
         *   - `emit oir` 的 JSON 是**有损**的：`replacer` 丢掉 `span`/`ast`，`i64` 变成
         *     `"2n"` 这样的字符串。它的身份是快照与给人看，不是序列化。
         *   - `mir/bytes.js` 是**摘要**（`funcHash`/`moduleHashes`，增量编译的 key），
         *     不是一份能读回来的字节形式。
         * 所以先有「可回读的 IR」，才有这个产物 —— 不然出来的是个**假产物**
         * （落了盘却喂不回去）。这一格记在 ADR-0018。
         */
        if (b === 'interp') {
          throw new OmniError('build: --backend interp 该出「解释器能吃的那份 IR 文件」，'
            + '而两个 IR 现在都只写不读（emit oir 的 JSON 有损、mir/bytes.js 是摘要）——'
            + '缺的是 IR 的可回读形态，不是一个开关（见 ADR-0018）。'
            + '现在：`omni emit oir FILE` / `omni emit mir FILE` 看，'
            + '`omni run FILE --backend interp` 跑');
        }
        throw new OmniError(`${cmd}: 还没有 --backend ${b} 这一条`);
      }
      cmd = t;
    }
  }
  /* `c link -f FMT`（决策二）：格式是**目标的一个属性**，不是命令的一级。这一片先翻译到
   * 原来那四条实现上，四合一是分片 4 的事。
   * 不给 `-f` 就按**这台机器**（第一百四十七片）—— 从前是硬要一个，而「链出本机能跑的
   * 东西」是最常见的那一次，不该每回都写一遍。 */
  if (cmd === 'c-link') {
    const fi = rest.indexOf('--format') >= 0 ? rest.indexOf('--format') : rest.indexOf('-f');
    const f = fi >= 0 ? rest[fi + 1] : fmtOfOs(hostOs());
    if (f === 'elf') cmd = rest.includes('-r') ? 'elf-r' : 'elf-link';
    else if (f === 'macho') cmd = 'macho-link';
    else if (f === 'pe') cmd = 'pe-link';
    else throw new OmniError(`c link: 不认识格式 '${f}'；有 elf macho pe`);
    /* `--stdlib`：tcc 的 `tcc_add_runtime` + `tccelf_add_crtbegin/end` 那一份 ——
     * 默认 libc 加上 crt 那三个 `.o`，入口跟着换成 `_start`。
     *
     * 为什么摆成一个开关而不是默认：`c link` 的四条腿也用来链**不带 libc 的东西**
     * （交叉编译的目标、`-nostdlib` 那一路、我们自己的那些字节判据），tcc 那边这件事
     * 是 `-nostdlib` 反过来说的。摆成开关，「要一份能跑的可执行文件」的调用方
     * （`omni build`、`omni run`、selfc 那条轴）就只写一个词，不必各自去拼三份清单
     * —— 少一处拼错的机会（selfc 那条轴在 Linux 上就是这么漏掉 libc 的：
     * 容器里量到 `undefined symbol: stdout` 与 `undefined symbol: dlopen`）。 */
    if (rest.includes('--stdlib')) {
      const si = rest.indexOf('--os');
      const os = si >= 0 ? rest[si + 1] : hostOs();
      /* `--sysroot` 那一路不找本机的 crt 与 libc —— 那些属于**目标平台**，
       * 而交叉编译时它们不在这台机器上。库全靠 sysroot/lib 里的 `.def`。
       * crt 那三个 `.o` 也从 sysroot/lib 里取（容器里拷过来的）。 */
      /* 没写 `--sysroot` 时落回 `CROSS`（`main` 一进门按目标算出来的那一份自带的，
       * 第一百四十六片）—— 于是 `c link --libc self` 也不必再写一遍路径。 */
      const sysroot = rest.indexOf('--sysroot') >= 0 ? rest[rest.indexOf('--sysroot') + 1]
        : (CROSS === null ? null : CROSS.sysroot);
      /* `--libc self`（第一百四十片）：**我们自己那份 libc**，一个外部库都不链。
       *
       * 来源是 `<sysroot>/libc/*.c` —— 用我们自己的 C 前端编，底下踩的是
       * `__omni_syscall` 那条内建（见 `mir/ir.js` 的 `SYSCALL`）。于是链出来的
       * 可执行文件是**纯静态**的：没有 `DT_NEEDED`、没有解释器、没有 crt。
       * 量到的（容器里 `ldd`）：`statically linked`。
       *
       * 为什么与 `--sysroot` 绑在一起：那一份 libc 的**头**也在 sysroot 里
       * （`<sysroot>/include`），而「头与实现是同一份账」这件事只有摆在同一个
       * 目录下才守得住。libc 自己那几个 `.c` 反过来只吃 `<sysroot>/libc`
       * 里的 `syscall.h` —— 它不许看见那份给用户程序的 glibc 形状的头
       * （那边的 `FILE` 与我们的 `struct __FILE` 是两回事）。 */
      const libcSelf = rest.indexOf('--libc') >= 0
        && rest[rest.indexOf('--libc') + 1] === 'self';
      if (libcSelf) {
        if (cmd !== 'elf-link' && cmd !== 'macho-link') {
          throw new OmniError('--libc self 现在有 ELF（linux）与 Mach-O（osx）两条腿');
        }
        if (sysroot === null) throw new OmniError('--libc self 要配 --sysroot');
        const selfOs = cmd === 'macho-link' ? 'osx' : 'linux';
        const selfFmt = cmd === 'macho-link' ? 'macho' : 'elf';
        const libcDir = join(sysroot, 'libc');
        if (!isDir(libcDir)) throw new OmniError(`--libc self: 找不到 ${libcDir}`);
        /* 公用那一半（第一百四十片第五格）：`src/sysroot/libc/` —— string/math/strtox/
         * stdio/file/malloc 六份，一行 syscall 都没有，两个目标**同一份文件**。
         * 目标专有那一半在 `<sysroot>/libc/`（syscall.h、io.c、misc.c、start.c）。
         * 头的搜索次序是「先专有、后公用」：`libc.h` 里那句 `#include "syscall.h"`
         * 必须落到这台目标那一份上。 */
        const sharedDir = join(sysroot, '..', 'libc');
        const incs = isDir(sharedDir) ? [libcDir, sharedDir] : [libcDir];
        /* `start.c` 得排在最前（它是入口所在的那个 `.o`），剩下的按名字排 ——
         * 顺序稳定，于是同一份输入两次链出来逐字节相同（容器里量过）。 */
        const srcs = [];
        for (const d of incs) {
          for (const f of readDir(d)) if (f.endsWith('.c')) srcs.push(join(d, f));
        }
        srcs.sort();
        const objs = [];
        const selfArch = CROSS === null ? hostArch() : CROSS.arch;
        for (const src of srcs) {
          const base = basename(src).replace(/\.c$/, '');
          /* `.o` 的**容器一律是 ELF**（`omni c link` 读 ELF、写 macho/pe，见
           * `buildSelf` 头上那三条）。按 macho 编的 `.o` 交给它，报的是
           * 「macho: 还不会给 0 号架构写可执行文件」—— 那个 0 是把 Mach-O 的头当
           * ELF 的 `e_machine` 读出来的。第一版这儿真按 `macho` 编了，量到的就是那句。
           * 目标只由 `arch`/`os` 说（它们管 ABI 与预定义宏）。 */
          const o = join(workDirFor('libc-self', hash16(`${selfFmt}|${selfArch}|${selfOs}|${src}`)),
            base + '.o');
          cObj(src, o, selfArch, incs, [], 'elf',
            selfOs, [cap('c.sysInclude')()[0], ...incs]);
          if (base === 'start') objs.unshift(o); else objs.push(o);
        }
        files.unshift(...objs.filter((o) => o.endsWith('start.o')));
        files.push(...objs.filter((o) => !o.endsWith('start.o')));
        /* 入口的**符号名**两条腿不一样：Mach-O 的 C 符号带一条前导下划线，所以
         * C 里的 `_start` 在那边是 `__start`（ELF 上就是 `_start`）。
         * `macho_exe` 的默认入口是 `_main`（见它的文件头），不改就找不着。 */
        if (!rest.includes('-e')) rest.push('-e', selfFmt === 'macho' ? '__start' : '_start');
      } else if (sysroot !== null) {
        /* sysroot/lib 里的 `.def` 当成库的来源。格式不同，走法不同：
         *   ELF：`-L DIR/lib -lc -lm …`，findLibElf 认 `lib%s.def`
         *   Mach-O：`--dylib <.def 路径>`，loadInputs 那侧认 `.def`
         * 两条路都落到同一份 `defsyms.js`。 */
        if (cmd === 'elf-link') {
          rest.push('-L', join(sysroot, 'lib'));
          rest.push('-lc', '-lm', '-lpthread', '-ldl');
        } else if (cmd === 'macho-link') {
          /* Mach-O 那侧：每份 `.def` 当 `--dylib` 给 —— machoExe 的 loadInputs
           * 认 `.def`（`isDefSyms` 那一格岔开了 .tbd 那条路）。 */
          const sysLib = join(sysroot, 'lib');
          if (isDir(sysLib)) {
            for (const f of readDir(sysLib)) {
              if (f.endsWith('.def')) rest.push('--dylib', join(sysLib, f));
            }
          }
        }
        if (cmd === 'elf-link' && !rest.includes('--shared')) {
          /* crt 与 atexit：sysroot/lib 里的 `.c` 用我们的 C 前端编成 `.o`，
           * 不从目标机器拷二进制（与 tcc 的 `lib/dsohandle.c` 同一个思路）。 */
          const sysLib = join(sysroot, 'lib');
          const sysObj = (name) => {
            const src = join(sysLib, name + '.c');
            if (!exists(src)) return null;
            const o = join(workDirFor('sysroot-obj', hash16(src)), name + '.o');
            cObj(src, o, CROSS.arch, [], [], 'elf', CROSS.os,
              [cap('c.sysInclude')()[0], join(sysroot, 'include')]);
            return o;
          };
          const crt1 = sysObj('crt1');
          const atexit = sysObj('atexit');
          if (crt1 !== null) {
            files.unshift(crt1);
            if (!rest.includes('-e')) rest.push('-e', '_start');
          }
          if (atexit !== null) files.push(atexit);
        }
      } else {
        if (cmd === 'elf-link' && !rest.includes('--shared')) {
          const crt = cCrt(os);
          if (crt.pre.length !== 0) {
            files.unshift(...crt.pre);
            files.push(...crt.post);
            if (!rest.includes('-e')) rest.push('-e', '_start');
          }
        }
        rest.push(...cDefaultLibs(os));
      }
    }
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
      { asy: cap('asy.frontEnd'), asyPrelude: () => (env('OMNI_ASY_BUILTINS') === '0' ? '' : 'asy_builtins') },
      ei >= 0 ? rest[ei + 1] : 'interp');
  }
  /**
   * `omni plugins` —— 把**默认那一套插件**一次编齐。不用给参数：
   * 核心默认是 `dist/omni`，插件落 `dist/plugins/`，数据落 `dist/share/`。
   *
   * 核心什么都不内建（lang/builtin-core.js），所以这一条才是"让 omni 能干活"的那一步：
   * 清单在 core/plugin-set.js，一格一个 `.dylib`；`--bind` 用的是核心 `build --extern`
   * 时落下的 `.syms`（谁有哪些符号是**数据**，不是规则 —— 核心是剪过枝的）。
   */
  /**
   * `omni flame FILE.folded [-o OUT.svg]`（第一百四十七片第四格）。
   *
   * `--profile-out x.svg` 管的是**这一趟**跑出来的账；而 `OMNI_PROF=sample` 那一路是
   * **产物自己**写的折叠栈（自举出来的 `dist/omni`、交叉编出去的二进制、别人机器上那一份）
   * —— 那些文件回来之后要有一格门能渲。渲染归 CLI 这条纪律没变（运行时在信号处理器里，
   * 不干这种事），这一格就是那道门。
   */
  if (cmd === 'flame') {
    if (path === undefined || path === null) throw new OmniError('flame 要一份折叠栈文件');
    if (!exists(path)) throw new OmniError(`flame: 找不到 ${path}`);
    /**
     * **三种来源按后缀认**（第一百四十九片）：
     *   `.folded`      折叠栈（我们运行时落的：权重是**采样帧数**）
     *   `.cpuprofile`  node 的 CPU 采样（`--cpu-prof`：权重是**微秒**）
     *   `.heapprofile` node 的**分配**采样（`--heap-prof`：权重是**字节**）
     * 转换那两格都在 `cli/flame.js`（纯计算），转完之后五张表一个字都不改 ——
     * 折叠栈是它们共用的那种形式。单位跟着来源走，`--unit` 还能盖掉。
     *
     * 分配那份账为什么要：CPU 那份上 `(garbage collector)` 常年第一名（量到 14.68%），
     * 而 GC 只是**结果** —— 要修的是「谁在分配」，那只有分配采样答得出。
     */
    const isCpu = path.endsWith('.cpuprofile');
    const isHeap = path.endsWith('.heapprofile');
    /**
     * **一份账 -> 折叠栈**（按后缀认）。基线那一份也要过这儿 —— 量到过漏这一步的后果：
     * `--diff 基线.heapprofile` 把基线当折叠栈读，一行都解析不出来，表上印
     * 「合计 0.0 -> 11893.0」，看着像"这一刀把所有分配都新造出来了"。假话比没有更坏。
     */
    const foldedOf = (p) => {
      if (p.endsWith('.cpuprofile')) return cpuProfileToFolded(readText(p));
      if (p.endsWith('.heapprofile')) return heapProfileToFolded(readText(p));
      return readText(p);
    };
    const folded = foldedOf(path);
    const lines = folded.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) throw new OmniError(`flame: ${path} 里一条栈都没有`);
    const ui = rest.indexOf('--unit');
    const dflt = isCpu ? 'us' : (isHeap ? 'bytes' : 'frames');
    const unit = ui >= 0 ? rest[ui + 1] : dflt;
    /* `--diff 基线`：**两份对照**（优化循环里最有用的一张）—— 这一趟是"新"，
     * 给的那份是"基线"。只印表，不出图：图是给一份看的，对照要的是数。 */
    const di = rest.indexOf('--diff');
    if (di >= 0) {
      const base = rest[di + 1];
      if (base === undefined) throw new OmniError('flame --diff 要一份基线（折叠栈或 profile）');
      if (!exists(base)) throw new OmniError(`flame --diff: 找不到 ${base}`);
      stderr(`\nomni prof 对照（基线 ${base} -> 新 ${path}）\n`);
      stderr(foldedDiff(foldedOf(base), folded, '', 20, unit));
      return 0;
    }
    /* `--table`：把那五张读法印出来（产物自己写下来的折叠栈也该看得见热路径）。 */
    if (rest.includes('--table')) {
      profViews(folded, `omni prof（${path}）`, unit);
      return 0;
    }
    const oi = rest.indexOf('-o');
    const out = oi >= 0 ? rest[oi + 1] : `${path.replace(/\.folded$/, '')}.svg`;
    let total = 0;
    for (const l of lines) {
      const n = Number(l.slice(l.lastIndexOf(' ') + 1));
      if (Number.isFinite(n)) total = total + n;
    }
    writeText(out, foldedToSvg(folded, `omni profile —— ${total} 帧 / ${lines.length} 条栈`));
    stderr(`omni: 火焰图 -> ${out}（${lines.length} 条栈、${total} 帧`
      + '；要表就加 `--table`，要对照就 `--diff 基线.folded`）\n');
    return 0;
  }
  if (cmd === 'plugins') {
    const ci = rest.indexOf('--core');
    const core = ci >= 0 ? rest[ci + 1] : join(cwd(), 'dist', 'omni');
    const oi = rest.indexOf('-o');
    const dir = oi >= 0 ? rest[oi + 1] : join(dirname(core), 'plugins');
    const only = rest.indexOf('--only');
    const want = only >= 0 && rest[only + 1] !== undefined ? rest[only + 1].split(',') : null;
    buildPluginSet(core, dir, want, rest);
    vTally();
    return 0;
  }
  /* `omni cache`：暖存与暂存的账 + 倒垃圾（`host/cache.js`）。没有源文件参数。 */
  if (cmd === 'cache') return cacheCmd(args, rest);
  /* `omni ninja`：按一张依赖图把该做的做完（`build/cli.js`）。摆在这儿的理由与
   * bootstrap 一样 —— 它**没有源文件参数**，目标是图里的名字，别掉进下面按扩展名分派那套。 */
  if (cmd === 'ninja') return ninjaCmd(rest);
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
        /* JS 产物全内建、C 产物薄核心 —— 与 `emit js` / `emit c` 两条命令同一条规矩
           （理由在 node.key 那两行旁边）。这一格得在 compile 之前置：接缝在 readModule。 */
        LANGS_FAT = kind === 'js';
        const { mod } = compile(p, []);
        return kind === 'c' ? target('c').emit(mod) : target('js').emit(mod);
      },
      /* N1 用 `--extern` 编：它旁边那份 `.syms` 就是插件 `--bind` 要的东西
         （核心里一格语言都没有，插件是它能干活的前提）。 */
      buildTo: (p, out, work) => {
        LANGS_FAT = false;
        return buildNative(compile(p, []).mod, out, work, undefined, true).cc;
      },
      pluginsFor: (core, dir) => buildPluginSet(core, dir, null, []),
    });
    return r.fail > 0 ? 1 : 0;
  }
  if (!path) throw new OmniError(`command '${cmd}' needs a source file`);
  if (!exists(path)) throw new OmniError(`no such file: ${path}`);

  /* `--explain`（ADR-0018 决策五）：印出将要走的管线然后停 —— **一个字节都不写盘、不执行**。
   * 它看的是与实现同一批开关，所以说得准；表在动手之前就齐，这也是 `-v` 能与它共用同一份
   * 渲染的前提。C 那一条腿在分片 2（管线最长、也是逐字节对着 tcc 量的那条），
   * `emit`/`check`/`interp` 在分片 4（`plan-omni.js`）。
   *
   * **`run`/`build` 还是没覆盖**，而且那句「还没覆盖」是诚实的：那两条**边走边决定**
   * （`.asy` 那一路先问「上一趟的清单还成立吗」，命中就一步前端都不走），要造表得先把
   * 「要走哪条」提前算出来。编一条看起来合理的管线出来比明说没有更坏。 */
  if (rest.includes('--explain')) {
    const plan = planForC(cmd, path, files, rest) ?? planForOmni(cmd, path, files, rest);
    if (plan === null || plan === undefined) {
      /* 骂的时候把**为什么没覆盖**分开说：`run`/`build` 是边走边决定的（要先把「走哪条」
       * 提前算出来），而 `emit sx` 这种是「这一条在这个文件上说不通」（`.omni` 没有
       * 「前端 -> 核心方言」那一步）。混成一句话会把人往错的方向指。 */
      const why = cmd === 'run' || cmd === 'build'
        ? '这两条是边走边决定的（.asy 那一路命中缓存就一步前端都不走），'
          + '要造表得先把「走哪条」提前算出来 —— ADR-0018 分片 4'
        : `'${cmd}' 在 ${path} 上说不通，或者这一条还没造表`;
      throw new OmniError(`--explain 还没覆盖 '${cmd}'：${why}`);
    }
    stdout(renderPlan(plan));
    return 0;
  }
  /* `-v` 也走那张表（分片 2 后半）：先接过来，再由实现一格一格标完成。造不出表的命令
   * （还没覆盖的那些）`LIVE` 就是 `null`，那些路上照旧走老的 `vStep`。
   *
   * 嵌套那一趟不另起一张表：内层（链一次）是**外层的一个步骤**，起表会把外层的 `LIVE`
   * 与 `vMark` 顶掉，还会多印一行 `pipeline …`（量到过）。 */
  if (VERBOSE && !nested) vBegin(planForC(cmd, path, files, rest) ?? planForOmni(cmd, path, files, rest));

  /* `check`（决策一）：只走**前端与检查器**，不出产物、不执行。
   *
   * 它不是「少一步的 build」——它是**唯一**一条「我只想知道这份源码有没有错」的路。
   * 从前这儿是一句「还没到，用 omni emit oir」，而那句话让人把一份十几 MB 的 JSON
   * 印到终端上去看有没有报错。
   *
   * 前端由扩展名选，与别处同一条规矩（`compileFront`）。`.c` 走 C 那一路的
   * 一遍过（`cMir` 里就带 `verifyMir`）—— C 没有 OIR 这一层。
   * 印一行摘要，**错误照旧由抛出来的 `OmniError` 负责**（退出码 1）。
   *
   * 位置要紧：这一段在 `--explain` **之后** —— 不然 `check --explain` 会真去编一遍，
   * 而 `--explain` 的承诺是「一个字节都不写盘、不执行」。（第一版就摆错了，量出来了。） */
  if (cmd === 'check') {
    if (path.endsWith('.c')) {
      const mod = cap('c.toMir')(path, incDirs(rest), defArgs(rest), [], sysIncDirs(rest), cTgt(rest));
      stdout(`ok  ${path}：${mod.funcs.length} 个函数（C 一遍过 + MIR 自检）\n`);
      return 0;
    }
    const { mod } = compile(path, rest);
    const nf = mod.funcs === undefined ? 0 : mod.funcs.length;
    stdout(`ok  ${path}：${nf} 个函数（前端 + 检查器，没出产物）\n`);
    return 0;
  }

  /* `.asy` 的 `-f FMT` / `-o NAME`：设宿主那两格（格式与落地文件），见 asyRunSetup。
   * 摆在 switch **之前**而不是 `case 'run'` 里：`--backend llvm/interp/c` 会把 `run` 换成
   * 另一条 case（`run-llvm`/`interp`/`run-c`），摆在里头那几条腿就看不见 `-f` 了。
   * 判据用 `node.key`（用户敲的那个动词），不是被改写过的 `cmd`。 */
  if (node.key === 'run' && path !== undefined && path.endsWith('.asy')) {
    asyRunSetup(path, rest);
  }

  /* 出 JS 产物就得全内建 —— 判据是**改写后的 cmd**，不是用户敲的那个动词。
     上面那一格按 `node.key` 判，于是 `emit js x.js`（新写法，cmd 在 FORMS 那儿才变成
     `emit-js`）漏了：量出来它出的 omni.mjs 只有 6.46 MB（fat 是 13.5 MB），一跑就报
     "这份 omni 里一门语言都没装" —— 而 `emit-js`（老写法）好的，同一件事两种拼法两种结果。
     `build --backend js` 同理（那条也在 --backend 那张表里改写成 build-js）。 */
  if (cmd === 'emit-js' || cmd === 'build-js') LANGS_FAT = true;

  switch (cmd) {
    case 'run': {
      /* `.frag`/`.glsl` 走另一条腿（ADR-0019 决策九）：**渲一帧、写一张 PNG**。
       * 前端由扩展名选，与别处同一条规矩 —— 变的只是「执行」在这一门语言里是什么意思：
       * 片元着色器没有 main 可跑，它的「跑一遍」就是把每个像素算出来。 */
      const rn = path === undefined || path === null ? null : runner(path);
      if (rn !== null) return rn.run(path, rest);
      /* `--direct`（第一百四十八片第二格）：一份 `.js` **原样交给 node**，不过我们这一轮。
       * 摆在这儿 —— compile 之前：这一格的全部意义就是「那一轮一个字节都别发生」。 */
      if (rest.includes('--direct')) return runJsDirect(path, files.slice(1));
      /* `.c`：**编 + 链 + 跑**，走自带的 C 前端 + 代码生成 + 链接器（见 `runCFile`）。
       * 从前这儿没有这一格，`.c` 一路掉到 omni 的前端上，报的是
       * `unexpected character: "#"` —— 前端由扩展名选那条规矩漏了 C 这一门。 */
      if (path.endsWith('.c')) return runCFile(path, rest);
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
      // `.omni-cache/run-exe` 里，源码与它引的库都没动就只剩 exec。
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
      const cr = compile(path, rest);
      const { mod } = cr;
      // 自己的解释器（ADR-0013）。阶段 1 还没覆盖全部 op，所以要显式要它
      if (rest.includes('--interp')) return runInterp(mod);
      // `run` 的意思是"解析完直接执行"，怎么执行是**这一代宿主的事**：node 上是生成 JS
      // 在本进程里 eval；原生构建里没有第三方 JS 引擎，那边同一件事走 C 路径 ——
      // 前端、检查、OIR 都是同一份，换的只是"谁来跑最后那一步"。所以先问一句能力，
      // 而不是让 js_eval 报错：用户要的是执行，不是一句"换个命令重试"。
      // 注意这不是"原生构建少了一种能力"：JS 源码在两边都能编能跑（tests/js-exec 那条轴
      // 在自举出来的编译器上也过），少的只是"直接吃一段 JS 文本当程序跑"的那个引擎。
      if (hasJsEngine()) {
        /* `--profile stub` 在这条腿上就是发射期插桩（与 C 那条腿同名同账）。 */
        const js = target('js').emit(mod, {
          profile: PROF !== null && PROF.mode === 'stub',
          trim: !NO_TRIM,
        });
        LAST_EMIT_BYTES = js.length;
        /* `--stat` 那张分层的账要「按源码长起来的那一段」：不带 prelude 再发一遍
         * （`chunk: true` 就是那个形态）。多发一趟只在 `--stat` 那一趟里发生。 */
        if (STAT !== null) LAST_EMIT_PROG = target('js').emit(mod, { chunk: true }).length;
        vStep(`backend js  ${js.length} bytes`);
        /* 这份程序里有 `(ccall …)` 的话，先把那格 `$cffi` 备好（ADR-0038）：
           **默认注入**（我们自己那台 C 前端造机器码，铺进本进程），
           `OMNI_FFI=cc` 走编到文件那条备选（更通用，要一个外部 cc）。 */
        if (cffiNeeded(mod)) ffiPrepare(mod);
        if (cacheable) jsCachePut(path, js, cap('asy.deps')());
        /**
         * `--profile sample`：**采样器只能在 node 启动时开**，所以这一档不能在本进程里
         * eval —— 落盘 + spawn 一个带 `--cpu-prof` 的 node（`profNodeArgs`）。
         *
         * 换来的是「我们发射出来那份 JS」也量得到，与 `--direct` 那条走同一格收尾
         * （用户那句话：node prof 对两条路都适用）。代价明写：多一个进程 + 一次落盘，
         * 而这一档本来就是「量一段性能」，那点开销在账里看得见（`-v` 里印得出来）。
         */
        if (PROF !== null && PROF.mode === 'sample') {
          const dir = workDirFor('run-js-prof', hash16(path));
          mkdirAll(dir);
          const outJs = join(dir, `${basename(path).replace(/\.[^.]*$/, '')}.js`);
          writeText(outJs, js);
          const pre = profNodeArgs();
          const st = spawn('node', [...pre, outJs], 'i')[0];
          vStep(`node --cpu-prof ${outJs}  exit=${st}（我们发的那份 JS，走子进程才开得了采样器）`);
          profNodeFinish();
          statReport(cr);
          return st;
        }
        // eval / Function(src) 要编译器在运行期在场（ADR-0020 P6）：跑在本进程里的这一条
        // 装得上那格钩子，编成独立产物的场合装不上 —— 那时那两个 op 当场报错
        installSrcEvalHook((m, o) => target('js').emit(m, o));
        evalJs(js);
        vStep('exec in-process (node host, new Function)');
        profJsFinish();
        /* `run --stat` 在这条腿上**有账可报**（第一百四十七片第五格）：时间 + 各层的账
         * —— js -> js 那一路的胀正是这张表要看的东西。 */
        statReport(cr);
        return 0;
      }
      // 这一代没有 JS 引擎，"直接执行"就是 C 路径（产物缓存见 runViaC）
      return runViaC(mod, rest, path, true);
    }
    case 'emit-js': {
      const { mod } = compile(path, rest);
      stdout(target('js').emit(mod, { trim: !NO_TRIM }));
      return 0;
    }
    case 'emit-c': {
      const { mod } = compile(path, rest);
      /* `--split`：按**模块**发射（P2）—— 一个源文件一个 `.c`，跟正常的 C 工程一样，
       * 外加一份共享段（`_shared.c`：声明 + 只能有一份的那些 + main）。
       * 现在还编不起来：共享段里的容器 / JS 那一族宏自带静态状态，得先变成"只有声明的头 +
       * 一个定义 TU"（P2a，见 ADR-0021）。所以这一步先把**分布**摆出来 —— 哪个模块多少行、
       * 多少字节、多少函数，这是"看得见"的那一半，也是并行与增量的分组依据。 */
      const si = rest.findIndex((a) => a === '--split' || a.startsWith('--split='));
      if (si >= 0) {
        const wi = rest.indexOf('--work');
        if (wi < 0) throw new OmniError('emit c --split 要 --work DIR：每个模块的 .c 得有个落点');
        const dir = rest[wi + 1];
        mkdirAll(dir);
        const u = cap('cgen.units')(mod);
        /* `_decl.h` 是共用的那一份（类型、容器 / JS 模板、字面量池、全部原型），每个模块
         * `#include` 它；`_shared.c` 只放"只能有一份"的那些（模块级变量的定义、闭包的 make、
         * 那两张表）与 main。状态已经不在模板里了（S1），所以模板复制一份是无害的。 */
        writeText(join(dir, '_decl.h'), `${u.shared}\n`);
        writeText(join(dir, '_shared.c'), `#include "_decl.h"\n${u.once}\n${u.tail}\n`);
        let tot = 0;
        for (const t of u.units) {
          writeText(join(dir, `${t.name}.c`), `#include "_decl.h"\n${t.text}`);
          tot += t.text.length;
        }
        const ord = [...u.units].sort((a, b) => b.bytes - a.bytes);
        stderr(`omni: ${u.units.length} 个模块 TU，合计 ${fmtBytes(tot)}`
          + `，共享段 ${fmtBytes(u.shared.length + u.once.length + u.tail.length)}\n`);
        for (const t of ord.slice(0, 12)) {
          stderr(`  ${t.name}  ${fmtBytes(t.bytes)}  ${t.funcs} funcs\n`);
        }
        return 0;
      }
      const r = cap('cgen.stats')(mod, { amalgamate: rest.includes('--amalgamate') });
      stdout(r.text);
      vStats(r.text, r.stats);
      return 0;
    }
    case 'build': {
      const tFe0 = nowMs();
      const cr = compile(path, rest);
      const { mod } = cr;
      FE_MS = nowMs() - tFe0;
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : basename(path).replace(/\.(omni|omnis|omnid|js)$/, '');
      // --work DIR：生成的 C 留在 DIR 里而不是临时目录（自举链要能事后翻中间产物）
      const wi = rest.indexOf('--work');
      /* `--plugin NAME`：出一格动态库而不是可执行文件，NAME 是它的 register 函数。 */
      const pi = rest.indexOf('--plugin');
      /* `--own A,B`：这一份只发这些文件里的函数与全局，别的当 extern（分语言独立构建）。 */
      const owi = rest.indexOf('--own');
      const own = owi >= 0 && rest[owi + 1] !== undefined ? rest[owi + 1].split(',') : undefined;
      /* `--bind <核心的 .syms>`：插件按**核心实际留下的符号表**决定发哪些函数体 ——
         比 `--own` 那套按文件名猜准，因为核心是剪过枝的（见 emit.js 那格 bind 的注释）。 */
      const bi = rest.indexOf('--bind');
      const bind = bi >= 0 && rest[bi + 1] !== undefined
        ? new Set(readText(rest[bi + 1]).split('\n').filter((s) => s !== '')) : undefined;
      const { cc } = buildNative(mod, out, wi >= 0 ? rest[wi + 1] : undefined,
        pi >= 0 ? rest[pi + 1] : undefined,
        rest.includes('--extern') || own !== undefined || bind !== undefined, own, bind);
      /* 优化档要印出来：`-O0` 与 `-O1` 在这条腿上是 12 秒对 137 秒的差别（ADR-0021），
         而它从前只藏在 OMNI_OPT 里 —— 看不见的档等于每次都要猜这一趟慢是不是因为它。
         生成的 C 有多大/多少行、发射与 cc 各花多久也一并报（流水账里那一行，见 tally）：
         `npm run build:native` 的核心那一步只有这一句能看见，不开 `-v` 也该看得见。 */
      const row = TALLY[TALLY.length - 1];
      stderr(`omni: built ${out} ${fmtBytes(row.bin)}  C ${fmtBytes(row.cBytes)} / ${row.cLines} 行`
        + `  前端 ${fmtDur(row.feMs)} + 发射 ${fmtDur(row.genMs)} + cc ${fmtDur(row.ccMs)}`
        + `  via ${cc} ${cc.endsWith('tcc') ? '（tcc：不分档）' : optFlag()}\n`);
      /* `--plugins`：核心编完**接着**把默认那一套插件编齐（`npm run build:native` 就这一句）。
         一条进程做齐两件事不只是少打一行命令 —— 流水账要的是"核心 + 插件一共多少 C"，
         跨进程那个数只能拼，拼出来的数迟早对不上。 */
      if (rest.includes('--plugins')) buildPluginSet(out, join(dirname(out), 'plugins'), null, rest);
      statReport(cr);
      vTally();
      return 0;
    }
    case 'build-js': {
      /**
       * `omni build x.omni --backend js` —— 出一份**能直接 `node` 跑**的 JS。
       *
       * JS 从来不是「不支持」：`omni emit js` 早就有（`emitJs`），自举那条门
       * （`tests/js-roundtrip`）就是靠它把整个编译器重新生成一遍的。缺的只是
       * 「落盘成一个产物」这一格 —— 而 `build` 的契约正是出产物。
       *
       * 与 `build`（native）同一个规矩：`-o` 没给就用源文件名，只是后缀换成 `.js`。
       */
      const { mod } = compile(path, rest);
      const oi = rest.indexOf('-o');
      const stem = basename(path).replace(/\.(omni|omnis|omnid|js|sx|asy)$/, '');
      const out = oi >= 0 ? rest[oi + 1] : `${stem}.js`;
      const js = target('js').emit(mod, { trim: !NO_TRIM });
      writeText(out, js);
      stderr(`omni: built ${out} (${js.length} 字节，node ${basename(out)} 就能跑)\n`);
      return 0;
    }
    case 'build-interp': {
      /**
       * `omni build FILE --backend interp` —— 出**解释器吃的那份 IR**。
       *
       * 与 native 出可执行文件、js 出 `.js` 是同一条契约：**`--backend B` 的产物就是
       * B 吃的那份东西**。这条腿（omni/sx/asy/js -> OIR）的解释器吃 **OIR**，所以产物是
       * OIR；`.c` 那条吃 MIR，产物就是 MIR（在上面那个分派里）。
       *
       * 还差一格 —— **喂回去**：`emit oir` 的 JSON 是有损的（`replacer` 丢 span/ast，
       * i64 变 `"2n"`），所以现在这份文件是「读得懂、还喂不回去」。那一格与
       * 「哪一个 IR 是可回读的那一个」是同一个决定，记在 ADR-0018；产物行里明说，
       * 不假装。
       */
      const { mod } = compile(path, rest);
      const oi = rest.indexOf('-o');
      const stem = basename(path).replace(/\.(omni|omnis|omnid|js|sx|asy)$/, '');
      const out = oi >= 0 ? rest[oi + 1] : `${stem}.oir.json`;
      const text = `${JSON.stringify(mod, replacer, 2)}\n`;
      writeText(out, text);
      stderr(`omni: built ${out} (${text.length} 字节，OIR —— 解释器吃的就是这一层；`
        + '喂回去跑还差「可回读的 IR」那一格，见 ADR-0018)\n');
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
      stdout(target('llvm').emit(mir));
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
      stdout(target('spirv').emit(mir, { kernel: ki >= 0 ? rest[ki + 1] : undefined }));
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
      stderr(`omni: built ${out} via llvm ir + ${cc} ${optFlag()}\n`);
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
      stdout(path.endsWith('.jnc') ? cap('jnc.toSx')(path, incDirs(rest), false) : cap('asy.toSx')(path));
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
      /* `--arch` / `--os`：拿哪个目标的预定义（第一百二十九片）。与 `c-obj` 同名同值，
       * 默认**这台机器**（第一百四十七片：从前写死 arm64+osx，在 x86_64 Linux 上
       * 等于默认交叉编译到 macOS）。 */
      const cai = rest.indexOf('--arch');
      const csi = rest.indexOf('--os');
      const tgt = { arch: cai >= 0 ? rest[cai + 1] : hostArch(), os: csi >= 0 ? rest[csi + 1] : hostOs() };
      const out = cap('c.preprocess')(path, incDirs(rest), defArgs(rest), dflag, pflag, deps,
        sysIncDirs(rest), inclArgs(rest), verbose, tgt, rest.includes('--skip-missing-includes'));
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
      stdout(printMir(cap('c.toMir')(path, incDirs(flags), defArgs(flags), prog, sysIncDirs(flags), cTgt(flags))));
      return 0;
    }
    case 'c-emit-js': {
      const { flags, prog } = cSplitArgs(rest);
      stdout(emitMirJs(cap('c.toMir')(path, incDirs(flags), defArgs(flags), prog, sysIncDirs(flags), cTgt(flags))));
      return 0;
    }
    /**
     * `emit llvm x.c`：C -> **原生** MIR -> LLVM IR（ADR-0022 的 J4）。
     *
     * 走 `c.toMirNative`（与 `c obj` 同一条）而不是 `c.toMir`：后者出来的 MIR 带线性内存、
     * 指针是内存里的偏移 —— 拿它去调真的 libc 是错的（量出来就是 `declare i32
     * @printf(i64, i64)`，那两个"地址"其实是偏移）。这条腿是真机器，地址就得是真地址。
     */
    case 'c-emit-llvm': {
      const { flags } = cSplitArgs(rest);
      const { mod, warnings } = cap('c.toMirNative')(path, {
        includeDirs: incDirs(flags),
        sysIncludeDirs: sysIncDirs(flags) ?? cap('c.sysInclude')(),
        arch: hostArch(),
        os: undefined,
      }, defArgs(flags));
      for (const w of warnings) stderr(`${w}\n`);
      const errs = verifyMir(mod);
      if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
      stdout(target('llvm').emit(mod));
      return 0;
    }
    case 'c-run': {
      const { flags, prog } = cSplitArgs(rest);
      const mod = cap('c.toMir')(path, incDirs(flags), defArgs(flags), prog, sysIncDirs(flags), cTgt(flags));
      return runMirModule({ structs: [], enums: [], classes: [], js: false }, mod);
    }
    /**
     * `c-run-js`：C -> MIR -> **JS 源码** -> 本进程里 `new Function`（ADR-0013）。
     *
     * 与 `c-run` 的区别只有最后一步：那一条把 MIR 编成一串闭包再跑一个 pc 循环，
     * 这一条把 MIR 编成 JS 源码交给 V8。量出来的差距是 6～8 倍，而它不来自 dispatch
     * （特化 dispatch 量过是 0 收益），来自「值不再装箱进 `F.v[]`、槽是真的 `let`」。
     *
     * 退出码的口径与 `runMirModule` 同一套（`$run()` 里收摊），所以两条腿在
     * 「stdout 逐字节 + 退出码」这两项上可比 —— `tests/mir/js-parity` 比的就是这两项。
     */
    case 'c-run-js': {
      const { flags, prog } = cSplitArgs(rest);
      const mir = cap('c.toMir')(path, incDirs(flags), defArgs(flags), prog, sysIncDirs(flags), cTgt(flags));
      const js = emitMirJs(mir);
      vStep(`backend js (from mir)  ${js.length} bytes`);
      return runMirJs(js);
    }
    /* `c-obj`：C -> 真机器码 -> 一个 `.o`（第九刀第二十六片）。
     * 链接留给外面（`clang a.o -o a`）—— 可执行文件的写出还没到。 */
    case 'c-obj': {
      const { flags } = cSplitArgs(rest);
      const oi = flags.indexOf('-o');
      const out = oi >= 0 ? flags[oi + 1] : `${basename(path, '.c')}.o`;
      const ai = flags.indexOf('--arch');
      const arch = ai >= 0 ? flags[ai + 1] : hostArch();
      /* `--format elf` 写 tcc 那种 `.o`（`ET_REL`），`--os linux` 去掉符号名前那条
       * 下划线。三格默认值都跟着**这台机器**走（第一百四十七片）：写死 macho + osx
       * 在 x86_64 Linux 上就是默认交叉编译到 macOS，而本机的 clang / ld 一个都不认。 */
      const si = flags.indexOf('--os');
      const os = si >= 0 ? flags[si + 1] : hostOs();
      const fi = flags.indexOf('--format');
      const fmt = fi >= 0 ? flags[fi + 1] : fmtOfOs(os);
      stdout(`${cObj(path, out, arch, incDirs(flags), defArgs(flags), fmt, os, sysIncDirs(flags))}\n`);
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
     * `--soname` / `--rpath` 是 `.dynamic` 里那两条（第六十二片），`--ar` 接一份静态库
     * （按需取用；glibc 的 `atexit` 只住在 `libc_nonshared.a` 里）。没有 libc，入口自己指：
     *   omni elf-link a.o [b.o …] -o a.out [-e main] [--static] [--shared]
     *                  [--dll libfoo.so] [--ar libfoo.a] [--pie] [--rdynamic]
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
      const archives = [];
      for (let k = 0; k < rest.length - 1; k++) {
        if (rest[k] === '--dll') dlls.push({ bytes: bytesOf(rest[k + 1]), name: rest[k + 1] });
        else if (rest[k] === '--ar') archives.push(bytesOf(rest[k + 1]));
      }
      /* ---- `-l` 找库（照 `tcc_add_library`，`libtcc.c:1299`）。
       *
       * 拼法在 ELF 上只有两条：`lib%s.so`、`lib%s.a`（`--static` 时只剩后一条）；
       * `:name` 是「就照这个名字找」。路径是 `-L` 给的那些在前，然后
       * `CONFIG_TCC_LIBPATHS`（非 PE 上是 `<sysroot>/usr/lib`，配了 triplet 的还多一层）。
       *
       * 找到的东西**认头**分派，不认扩展名（tcc 也是看头几个字节）：
       *   `\x7fELF` -> 共享库、`!<arch>` -> 静态库、都不是就当 ld 脚本读
       *   （glibc 的 `/usr/lib/libc.so` 正是一份 `GROUP ( libc.so.6 libc_nonshared.a … )`
       *   的文本 —— 这一格从前是把三个库名写死在 `cDefaultLibs` 里猜的）。 */
      const libPaths = [];
      for (let k = 0; k < rest.length; k++) {
        if (rest[k] === '-L' && k + 1 < rest.length) libPaths.push(rest[k + 1]);
        else if (rest[k].startsWith('-L') && rest[k].length > 2) libPaths.push(rest[k].slice(2));
      }
      for (const d of ['/usr/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu',
        '/lib/x86_64-linux-gnu', '/lib/aarch64-linux-gnu', '/lib64', '/lib']) libPaths.push(d);
      const findLibElf = (name) => {
        const fmts = name.startsWith(':') ? ['%s/%s']
          : (rest.includes('--static') ? ['%s/lib%s.a'] : ['%s/lib%s.so', '%s/lib%s.def', '%s/lib%s.a']);
        const nm = name.startsWith(':') ? name.slice(1) : name;
        for (const f of fmts) {
          for (const d of libPaths) {
            const p = f.replace('%s', d).replace('%s', nm);
            if (exists(p)) return p;
          }
        }
        return null;
      };
      /** 一份找到的文件收进来。`depth` 挡住脚本互相指的死圈（tcc 靠的是文件描述符栈）。 */
      const takeLib = (p, depth) => {
        const b = bytesOf(p);
        if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) {
          dlls.push({ bytes: b, name: p });
          return;
        }
        if (b.length >= 8 && String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]) === '!<arch>\n') {
          archives.push(b);
          return;
        }
        const names = depth > 4 ? null : parseLdScript(readText(p));
        if (names === null) {
          /* 不是 ld 脚本 —— 看看是不是 `.def`（符号预设，交叉编译那一路）。 */
          const txt = readText(p);
          if (isDefSyms(txt)) {
            dlls.push({ bytes: bytesOf(p), name: p });
            return;
          }
          throw new OmniError(`elf: '${p}' 既不是 ELF、不是 .a，也不是认得的 ld 脚本或 .def`);
        }
        for (const n of names) {
          const q = n.startsWith('-l') ? findLibElf(n.slice(2)) : (exists(n) ? n : findLibElf(`:${basename(n)}`));
          /* 脚本里点到的东西不在这台机器上就跳过 —— `AS_NEEDED` 那一串本来就是「有就用」。 */
          if (q !== null) takeLib(q, depth + 1);
        }
      };
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        let nm = null;
        if (a === '-l' && k + 1 < rest.length) nm = rest[k + 1];
        else if (a.startsWith('-l') && a.length > 2) nm = a.slice(2);
        if (nm === null) continue;
        const p = findLibElf(nm);
        if (p === null) throw new OmniError(`elf: 找不到库 '-l${nm}'`);
        takeLib(p, 0);
      }
      /* 位置参数里的 `.a` 也算静态库 —— 链接器的命令行上库与目标文件是混着写的。 */
      const objs = [];
      for (const p of files) {
        if (p.endsWith('.a')) archives.push(bytesOf(p));
        else objs.push(bytesOf(p));
      }
      const r = elfExe({
        objs,
        entryName,
        static: rest.includes('--static'),
        shared: rest.includes('--shared'),
        pie: rest.includes('--pie'),
        rdynamic: rest.includes('--rdynamic'),
        soname: valOf('--soname'),
        rpath: valOf('--rpath'),
        newDtags: rest.includes('--enable-new-dtags'),
        dlls,
        archives,
      });
      writeBinary(out, r.bytes);
      writeLinkMap(valOf('--map'), r.syms);
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
      const sdkLib = cap('c.usrLib')();
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
        /* `-framework Foo`：macOS 的 framework。SDK 里有 `.tbd` stub，走 `takeLib` 装进去
         * 就能给 macho_exe 那边提供符号名与安装名。JIT 那一侧 `dlopen` 走的是另一条路
         * （`frameworkPath`，见 cli.js 的那一段）；这儿是 AOT 链接。 */
        if (a === '-framework' && k + 1 < rest.length) {
          k++;
          const fw = rest[k];
          const sdkBase = sdkLib !== null ? sdkLib.replace(/\/usr\/lib$/, '') : null;
          const tryPaths = sdkBase === null ? []
            : [`${sdkBase}/System/Library/Frameworks/${fw}.framework/${fw}.tbd`,
              `${sdkBase}/System/Library/Frameworks/${fw}.framework/Versions/A/${fw}.tbd`];
          let found = false;
          for (const p of tryPaths) {
            if (exists(p)) { takeLib(p); found = true; break; }
          }
          if (!found) {
            throw new OmniError(`framework '${fw}' not found（SDK 里没有 .tbd；`
              + `试了 ${tryPaths.join(' 与 ')}）`);
          }
          continue;
        }
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
      /* `--stack-size N`：主线程的栈（`LC_MAIN.stacksize`，`ld` 的 `-stack_size`）。
       * 十六进制也认 —— 那一路的值一向写成 `0x20000000`。 */
      const ssi = rest.indexOf('--stack-size');
      const r = machoExe({
        objs: files.map(bytesOf),
        entryName,
        dylibs,
        /* `-g`：stabs 那一路（`--dwarf` 没给）或者 dwarf 那一路。 */
        debug: rest.includes('-g'),
        dwarf: dwi >= 0 ? Number(rest[dwi + 1]) : 0,
        stackSize: ssi >= 0 ? Number(rest[ssi + 1]) : 0,
        rpath: rp.length === 0 ? undefined : rp.join(':'),
        openDylib: (n) => (exists(n) ? bytesOf(n) : null),
        archives,
        shared: rest.includes('--shared'),
        outName: out,
        installName: ni >= 0 ? rest[ni + 1] : undefined,
      });
      writeBinary(out, r.bytes);
      if (!rest.includes('-q')) {
        stdout(`${out} (${r.bytes.length} 字节，${r.ncmds} 条加载命令，${r.nsects} 节，`
          + `入口偏移 0x${r.entryoff.toString(16)}`
          + `${r.members.length === 0 ? '' : `，拉了 ${r.members.length} 个库成员`})\n`);
      }
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
      const res = compileIncremental(mir, 'js', cache, (name) => cap('jsgen.func')(mod, byName.get(name)));
      vStep(`incr  ${res.units.length} units, ${res.hits} hit, ${res.misses} miss  cache ${dir}`);
      stdout(incrReport(res, rest.includes('--list')));
      return 0;
    }
    // ---- GLR（ADR-0014 决策 2）。语法是数据，这两条命令读的都是 .grammar 文件。
    // 它们摆在 CLI 上不只是为了调试：自举链要能让**原生编译器自己**跑一遍这条路，
    // 那是唯一能抓住封闭 ABI 违规的门槛（详见 tests/bootstrap/run.js 阶段 8）。
    // asy 前端的中间形态：印出核心方言，`omni run x.asy` 吃的就是它（ADR-0014 第 2 道门槛）
    case 'emit-asy': {
      stdout(cap('asy.toSx')(path));
      return 0;
    }
    case 'glr-table': {
      stdout(cap('glr.table')(path, rest.includes('--brief')));
      return 0;
    }
    case 'glr': {
      stdout(cap('glr.run')(path, files.slice(1), rest.includes('--count')));
      return 0;
    }
    // `.y`（bison/yacc）转成我们那份 `(grammar …)` 文本。`glr table` / `glr parse` 自己也
    // 认 `.y`（glr/load.js 那一格转），这条只是把中间那份文本摊出来给人看。
    case 'glr-y': {
      stdout(cap('glr.y')(path));
      return 0;
    }
    // `.ebnf`（W3C / bottlecaps 风）同上一条 —— 标准里那份语法本身就是这个形状。
    case 'glr-ebnf': {
      stdout(cap('glr.ebnf')(path));
      return 0;
    }
    default:
      throw new OmniError(`unknown command '${cmd}'\n${renderHelp(ROOT, [])}`);
  }
}

/** span 里有 SourceFile 循环引用，BigInt 也不能直接序列化 */
function replacer(key, value) {

  if (key === 'span' || key === 'nameSpan' || key === 'ast' || key === 'defAst') return undefined;
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

try {
  /* 超时那一格摆在这儿（而不是 `run` 那二十来个 return 上）：这是所有腿唯一的汇合点，
   * 于是「按了 --timeout 却没人报告」不可能漏掉一条。见 armRunTimeout。 */
  const st = main(procArgs());
  /* `--profile-out x.svg` 的第二步（第一百四十七片）：把运行时落下的折叠栈摊成火焰图。
   * **同一个理由摆在这儿** —— run / build / plugins 三条腿都从这儿出去，写在这儿一处
   * 就不会有「哪条腿忘了渲染」。渲染是纯字符串计算（`cli/flame.js`）。 */
  profFoldedFinish();
  profSvgFinish();
  setExitCode(runTimedOut() ? 124 : st);
} catch (e) {
  if (e instanceof OmniError) {
    stderr(e.message + '\n');
    setExitCode(1);
  } else throw e;
}
