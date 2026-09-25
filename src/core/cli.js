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
  args as procArgs, env, setEnv, stdout, stderr, setExitCode, evalJs, hasJsEngine, nowMs,
  /* `spawn` 换个名字进来：这一层要给它**包一格计时**（见 spawn 那个包装）。二十来个调用点
     一个都不用动 —— 包装叫回原来的名字。 */
  spawn as hostSpawn,
  maxRssBytes, upMs,
  cwd, installDir, isDir, writeBinary, readBinary, runTimeout, pluginLoad, pluginsOk,
} from './host/native.js';
import { join, basename, dirname, isAbsolute, resolve } from './host/path.js';
/* `omni c split`（ADR-0046）那一格。静态进来而不是 `await import(…)`：分发那个函数不是
   async 的，动态 import 在它里头是语法错（`SyntaxError: Unexpected reserved word`，踩过）。 */
import {
  scanTopLevel as cSplitScan, formatScan as cSplitFormat, readPlan as cSplitReadPlan,
  applyPlan as cSplitApply, checkRejoin as cSplitCheck, contiguity as cSplitContig,
  stitchFile as cSplitStitch, ppBalance as cSplitPpBalance,
} from './frontend-c/split.js';
import { installSrcEvalHook } from './host/src_eval.js';
import { cacheRoot, scratchDir, dropScratch, cacheList, cacheGc, cacheKept } from './host/cache.js';
import { dataPath, dataDir } from './host/data.js';
import { hash16 } from './host/hash.js';
import { findCmd, splitArgv, canonicalize, ownsVerbose, renderHelp, renderLegacy } from './cli/tree.js';
import { ROOT, LEGACY } from './cli/cmds.js';
import { renderPlan, renderSummary, renderStage } from './cli/stages.js';
import { planForC } from './cli/plan-c.js';
import { planForOmni } from './cli/plan-omni.js';
import { tccTranslate } from './cli/cmd-tcc.js';
import { isMsvc, msvcFind, msvcEnv, msvcArgs, vsRoots } from './cli/msvc.js';
import { isClang, isClangCl, clangWant, clangFind, clangArgs, clangTargetArgs } from './cli/clang.js';
import {
  foldedToSvg, cpuProfileToFolded, heapProfileToFolded, foldedTable, foldedSummary, foldedPaths,
  foldedTree, foldedEdges, foldedDiff,
} from './cli/flame.js';
import { statModel, statTable, statDot, statJson } from './cli/statgraph.js';
import { layerModel, layerTable, countNodes, stepTable, kindStat, kindTable } from './cli/layers.js';
import { linkJs } from './frontend-js/link.js';
import { lowerJs } from './frontend-js/lower.js';
import { lowerWat } from './frontend-wat/lower.js';
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
/* **借来的那十一门语言**（ADR-0044）：一门一份 adapter，CST → 标准 IR → 公共降级器 → `.sx`。
 * 静态 import 是有代价的（十一份 adapter 一起进核心），可它们都是纯 JS、小、没有别的依赖；
 * 哪天核心大小要紧了，正解是把它登记成 lang / plugin，不是在这儿加一句 `await import`
 * （这份文件里那几十个 import 全是静态的，只有一套规矩）。 */
import { coreSxText, borrowedExts } from './lower/drive.js';
/* 构建引擎（`omni ninja`）：依赖图 + 脏判定 + 调度，不认识语言 —— 设计见
 * `docs/design/build-system.md`，模型照 ninja 复刻。 */
import { ninjaCmd } from './build/cli.js';
/* 模块产物缓存那套通用机器（一份索引 + 内容身份 + 一格键）：有 import 关系的语言共用它，
 * 不再每门语言手写一份脏判定 —— 见 `docs/design/build-system.md` §10。 */
import {
  UnitIndex, moduleDir, declRead, declPath, declWrite, launcherText, loadableText, declSpans,
  moduleOrderOf,
} from './build/modules.js';
import { cacheSlot, slotDone, slotRelay } from './build/modcache.js';
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
  /* 没写 `--sysroot`，可这一趟是**交叉**（`--arch`/`--os` 指到了别的目标，或者
   * `--libc self`）—— 那时 `CROSS` 里有自带的那一份 sysroot，系统头也得换成它。
   * 读本机的头是错的，量到的两句：
   *   mac 上 `build x.c --arch arm64 --os win32` 撞 macOS SDK 的
   *     `sys/cdefs.h:1068: error: #error Unsupported architecture`
   *   Windows 上更直接：`probe.c:4: error: include file 'stdio.h' not found`
   *     （那儿压根没有 `/usr/include` 这一套）
   * 生成的那份 C 早就走对了（`buildSelf` 自己按 `CROSS` 算 `sysIncs`）—— 漏的一直是
   * **用户自己那份 `.c`**。`omni c obj|link` 不受影响：那一层 `CROSS` 是 null
   * （见 `main` 里 `infer` 那一格），照旧用本机 SDK 的头当尺子。 */
  if (CROSS !== null) {
    out.push(cap('c.sysInclude')()[0]);        // C_INCLUDE_DIR（src/include，编译器自己那几个头）
    out.push(join(CROSS.sysroot, 'include'));
    return out;
  }
  /* **本机就是 Windows**：那儿没有 `/usr/include`，`cSysInclude()` 一份系统头也探不到，
   * 量到的是 `src/runtime/omni.h:33: error: include file 'stdio.h' not found` ——
   * 看着像运行时头坏了，其实是**系统头一格都没给**。
   *
   * 自带的 win32 sysroot 就是这台机器该用的那一份：Windows 上没有稳定的裸 syscall，
   * 平台层调的是 kernel32 的导入函数，所以「交叉到 win32」与「本机是 win32」是同一份头
   * （`bundledSysroot` 里 `<os>` 那条退路正是为此）。
   *
   * 为什么不用 MSVC 的 `INCLUDE`：那套头里 `__declspec` / SAL / `#pragma` 一堆 MS 扩展，
   * 我们自己那台 C 前端吃不下。MSVC 的头只在「把生成的 C 交给 `cl` 自己」（`--cc msvc`）
   * 那一路上用 —— 那时是 `cl` 在读，不是我们在读。 */
  if (hostOs() === 'win32') {
    out.push(cap('c.sysInclude')()[0]);
    out.push(join(bundledSysroot({ arch: hostArch(), os: 'win32' }), 'include'));
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
    ? genX64(mod, { unwind: fmt === 'elf' && os === 'win32', win64: os === 'win32' })
    : genArm64(mod, { win32: os === 'win32' });
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
/* 这一趟 C 那侧按模块编译吗（`perModuleWanted` 在 switch 之前填它）。
 * 两个用处：走哪条出口（buildNative）、要不要摇树（PRUNE_OFF）。 */
let PER_MODULE_C = false;
let PRUNE_OFF = false;
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
/* `-v` 的**总账**要的三格（第一百五十六片，用户提的："没有显示子时间相加和总时间，
   方便和外部 time 时间对比"）：
     V_N / V_SUM   印过几行、它们的和 —— "步骤加起来"就是这一格
     V_SPAWN_*     子进程几次、共多久（`c obj` 走的是本进程，`exec` 与 `chmod` 是子进程）
   启动那一截不在这里：它是 `upMs()` 减掉第一行之前攒的那些（见 vBoot）。 */
let V_N = 0;
let V_SUM = 0;
let V_SPAWN_N = 0;
let V_SPAWN_MS = 0;
let V_BOOT = -1;

/**
 * `spawn` 外面包一格计时（宿主那格叫 `hostSpawn`）。
 *
 * 为什么包在这一层而不是宿主里：宿主是**封闭 ABI**（二十来个调用点、三条腿各一份实现），
 * 而"这一趟起了几个子进程、花了多久"是**驱动**的账 —— 外面 `time` 看到的 `real` 里有这
 * 一块，不单独列出来就只能猜。
 */
function spawn(cmd, argv, mode) {
  const t0 = nowMs();
  const r = hostSpawn(cmd, argv, mode);
  V_SPAWN_N++;
  V_SPAWN_MS = V_SPAWN_MS + Math.trunc(nowMs() - t0);
  return r;
}

/**
 * `-v` 的**明细行**：挂在上一格步骤下面，不带耗时、也不进 `--stat` 那张表。
 *
 * 为什么要它：`4 份模块（这一趟编了 1 格）` 说了"几格"却没说"哪一格" —— 而 `-v` 存在的
 * 理由正是"哪一格"。步骤行保持一行一格好对齐，具体是谁往下缩一层。
 */
/**
 * **链接器那条结果行**（`pe-link` / `elf-link` / `macho-link` 各一条）。
 *
 * 独立敲 `omni c link …` 时它是这条命令的结果，照旧走 stdout；而 `run-c`/`build` 内部
 * 会 subMain 调一次链接器 —— 那时它落进**被比较的程序输出**里，量到的是 tests/run.js 的
 * `js==c` 差在第 1 行（c 腿头一行是这条横幅）。嵌套时改走 stderr，与 `omni:` 那些步骤行
 * 同一个去处。
 */
function linkSay(msg) {
  /* 嵌套（`run-c` / `build` 内部）时**不印**：tests/run.js 的判据是 stdout、stderr、退出码
   * 三个流全等，所以这一行无论落在哪个流上都会让 `js==c` 失败。要看它就 `-v`（那时它与
   * `omni:` 那些步骤行一起出现）。独立敲 `omni c link …` 照旧走 stdout —— 那是那条命令的结果行。 */
  if (MAIN_NEST > 0) {
    if (VERBOSE) stderr(msg);
    return;
  }
  stdout(msg);
}

function vSay(msg) {
  if (VERBOSE) stderr(`omni:   ${msg}\n`);
}

/** 第一行之前那一截（宿主启动 + 把整棵编译器装进来）。只印一次。 */
function vBoot() {
  if (V_BOOT >= 0) return;
  V_BOOT = Math.trunc(upMs());
  if (!VERBOSE) return;
  stderr(`omni: 启动         宿主 + 装编译器  [${V_BOOT}ms]\n`);
}

/**
 * 一趟的总账（`-v` 最后一行）。回答的是"**外面 `time` 看到的那个数是怎么来的**"：
 *
 *   进程内 = 启动 + 步骤之和 + 其余（印表、收尾、没被 vStep 圈进去的零碎）
 *
 * `进程内` 直接取 `upMs()`，所以它与 `time` 的 `real` 只差进程退出那一下 —— 从前这张账
 * 一格都没有，于是"步骤加起来 740ms 而 real 是 1.01s"那 270ms 谁也说不清。
 */
function vTotal() {
  if (!VERBOSE || V_N === 0) return;
  const all = Math.trunc(upMs());
  const boot = V_BOOT < 0 ? 0 : V_BOOT;
  const rest = all - boot - V_SUM;
  stderr(`omni: 合计         进程内 ${all}ms = 启动 ${boot}ms + 步骤 ${V_SUM}ms（${V_N} 格）`
    + ` + 其余 ${rest}ms；其中子进程 ${V_SPAWN_N} 次 ${V_SPAWN_MS}ms\n`);
}

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
    );
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
     * **先分清"没采到"与"根本没跑过"**（任务 #91 抱怨的那一格）。
     *
     * `build` 这个动词只编译，谁都没跑 —— 这一层于是看到一份空的折叠栈，而底下那几句
     * 会把它说成"这一趟太短 / 每一格都不到 1µs"，**把人引到"加大工作量"那条死路上**
     * （照它把 pt 的 SPP 从 12 提到 300，白跑一轮）。真相是那份产物一次都没跑。
     * 量出来的证据：同一份 `--profile stub` 的二进制手动跑一趟
     * （`OMNI_PROF_OUT=… ./w-stub`）就写出 `omni_main;s_work 13356`（µs）。
     */
    if (PROF.key === 'build') {
      const bin = PROF.bin === undefined || PROF.bin === null ? '<产物>' : PROF.bin;
      const pre = PROF.mode === 'sample' ? 'OMNI_PROF=sample:997 ' : '';
      const why = PROF.mode === 'sample'
        ? '采样器是**运行期**按环境变量开的，二进制里一个字节都没改'
        : '桩已经在这份二进制里了，只差给它一个落点';
      stderr(`omni: profile（${PROF.mode} · ${LEG_SAY[PROF.leg] ?? PROF.leg} 腿）`
        + '：`build` 只编译，这一趟没有谁在跑 —— 这几张表要程序真跑起来才有。\n'
        + `  ${pre}OMNI_PROF_OUT=/tmp/omni.folded ${bin}\n`
        + `（${why}；折叠栈拿到手之后火焰图走 \`--profile-out x.svg\` 那一条）\n`);
      return;
    }
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
  V_N++;
  V_SUM = V_SUM + d;
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
    V_N++;
    V_SUM = V_SUM + d;
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
  /* 按模块编译那一路**不摇**（见 PRUNE_OFF）：摇过的库模块，它的 `.c` 会随"这个程序用到
     哪几个函数"变，于是同一份源文件在两个程序里出来的产物不同 —— 那就不是分离编译了。
     死代码交给链接器按节回收（`--gc-sections` 还没有，那是另一刀）。 */
  if (env('OMNI_PRUNE') !== '0' && !PRUNE_OFF && r !== undefined && r.mod !== undefined) {
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
  /**
   * **方言是那条规矩的一个例外，而且不用开关**（ADR-0037 的 D3 加的一格）。
   *
   * `#lang gsl-shell` 写在一份 `.lua` 里并没有"偷偷换成另一门语言" —— gsl-shell 就是
   * Lua 加两条产生式（`ext/gsl-shell/lang.js` 的 `extend(luaLang, …)`），它连自己的后缀
   * 都没有。默认关着 `#lang` 防的是"这份 `.c` 其实按别的语言编了"那一类惊吓，而
   * "同一门语言的哪一种写法"不在那一类里：文件第一行明写着，编出来的也还是那门语言。
   *
   * 判据是**方言自己报的家门**（`registerLang` 的 `dialectOf`），不是名字长得像。
   */
  const dialectOfExt = (name) => {
    if (name === null || byExt === null) return null;
    let l = null;
    try { l = langByName(name); } catch { return null; }
    return l !== null && l.dialectOf === byExt.name ? l : null;
  };
  const dir = exists(path) ? langDirectiveOf(readText(path)) : null;
  const dirDialect = dir === null ? null : dialectOfExt(dir.name);
  if (dirDialect !== null) return { l: dirDialect, why: `#lang ${dir.name}（${byExt.name} 的方言）` };
  /* 关着的时候也要**看一眼**：看到了就报，不是当注释混过去。 */
  if (!LANG_DIRECTIVE && dir !== null) {
    throw new OmniError(`${basename(path)}:${dir.line}: #lang 这一格默认关着 —— `
      + '一份文件的语言默认只由后缀决定（ADR-0009）。'
      + '开法：加 `--lang-directive`，或 `OMNI_LANG_DIRECTIVE=1`。'
      + `装着的读入器：${langsSay()}`);
  }
  const names = [];
  if (LANG_DIRECTIVE && dir !== null) names.push(['#lang 行', dir.name]);
  if (byFlag !== null) names.push(['--lang', byFlag]);
  if (byExt !== null) names.push(['后缀', byExt.name]);
  /* 冲突：两处以上说了话而且说的不是同一门。**报**，不择一。
     ——**除了方言**：`--lang gsl-shell` 配一份 `.lua` 是"说得更细"，不是两处打架。 */
  const flagDialect = dialectOfExt(byFlag);
  if (flagDialect !== null) return { l: flagDialect, why: `--lang ${byFlag}（${byExt.name} 的方言）` };
  const distinct = [];
  for (const [, n] of names) if (!distinct.includes(n)) distinct.push(n);
  if (distinct.length > 1) {
    throw new OmniError(`${basename(path)}: 这份文件该按哪门语言读，几处说的不是同一个 —— `
      + names.map(([w, n]) => `${w} 说 ${n}`).join('、')
      + '。按 #lang 走就删掉 --lang（或改文件名），按后缀走就删掉那一行');
  }
  if (LANG_DIRECTIVE && dir !== null) {
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
    /* `SRC_SX`：借来语言那条路译出来的核心方言在内存里 —— 前端的第三个入参就是"文本递进来"
     * 那一格（见 lang/sx.js）。没有那份文本时是 undefined，各门语言照旧按路径读。 */
    return l.compile(path, argv, SRC_SX);
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
  /* 借来语言那条路译出来的核心方言在内存里（见上面那段 `SRC_SX`）：**不经过磁盘**。 */
  return compileProgram(path, SRC_SX, modeFor(path, argv));
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
/**
 * **自带那份 libc 与它的头的指纹**（第 msvc 刀）。
 *
 * `srcStamp()` 只覆盖编译器自己那棵树（`src/core`），而运行时那 20 多份 `.o` 与 libc 的
 * `.o` 还依赖 `src/sysroot/**` 里的源码与头。少了这一格，改一行 `start.c` 之后所有 `.o`
 * 照旧命中缓存 —— 今天量到两次：`_fltused` 补了等于没补（链接期照旧 unresolved）、
 * 控制台代码页改了之后跑出来的还是老 exe（`prof[core]` 一片乱码）。
 *
 * 只看 `libc/` 与 `include/`（还有公用的 `src/sysroot/libc`）：那是这些 `.o` 真正吃的东西。
 */
function libcStamp() {
  const roots = [];
  if (CROSS !== null) {
    roots.push(join(CROSS.sysroot, 'libc'), join(CROSS.sysroot, 'include'),
      join(CROSS.sysroot, '..', 'libc'), join(CROSS.sysroot, 'cc-include'));
  }
  const parts = [];
  for (const d of roots) {
    if (!isDir(d)) continue;
    for (const f of readDir(d).sort()) {
      const p = join(d, f);
      if (isDir(p)) {
        for (const g of readDir(p).sort()) {
          const q = join(p, g);
          if (!isDir(q)) parts.push(`${f}/${g}:${mtimeMs(q)}:${fileSize(q)}`);
        }
        continue;
      }
      parts.push(`${f}:${mtimeMs(p)}:${fileSize(p)}`);
    }
  }
  return hash16(parts.join('|'));
}

function srcStamp() {
  if (srcStampMemo !== '') return srcStampMemo;
  const parts = [];
  const walk = (d) => {
    /* **读不动的目录跳过**，别把整趟拖死（第 win-c-backend 刀）：Windows 的用户目录下
     * 满是拒绝访问的交接点（`C:\Users\All Users\Application Data` 那一族），扫到一个
     * 就抛的话，一条"算个指纹"的辅助路会把整个 build 拽倒。 */
    let names;
    try {
      names = readDir(d).sort();
    } catch {
      return;
    }
    for (const f of names) {
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
function writeLinkMap(path, syms, head) {
  if (path === undefined || path === null || path === '' || !Array.isArray(syms)) return;
  const lines = syms.map((s) => `0x${s.addr.toString(16)} 0x${(s.size ?? 0).toString(16)} ${s.name}`);
  /* `head`（PE 那条腿在用）：`# imagebase 0x…`。读图的人要靠它算 ASLR 的滑动量 ——
   * Windows 的装载器会**把内存里那个 ImageBase 字段改成真实基址**，所以运行期从自己
   * 头上读不回链接期的那个数（量出来的：`declared == actual`，滑动量算成 0，
   * 于是采样报告里全是裸地址）。`#` 开头的行老读者一律跳过，加它不破旧图。 */
  const body = `${lines.join('\n')}\n`;
  writeText(path, head === undefined || head === null ? body : `${head}\n${body}`);
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

/**
 * 一份程序该叫什么：**源文件的主干**（`01-arith.asy` -> `01-arith`）。
 *
 * 从前这些地方一律叫 `a.out`：`work/run-01-arith.asy/a.out`、`run-ll/…/a.out`、
 * 暖存里 `<哈希>.out`。那个名字一个字都没说 —— 一棵 `work/` 底下十几个 `a.out`，
 * 谁是谁只能靠上一层目录猜，日志里印出来更是看不出在跑哪个程序。
 * （`c obj`/`c link` 那两条**照旧**默认 `a.out`：那是 cc 的约定，是给人用的接口，不是缓存名。）
 */
function progName(p) {
  const base = workName(p);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem === '' ? 'prog' : stem;
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
/* 借来语言（`.go`/`.nim`/…）译出来的核心方言：只在内存里传一手，`--emit-sx` 才落盘。 */
let SRC_SX = undefined;
/* 上面那一格是从**哪份源码**来的（`path` 随后被换成虚拟的 `.sx`，诊断要指着原来那份）。 */
let SRC_SX_FROM = undefined;

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
      const kept = cacheKept(e.name, false) ? '  ← 判据，gc 不碰' : '';
      stdout(`  ${e.name.padEnd(14)} ${mbOf(e.bytes).padStart(9)}  最后动过 ${age}${kept}\n`);
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
      oracle: argv.includes('--oracle'),
    };
    if (argv.includes('-n')) {
      /* 只说不做：把"会扔哪几格"算出来印出来（同一套规矩，只是不动手）。 */
      const now = Date.now();
      let would = 0;
      for (const e of cacheList()) {
        if (cacheKept(e.name, opts.oracle)) { stdout(`留着 ${e.name}（判据，加 --oracle 才扔）\n`); continue; }
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
    for (const e of cacheList()) {
      if (cacheKept(e.name, opts.oracle)) stderr(`omni cache: 留着 ${e.name}（判据，加 --oracle 才扔）\n`);
    }
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
function exeCacheStamp(cc, mode) {
  // 编译器与**它的 flags** 都在印记里：`OMNI_OPT=2` 与默认 -O0 是两个可执行文件。
  // **`OMNI_PROFILE` 也得在**：它改的是生成的 C（插桩），不是 flags；不进印记的话
  // 开过一次 profile 之后，后面不带开关的运行会命中缓存、复用那份**带插桩**的二进制，
  // 于是量出来的时间被抬高、stderr 还多出 prof 那几行 —— 正是拿这条腿量性能时最坑的一种。
  // `--profile cc|stub` 同一个理由（第一百四十七片）：那两档也改二进制。
  // **`sample` 不进**：它一个字节都不改，只是运行期多一个环境变量 —— 进了印记反而
  // 让「同一份二进制，采一趟、再不采一趟」白编两遍。
  const profEnv = env('OMNI_PROFILE') === '1' ? '|prof' : '';
  const profFlag = PROF !== null && PROF.mode !== 'sample' ? `|prof:${PROF.mode}` : '';
  /* **哪条路出来的二进制也得在印记里**（`one` 单体 / `mod` 一棵树切开 / `cmods` 每模块
     独立）：那是几份不同的二进制，串了在外面看就是"这个开关没生效"。
     这一格是**参数**不是全局：`buildSelfModules` 链接时走 `subMain(['c','link',…])`，
     内层 main 会把 `PER_MODULE_C` 重算成 false —— 于是 Put 时读到的是"单体"，
     清单里写下 `one`、下一趟按 `mod` 查，**永远不命中**（量出来就是这个）。 */
  const modeC = `|${mode}`;
  return `e1|${jsCacheStamp()}|cc:${cc}|${ccFlags(cc).join(' ')}${profEnv}${profFlag}${modeC}`;
}
/** 这一趟由谁编（印记里那格）。**Get 与 Put 必须同口径** —— `buildSelf` 交的是 `'self'`，
    而这儿从前问的是 `findCC()`（外部 cc 的名字），于是自带那台 C 前端那一路**永远不命中**。 */
function exeCC() {
  return selfCC() ? 'self' : findCC();
}

function exeCacheGet(path, cc, mode) {
  if (env('OMNI_NO_EXECACHE') === '1') return null;
  const key = `e-${hash16(path)}`;
  const dep = join(exeCacheDir(), `${key}.dep`);
  /* 可执行文件的落点是 `exeCachePath`（`<程序名>-<8 位>.out`），**不是 `${key}.bin`** ——
     这两处从前不是同一个名字，于是 `exists(exe)` 永远为假：清单写得好好的，缓存
     一次也没命中过（量出来：连跑两趟，第二趟照旧把前端 + 发射 + 链接全做一遍）。 */
  const exe = exeCachePath(path);
  if (!exists(dep) || exe === null || !exists(exe)) {
    vStep(`run exe cache  未命中（${!exists(dep) ? '没有清单' : '没有那份二进制'}）`);
    return null;
  }
  const lines = readText(dep).split('\n');
  if (lines[0] !== exeCacheStamp(cc, mode)) {
    /* **把两份印记都印出来**：光说"印记不同"找不到是哪一格（那一格可能是每趟都变的
       东西，那就是个 bug 而不是"你改了编译器"）。 */
    vStep('run exe cache  未命中（印记不同）');
    vStep(`  这一趟：${exeCacheStamp(cc, mode)}`);
    vStep(`  清单里：${lines[0]}`);
    return null;
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const f = lines[i].split('\t');
    if (!exists(f[0]) || `${mtimeMs(f[0])}` !== f[1] || `${fileSize(f[0])}` !== f[2]) {
      vStep(`run exe cache  未命中（${f[0]} 变了）`);
      return null;
    }
  }
  return exe;
}
function exeCachePut(path, cc, deps, mode) {
  if (env('OMNI_NO_EXECACHE') === '1' || deps.length === 0) return;
  const key = `e-${hash16(path)}`;
  const lines = [exeCacheStamp(cc, mode)];
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
  /* 名字是 **`<程序名>-<8 位>.out`**：前半截人看得懂（日志里印的是它），后半截把
     "同名不同目录"分开。生成的 C 与目标文件的名字都跟着产物走（`buildNative` 里
     `${basename(outPath)}.c`），所以这一格起好名字，`01-arith-1f2e3d4c.out.c` 这种
     也就看得出是谁。从前叫 `<哈希>.out`，一整棵暖存里全是十六进制。 */
  return runExeName(join(exeCacheDir(), `${progName(path)}-${hash16(path).slice(0, 8)}.out`));
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

/**
 * 「一份源码 -> 一目录 ESM 模块」的产物落点：`modules/js-<配置哈希>/`。
 *
 * **名字里不带哈希**：一台机器上这一格只存在一份。找库的路径（`ASYMPTOTE_DIR`、
 * 当前目录）已经在**单元名**里（名字带源文件路径的哈希），内建面那一档进**每一行的键**
 * （见 rowOf 的 `extras`）—— 两样都不该变成目录名里的一串十六进制。
 */
function jsModulesDir() {
  return moduleDir(cacheRoot(), 'js');
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

/**
 * 「这一份产物还是最新的吗」——是的话前端**连它的正文都不降**（第七十六刀）。
 *
 * 判据与写产物那一刻用的是**同一格印记**：印记里记着「编译器 + 它自己那个源文件 +
 * 它引到的那几个源文件」的 `路径:改动时间:字节数`，这里把每一格反过来 stat 一遍。
 * 全对上、并且 `.js` 与它那份声明文件都在，就把签名清单读回来给前端。
 *
 * 量出来的账：13 个库的 asyBodyPass 是 368ms（整个前端 645ms 的一半多），而它降出来的
 * 东西逐字节等于盘上那份 —— 这一刀省的就是它。声明遍那 221ms 省不掉：入口要那些表。
 */
/* 增量、接口、启动器那三样都在 `build/modules.js` 里（那一份不认识任何一门语言）：
 * 一份 `index.log` 记每个单元的键、一份 `ids.log` 是内容身份的预检表、一个模块一份
 * `<名字>.d.sx` 是它的接口。下面这些函数只是把 asy 前端交出来的单元清单喂给它。
 *
 * 一趟里索引只开一次（`unitIndex`）：它读两份文件，而"还新不新"要问几百次。 */
const unitIx = new Map();
function unitIndex(dir) {
  const had = unitIx.get(dir);
  if (had !== undefined) return had;
  const ix = new UnitIndex(dir);
  unitIx.set(dir, ix);
  return ix;
}

/* 一份声明文件（`<名字>.d.sx`）解出来的东西**在本进程里只解一次**。
 *
 * 为什么值得一格：`iface` 那一段是一整行 JSON（asy_builtins 那份 1.2MB），而同一趟里
 * 同一个模块的声明至少要问两遍（`iface` 自己一遍、它下面的 `skipFn`->`load` 再一遍），
 * 换个例子再跑又从头来。判据是文件的改动时间 + 字节数 —— 与 `srcFresh` 那一格同族。
 *
 * 这一格对常驻的工人（`omni serve`）最要紧：库的接口在两个例子之间**根本没动**，
 * 从前每个新例子都要把这几份 JSON 重读重解一遍（量出来 15ms，比前端本身还贵）。 */
const declMemo = new Map();           // 声明文件路径 -> {mtime, len, val}
function declOf(dir, name) {
  const p = declPath(dir, name);
  if (!exists(p)) { declMemo.delete(p); return null; }
  const m = mtimeMs(p);
  const n = fileSize(p);
  const had = declMemo.get(p);
  if (had !== undefined && had.mtime === m && had.len === n) return had.val;
  const val = declRead(dir, name);
  if (val !== null) declMemo.set(p, { mtime: m, len: n, val });
  return val;
}

function asyModsSkip(dir, cs, ext = 'js') {
  const extras = new Map();          // 产物名 -> {name, key, sigs, need}
  // 一份产物齐不齐：索引那一行还成立 + 产物（`.js` / `.c`）与它那份**声明文件**都在。
  // 「要跟着进来的那几份」也在行里（needs）。后缀是参数：JS 腿与 C 腿是**同一套**增量，
  // 只有产物的扩展名不同（§12 末节：方言的模块化是跨文件的，两条腿共用它）。
  const load = (nm) => {
    const r = unitIndex(dir).fresh(nm, cs);
    if (r === null || !exists(join(dir, `${nm}.${ext}`))) return null;
    const d = declOf(dir, nm);
    if (d === null) return null;
    return { name: nm, key: r.self, need: r.needs, sigs: d.sigs };
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
    return { sigs: me.sigs };
  };
  return {
    extras,
    fn: skipFn,
    // **接口索引**（第七十八刀）：产物这一套都齐了、声明文件里又有 `iface` 那一段的话，
    // 前端连这个库的源码都不读。先过一遍上面那关（索引那一行 + `need` 闭包），过了才认
    // 这一段 —— 判据是同一格。
    //
    // span 上那个 `file` 给一格轻壳：不读源码就没有全文与行表，而这条路上库的声明本来
    // 不该再报诊断（真报了也还有路径与偏移可看）。
    iface: (info) => {
      /* **默认开着**（`OMNI_ASY_IFACE=0` 关掉，对照用）。
       *
       * 这一格答的是"改一个字符要花多久"：只改入口时，产物那一层早就只重编 1 份了
       * （索引那一行说得清），可前端为了拿到库的**声明**还把 584KB 的 asy_builtins.asy
       * 重新词法 + 解析一遍 —— 量出来 205ms 词法 + 三百多毫秒解析。有了这一格就是读
       * 它旁边那份 `<名字>.d.sx`（接口），源码与树都不碰。
       *
       * 量出来的（往 01-arith.asy 末尾加一行注释再跑）：**1.11s -> 0.56s**。
       *
       * 从前默认关着，理由是"快但还不对"：220 个 EPS 例子里开索引出图 44 份、关索引 55 份，
       * 还剩两族只在这条路上才有的错（34 份 `'X' 在这里还看不见`、19 份默认值那一类）。
       * 那个账**是在修掉下面三处之前量的**，而且量的是出图数（那一轴问的是画得对不对，
       * 不是这一格对不对）。现在按答案量：`tests/asy/cases` 全部 + `tests/asy/draw` 全部
       * 逐字节相同（两百多个程序的文本输出），所以默认改成开。
       * 真在三维那一轴上撞见差别，`OMNI_ASY_IFACE=0` 一格关掉，并且把现场记进 ADR。
       */
      if (env('OMNI_ASY_IFACE') === '0') return null;
      const nm = cap('asy.unitName')(info);
      const d = declOf(dir, nm);
      if (d === null || d.iface === null) { vStep(`asy 接口索引不命中 ${nm} 声明里没有那一段`); return null; }
      if (skipFn(info) === null) { vStep(`asy 接口索引不命中 ${nm} 产物那一套没齐`); return null; }
      const obj = d.iface;
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
  const ev = jsModulesConfig(mainPath);
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
  const r = cap('asy.unitTexts')(path, asyModsSkip(dir, cs));
  // ADR-0015 第一步与第二步：指纹与归属先只打印不接线，好验两样都与"入口是谁"无关。
  if (env('OMNI_ASY_FP') === '1') {
    const fps = asyFps([...r.units, ...r.reused], cs);
    for (const n of [...fps.keys()].sort()) vStep(`asy 指纹  ${fps.get(n)}  ${n}`);
    for (const [nm, own] of r.owners === undefined ? [] : r.owners) {
      vStep(`asy 归属  ${own === '' ? '<运行时>' : own}  ${nm}`);
    }
  }
  writeText(join(dir, 'omni_rt.js'), cap('jsgen.runtimeModule')());
  // 一份产物在索引里那一行（这一格决定重不重编）：它自己那个源文件、`include` 摊进来的那些、
  // 依赖单元的源文件，外加几格附加标记。**身份是内容哈希**（`ContentIds`）—— touch 一下、
  // 重新 checkout 一遍都不该重编；改动时间与字节数只是省一次读的预检。
  //
  // `include` 那一格非有不可：正文有一半来自它们，可它们既不是这一份的 key、也不在 deps 里。
  // 少了这一格，改 base/plain_picture.asy 而 plain.asy 没动时 `plain` 那份产物照旧算"还能用"，
  // 盘上那份**旧代码**被复用 —— 量出来的样子是往 plain_picture.asy 里加的探针一声不响。
  //
  // 没有源文件的那份（omni_weak：内容由整个程序决定）只能哈希它自己的正文 —— 它小。
  const keyOfName = new Map();
  for (const u of r.units) keyOfName.set(u.name, u.key);
  for (const u of r.reused) keyOfName.set(u.name, u.key);
  const rowOf = (u) => {
    const deps = [];
    for (const d of u.deps === undefined || u.deps === null ? [] : u.deps) {
      const k = keyOfName.get(d);
      if (k !== undefined && k !== '') deps.push(k);
    }
    const extras = [];
    // 内建面那一档（`OMNI_ASY_BUILTINS`）换了，同一个源文件编出来的是另一份产物 ——
    // 它是这一份的**输入**，所以进键，不进目录名。
    const ab = env('OMNI_ASY_BUILTINS');
    if (ab !== undefined && ab !== '') extras.push(`builtins:${ab}`);
    if (u.key === '') extras.push(`text:${hash16(u.text)}`);
    return {
      key: '',
      self: u.key,
      incs: u.inc === undefined || u.inc === null ? [] : u.inc,
      deps,
      needs: u.need === undefined || u.need === null ? [] : u.need,
      extras,
    };
  };
  let made = 0;
  let kept = r.reused.length;
  const rows = new Map();   // 产物名 -> 这一趟算出来的那一行（入口那一行末尾还要补 needs）
  for (const u of r.units) {
    const jsPath = join(dir, `${u.name}.js`);
    const row = rowOf(u);
    rows.set(u.name, row);
    const key = unitIndex(dir).keyOf(row, cs);
    const had = unitIndex(dir).row(u.name);
    if (had !== null && had.key === key && exists(jsPath)) {
      kept++;
      continue;
    }
    // 核心方言那份文本**默认不落盘**（`OMNI_SX_DUMP=1` 才写）：它是调试通道，不是产物 ——
    // 产物只有 `.js` 与它的接口。留着它等于每份单元多一个文件、每趟多一次写。
    if (env('OMNI_SX_DUMP') === '1') writeText(join(dir, `${u.name}.sx`), u.text);
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
    // 下一趟要复用这一份时，前端连它的正文都不降 —— 那时靠的只有**它那份声明文件**
    // （`<名字>.d.sx`：它定义的名字与签名，外加模块层要的那一段）。
    // 「复用它时还得跟着进来的那几份」在索引行的 `needs` 里。
    //
    // **每一份都出接口**（生成物那几份也出）：少了谁的接口，引到它的那一份就跳不过去 ——
    // 量出来的样子是"290 份新拼、0 份原样留着"（整棵库白降一遍，而产物一份没变）。
    //
    // **入口那一份不出**：入口单元的前缀是空串（id 0），它的顶层名字于是是**裸的**
    // （`cardioid.asy` 里那个 `real f(real t)` 就叫 `f`）。出了接口之后，别的程序在算
    // "还要带哪几份"时会把某个生成物里出现的 `f` 认成"cardioid 定义的"，于是
    // `main-label3.js` 里多出一句 `omni_init_cardioid()` —— 量出来的样子就是 label3 与
    // gamma3 在 `$alen` 上炸（跑的是另一个例子的初始化）。入口本来也不该被谁复用。
    if (u.name !== r.entry) declWrite(dir, u.name, u.sec, u.iface);
    unitIndex(dir).set(u.name, row, cs);
    made++;
  }
  unitIndex(dir).save();
  vStep(`asy units      新编 ${made} 份、复用 ${kept} 份`);
  // 每一份自己的 `(main …)` 只做一件事：把**这一份**的全局清零（第二十四刀那条
  // "零初始化在入口最前面"，现在分到了各家）。所以入口那份 main 先把各家的清零跑一遍，
  // 最后才是入口自己 —— 入口的 `(main …)` 里才是真正的程序（含调各模块的 init）。
  // 少了这一步，别人家的全局是 undefined：量出来的样子是 cyclic 登记处那一格
  // `Cannot read properties of undefined (reading 'length')`。
  // 名字**去重**：同一份产物可能既在这一趟拼过的那批里、又在复用回来的那批里
  // （生成物那几份最容易撞上），重了的话启动器里同一个 `omni_init_…` 被 import 两次，
  // node 报 `Identifier … has already been declared`。
  const seen = new Set([r.entry]);
  const names = [];
  for (const u of [...r.units, ...r.reused]) {
    if (seen.has(u.name)) continue;
    seen.add(u.name);
    names.push(u.name);
  }
  names.sort();
  // 入口那一份的启动器**按入口起名**：这个目录是共用的，叫 main.js 的话两个入口互相盖
  const mainPath = join(dir, `main-${r.entry}.js`);
  const initOf = (n) => `omni_init_${cap('asy.jsUnitSym')(n)}`;
  writeText(mainPath, launcherText(r.entry, names, initOf,
    ["import './omni_rt.js';"], ['$js_check_uncaught();', '$flush();']));
  // 「这个入口用到哪几份产物」记进**索引里入口那一行**（needs），不再另出一份清单文件。
  //
  // 从前那份 `main-<入口>.dep` 里抄着三样：环境、编译器印记、用到的产物名。前两样现在
  // 各有各的去处 —— 环境在目录名里（jsModulesDir），编译器印记在每一行的键里 ——
  // 剩下的那一样本来就该待在索引里。少一种文件、少一处会抄错的判据。
  const entryRow = rows.get(r.entry);
  if (entryRow !== undefined) unitIndex(dir).set(r.entry, { ...entryRow, needs: names }, cs);
  unitIndex(dir).save();
  vStep(`asy units      -> ${dir}`);
  return mainPath;
}

/**
 * **运行期错误的钩子**（运行时装好之后、程序跑之前 eval 一小段）。
 *
 * 运行时默认那条是"打一行、`process.exit(70)`"—— 在子进程里那正好，可现在程序就跑在
 * 宿主里：一条 `cannot read '…': ENOENT` 会把**宿主自己**杀掉（serve 的常驻工人就是这么
 * 死的，撞出来过：一趟判据跑到第 71 个例子整个进程没了、退出码还是 0）。
 * 所以装个钩子改成 throw，消息先落在一格全局槽里 —— 跨回这一侧的只有字符串
 * （与 `repl.js` 里那格同一手；宿主的异常对象在方言那个值域里不是 dict）。
 */
const ASY_RT_HOOK = '$js_set_error_hook(function (m) {'
  + ' globalThis.$OMNI_ASY_ERR = String(m); throw new Error("omni-asy-abort"); });'
  + '\nglobalThis.$OMNI_ASY_ERR = "";';

/**
 * **这个进程里已经装着哪几份产物**（产物文件名 -> 它那份 `.load.js` 的改动时间）。
 *
 * 这是**故意**留在模块级的一格状态：常驻的正是它的意义 —— `omni serve` 的热工人一个
 * 进程接着跑好多趟，库那几份（asy_builtins 一份就 1.97MB）只该编一次。量出来的账：
 * V8 编那份库 35ms、第一趟 `init()` 里的惰性编译 78ms，而**第二趟 `init()` 只要
 * 0.3ms** —— 库的真活儿就这么点，剩下全是编译。
 *
 * 跨趟的干净由**各家自己的 `init()`** 保证（启动器每趟按次序全跑一遍，那本来就是
 * "把这一份的全局清零 + 重设"）。产物名是内容地址，所以"名字 + 改动时间"对得上就是
 * 同一份东西；换一个程序只多装它自己那一份（换的常常只有 `gen_…` 与入口）。
 *
 * **运行时那一份不进这张表**：它有二十来格顶层可变状态，其中 `$fnOne` 按**裸名字**记
 * 函数值（入口单元的名字没有前缀，两个程序都有 `f`），常驻的话第二个程序拿到的是第一个
 * 程序的闭包 —— 答案静默地错。它每趟重来，而它的正文每趟逐字节一样，V8 那格 eval
 * 编译缓存于是命中（量到第一趟 15.4ms、往后 1.1ms）。
 */
const ASY_LOADED = new Map();

/** 这个进程里那几份 `.load.js` 的正文（省掉每趟读 —— 运行时那份就有 334KB）。 */
const ASY_LOAD_TEXT = new Map();

/* **同一个全局对象里谁定义了哪个名字**（`declSpans` 那一段注释里是为什么）。
 *
 *   `ASY_OWNER`  顶层名字 -> `{mod, a, b}`：这个名字现在活着的定义是谁装的、在它那份
 *                正文里的哪一段
 *   `ASY_SPANS`  产物名 -> 它那份 `名字 -> [起, 止]` 表（产物名是内容地址，算一次就够）
 *   `ASY_STALE`  名字被**别人按不同正文**盖过的那几份 —— 再要用它就得重装
 *
 * 每趟只给"真装了的那几份"记账（入口、`gen_…`、运行时），库那几份一个进程里只记一次。 */
const ASY_OWNER = new Map();
const ASY_SPANS = new Map();
const ASY_STALE = new Set();

function asySpans(dir, name) {
  const at = mtimeMs(join(dir, name));
  const had = ASY_SPANS.get(name);
  if (had !== undefined && had.at === at) return had.map;
  const map = declSpans(asyLoadText(dir, name));
  ASY_SPANS.set(name, { at, map });
  return map;
}

/** 这一份刚装上：把它定义的名字记在自己名下，被它按**不同正文**盖掉的那几份标成要重装。 */
function asyClaim(dir, name) {
  const text = asyLoadText(dir, name);
  for (const [nm, sp] of asySpans(dir, name)) {
    const own = ASY_OWNER.get(nm);
    /* 重名大多是同一段正文（库那几份里同一个蹦床各发一遍）—— 那种情况下被盖的那一份
       照旧是对的，只有真不一样才标。账里连正文一起记着：回头去问 `asyLoadText` 就是
       每个重名一次 stat，几百个重名量出来能把一趟拖慢 10ms。 */
    if (own !== undefined && own.mod !== name
      && own.text.slice(own.a, own.b) !== text.slice(sp[0], sp[1])) {
      ASY_STALE.add(own.mod);
    }
    ASY_OWNER.set(nm, { mod: name, text, a: sp[0], b: sp[1] });
  }
  ASY_STALE.delete(name);
}

/**
 * 一份产物的**可 eval 正文**：`<名字>.load.js`（`import` 拆掉、顶层 `const`/`let` 改
 * `var`）。它与产物一一对应、一份只由那一份决定 —— 所以没有"按程序拼出来的大段"这种
 * 派生品（从前那条路在盘上攒了 16 份 2.4MB 的 `lib-…js`）。
 */
function asyLoadText(dir, name) {
  const src = join(dir, name);
  const lp = join(dir, `${name.slice(0, name.length - '.js'.length)}.load.js`);
  const fresh = exists(lp) && mtimeMs(lp) >= mtimeMs(src);
  const had = ASY_LOAD_TEXT.get(name);
  if (fresh && had !== undefined && had.at >= mtimeMs(src)) return had.text;
  const text = fresh ? readText(lp) : loadableText(dir, name);
  if (!fresh) writeText(lp, text);
  ASY_LOAD_TEXT.set(name, { text, at: mtimeMs(src) });
  return text;
}

/**
 * **把这个程序装起来并跑掉**：按启动器里的次序，一份产物一段 `eval`。
 * 库那几份进程里只装一次（`ASY_LOADED`），运行时与入口每趟重来。回退出码。
 */
function asyRunModules(dir, mainPath) {
  const at0 = mainPath.lastIndexOf('/');
  const mainName = at0 < 0 ? mainPath : mainPath.slice(at0 + 1);
  const ord = moduleOrderOf(dir, mainName);
  let loaded = 0;
  let kept = 0;
  for (const m of [...ord.mods, mainName]) {
    const perRun = m === 'omni_rt.js' || m === ord.entry || m === mainName;
    const src = join(dir, m);
    if (!perRun) {
      const at = mtimeMs(src);
      /* 「这一份已经装过了」还得**名字没被别人按不同正文盖过**（`ASY_STALE`）—— 少了
         后半句就会拿到上一个程序的同名定义。 */
      if (ASY_LOADED.get(m) === at && !ASY_STALE.has(m)) { kept++; continue; }
      evalJs(asyLoadText(dir, m));
      asyClaim(dir, m);
      ASY_LOADED.set(m, at);
      loaded++;
      continue;
    }
    /* 启动器那一份（`main-…`）最后 —— 它就是"按次序跑各家的 init"。 */
    if (m === mainName) {
      try {
        evalJs(asyLoadText(dir, m));
        asyClaim(dir, m);
      } catch (e) {
        /* 那格全局槽只用 `evalJs` 读（`cli.js` 这一份里连 `globalThis` 这个名字都不该
           出现 —— 自举那条腿的封闭子集，见文件头注）。 */
        const msg = evalJs('globalThis.$OMNI_ASY_ERR');
        if (typeof msg === 'string' && msg !== '') {
          evalJs('globalThis.$OMNI_ASY_ERR = "";');
          stderr(`omni: runtime error: ${msg}\n`);
          vStep(`exec in-process  装 ${loaded} 份、复用 ${kept} 份；运行期错误（回 70）`);
          return 70;
        }
        stderr(`${e !== null && e !== undefined && e.stack !== undefined ? e.stack : e}\n`);
        vStep(`exec in-process  装 ${loaded} 份、复用 ${kept} 份；程序抛了（回 1）`);
        return 1;
      }
      continue;
    }
    evalJs(asyLoadText(dir, m));
    asyClaim(dir, m);
    loaded++;
    /* 运行时刚装好 —— 钩子摆在这儿：`$js_set_error_hook` 这时候才有，而入口还没跑。 */
    if (m === 'omni_rt.js') evalJs(ASY_RT_HOOK);
  }
  vStep(`exec in-process  装 ${loaded} 份、复用 ${kept} 份`);
  return 0;
}

/**
 * 影响"同一个名字解析到哪个文件"的那几样 —— 它是**产物目录的配置键**
 * （`jsModulesDir`）：换了 ASYMPTOTE_DIR 或者换了当前目录（模块是**按当前目录**找的，
 * 量过），产物就落到另一格目录，两边互不相干。
 *
 * 还带上**主文件的名字**：TeX 那条路上 `_mainname()` 把它降成了字面量（dvips 会把
 * dvi 的文件名写进产物正文，`TeXDict begin … (equilateral_.dvi)` 那一行），而单元那一级
 * 的产物缓存是按**源码内容**做键的 —— 不带主文件名的话，asy_builtins 那一份会被下一个
 * 例子照旧复用，名字就是上一个例子的。量出来过：equilateral 之后跑 fano，产物里写着
 * `(equilateral_.dvi)`。
 */
function jsModulesConfig(path) {
  const d = env('ASYMPTOTE_DIR');
  const b = env('OMNI_ASY_BUILTINS');
  const m = path === undefined ? '' : cap('asy.fileUnitName')(path);
  return `env|${cwd()}|${d === undefined ? '' : d}|${b === undefined ? '' : b}|${m}`;
}

/**
 * 上一趟那份启动器还能直接用吗？能就回它的路径 —— 这一趟**不解析、不降级、不生成**，
 * 只剩 node 自己跑。
 *
 * 为什么这一格是必须的：产物缓存只砍掉"核心方言 -> JS"那一段，而量出来的大头在前端
 * （把库重新降一遍约 800ms），那发生在"知道产物还能用"**之前**。所以这一问本身必须便宜：
 * 读一份索引 + stat 它提到的那些文件。
 *
 * 问的东西与慢路**是同一个函数**（`UnitIndex.fresh`）：入口那一行新不新、它 needs 里的每一份
 * 新不新。从前这儿自己抄了一份判据（一份 `main-<入口>.dep` 清单 + 只核"它自己那个源文件"），
 * 于是 include 摊进来的文件在这条路上没人问 —— 慢路会重编、快路却先命中，盘上那份旧代码
 * 照旧被跑。同一件事只该有一处判据。
 */
/**
 * asy 的 C 腿：**每个源文件一份方言、一份 `.c`/`.h`、一份 `.o`**（§12 末节的定案）。
 *
 * 与 JS 腿（`asyModsBuild`）是**同一个形状**：同一份 `asy.unitTexts`、同一套 `UnitIndex`、
 * 同一格 `.d.sx` 接口、同一条"产物齐了就整段跳过"（`asyModsSkip`）—— 只有"降完之后发什么"
 * 不同（那边 `.js`，这边 `emitCModule` 的 `{h, c}`）。
 *
 * 于是"改一个字符"那一趟里，库的词法、降级、发射、哈希**一格都不做**。
 * `OMNI_ASY_CMODS=1` 开（还在接线，默认走合并树那条路）。
 */
/**
 * 这一趟 asy 走**每模块独立**那条路吗（§12 末节）。
 *
 * 三件事叠起来：动词对（`run` / `build`）、要的是 C 那条腿、没点那两个逃生口。
 * `--backend` 没给时的默认腿不一样：`build` 默认就是 C，`run` 只有宿主里没有 JS 引擎时
 * 才落到 C（见 profLeg 那段注释）。`--work` 给了就还是老路 —— 那条路才认这个开关。
 */
function asyCModsWanted(key, path, argv) {
  if (env('OMNI_ASY_CMODS') === '0') return false;
  /* `run-c` 是 `run --backend c` 的老拼法（cmds.js 那张表），它自己一格 key ——
     漏了这一格的样子是"测试套件那条 run-c 腿一声不响地还走老路"。 */
  if (key !== 'run' && key !== 'run-c' && key !== 'build') return false;
  if (typeof path !== 'string' || !path.endsWith('.asy')) return false;
  for (const f of ['--interp', '--mir', '--work']) if (argv.includes(f)) return false;
  if (!perModuleWanted(argv, path)) return false;
  if (key === 'run-c') return true;
  const bi = argv.indexOf('--backend');
  return bi >= 0 ? argv[bi + 1] === 'c' : (key === 'build' || !hasJsEngine());
}

function asyCModsBuild(path, outPath) {
  const dir = moduleDir(cacheRoot(), 'c-asy');
  mkdirAll(dir);
  const cs = srcStamp();
  const r = cap('asy.unitTexts')(path, asyModsSkip(dir, cs, 'c'));
  const arch = CROSS === null ? hostArch() : CROSS.arch;
  const os = CROSS === null ? hostOs() : CROSS.os;
  const fmt = fmtOfOs(os);
  const sysIncs = CROSS === null ? undefined : sysIncDirs(['--sysroot', CROSS.sysroot]);
  const rowOf = (u) => {
    const deps = [];
    const keyOf = new Map();
    for (const x of [...r.units, ...r.reused]) keyOf.set(x.name, x.key);
    for (const d of u.deps ?? []) {
      const k = keyOf.get(d);
      if (k !== undefined && k !== '') deps.push(k);
    }
    const extras = [];
    const ab = env('OMNI_ASY_BUILTINS');
    if (ab !== undefined && ab !== '') extras.push(`builtins:${ab}`);
    if (u.key === '') extras.push(`text:${hash16(u.text)}`);
    return { key: '', self: u.key, incs: u.inc ?? [], deps, needs: u.need ?? [], extras };
  };
  let made = 0;
  let kept = r.reused.length;
  const madeRows = [];
  for (const u of r.units) {
    const row = rowOf(u);
    const key = unitIndex(dir).keyOf(row, cs);
    const had = unitIndex(dir).row(u.name);
    const cPath = join(dir, `${u.name}.c`);
    if (had !== null && had.key === key && exists(cPath)) { kept++; continue; }
    const mod = cap('sx.textToMod')(u.name, u.text, `omni_init_${cap('asy.jsUnitSym')(u.name)}`);
    const mf = cap('cgen.module')(mod, u.name);
    writeText(join(dir, `${u.name}.h`), mf.h);
    writeText(cPath, mf.c);
    if (u.name !== r.entry) declWrite(dir, u.name, u.sec, u.iface);
    unitIndex(dir).set(u.name, row, cs);
    made++;
    madeRows.push({ nm: u.name, c: fileSize(cPath), h: fileSize(join(dir, `${u.name}.h`)) });
  }
  unitIndex(dir).save();
  vStep(`asy c 模块     新编 ${made} 份、复用 ${kept} 份 -> ${dir}`);
  /* **哪几份**重发了：只列新编的（复用的那些就是"没动"，一行数量足够）。 */
  for (const m of madeRows) {
    vSay(`新编 ${m.nm}.c ${fmtBytes(m.c)} + .h ${fmtBytes(m.h)}`);
  }
  /* 各家一格 `.o`（键 = 这一份的正文 + 它 include 到的那几家的 `.h` + 目标）。 */
  const names = [];
  const seen = new Set();
  for (const u of [...r.units, ...r.reused]) {
    if (seen.has(u.name)) continue;
    seen.add(u.name);
    names.push(u.name);
  }
  names.sort();
  const objDir = join(cacheRoot(), 'modules', 'c');
  const objs = [];
  const objOf = new Map();          // 模块名 -> 它那格 `.o`（打动态库时要按名字挑）
  let cc = 0;
  const ccRows = [];
  for (const nm of names) {
    const cPath = join(dir, `${nm}.c`);
    /* 键是**那一份在索引里的键**，不是它正文的哈希：索引那一行已经把"这份 `.c` 是什么"
       说全了（自己的源文件 + `include` 摊进来的那些 + 依赖单元的键 + 编译器指纹 `cs`），
       而正文是它们的函数。读 4 MB 的 C 再哈一遍是白花的 —— 量出来是没改任何东西的一趟里
       `c obj` 还要 294~346ms，而那一趟一格都没编。

       **编译器指纹必须在键里**（`cs` 已在行键里，这儿再挂一次是为了看得见）：`.o` 的输入
       不止那份 `.c` —— 我们自己那台 C 前端也是输入。少了这一格，改了后端 / C 前端之后旧的
       `.o` 照旧命中，那是**答案静默地错**（量到过：改了 emit 的零值构造那一段，日志写着
       "新编 4 份"而 `c obj 编了 0 格`，链接期 `符号 '_omni_new_C_box' 没有定义`）。 */
    const uk = unitIndex(dir).row(nm);
    const k = hash16([cs, uk === null ? readText(cPath) : uk.key, arch, os, fmt,
      LIBC === null ? '' : LIBC, CROSS === null ? '' : CROSS.sysroot].join('|'));
    const obj = join(objDir, `${nm}-${k.slice(0, 8)}.o`);
    objs.push(obj);
    objOf.set(nm, obj);
    if (exists(obj)) continue;
    const tmp = join(dir, `${nm}.o`);
    const t0 = nowMs();
    cObj(cPath, tmp, arch, [RUNTIME_DIR, dir], [], 'elf', os, sysIncs);
    mkdirAll(objDir);
    rename(tmp, obj);
    cc++;
    ccRows.push({ nm, obj, c: fileSize(cPath), o: fileSize(obj), ms: Math.trunc(nowMs() - t0) });
  }
  vStep(`c obj          ${objs.length} 份模块（这一趟编了 ${cc} 格）`);
  /* **编的是哪一份 `.c`**：从前只说"编了 N 格"，于是"哪一份慢"看不出来（用户提的那一格）。
     命中暖存的那些不逐行印 —— 它们等于"没动"，减法就能得到。 */
  for (const x of ccRows) {
    vSay(`编 ${x.nm}.c ${fmtBytes(x.c)} -> ${basename(x.obj)} ${fmtBytes(x.o)}  [${x.ms}ms]`);
  }
  /* 入口那一份：`main` 在这儿（各家的 `omni_init_*` 只清零，真正的初始化在入口自己的
     init 里 —— 与 JS 腿的启动器一一对应）。 */
  const initOf = (n) => `omni_init_${cap('asy.jsUnitSym')(n)}`;
  const lines = ['#include "omni.h"'];
  for (const nm of names) lines.push(`extern void ${initOf(nm)}(void);`);
  lines.push(`static void omni_all_init_(void) {`);
  for (const nm of names) if (nm !== r.entry) lines.push(`  ${initOf(nm)}();`);
  lines.push(`  ${initOf(r.entry)}();`);
  lines.push('}');
  lines.push('int main(int argc, char **argv) { omni_host_init(argc, argv);'
    + ' omni_run_entry(omni_all_init_); omni_js_check_uncaught(); fflush(stdout);'
    + ' return omni_host_exit_code(); }');
  const mainC = join(dir, `main-${r.entry}.c`);
  writeText(mainC, `${lines.join('\n')}\n`);
  const mk = hash16([readText(mainC), arch, os, fmt].join('|'));
  const mainObj = join(objDir, `main-${r.entry}-${mk.slice(0, 8)}.o`);
  if (!exists(mainObj)) {
    const tmp = join(dir, `main-${r.entry}.o`);
    cObj(mainC, tmp, arch, [RUNTIME_DIR, dir], [], 'elf', os, sysIncs);
    mkdirAll(objDir);
    rename(tmp, mainObj);
  }
  objs.push(mainObj);
  /* `-o` 给了就链到那儿（`omni build`），没给就落在模块目录里（`omni run`）。 */
  const exe = outPath === undefined ? join(dir, `${progName(path)}.out`) : outPath;
  const stk = fmt === 'macho' ? ['--stack-size', String(0x20000000)] : [];
  const rtObjs = runtimeObjectsSelf(arch, os);
  /* ---- 库那几份 + 运行时打成**一份动态库**（`run` 默认开，`OMNI_ASY_DYLIB=0` 关）
   *
   * 量出来的账（07-cond，都减掉 node 启动那 0.17s）：
   *   全静态链（4 份模块 + 21 格运行时）      ~400ms
   *   去掉 asy_builtins 那一份再链            ~140ms   <- 3.96 MB 的那一份就是大头
   *   库那些全进 dylib、只链入口 + main       ~20~60ms
   * 造一次 dylib 0.7s + `codesign` 30ms，之后**所有程序共用** —— 键是成员清单
   * （每格 `.o` 的名字里带内容哈希），与"谁是入口"无关。程序启动量不出差别（都 < 10ms）。
   *
   * 三处不开，各有理由：
   *   - `build -o` 那条路：用户要的是**能拿走的一份产物**，而它会 `LC_LOAD_DYLIB` 一条
   *     暖存里的绝对路径。`run` 是就地跑，没这个问题。
   *   - 交叉编译：dylib 得在**目标机**上找得到。
   *   - `-f elf`：ELF 那侧要 `--soname` + `--rpath`，这台机器上没法验 —— 没验过的不设默认。
   * macOS 上 dylib **非签不可**（`missing code signature`，量到过；可执行文件不签也跑得动）。 */
  const libWant = fmt === 'macho' && CROSS === null && outPath === undefined
    && env('OMNI_ASY_DYLIB') !== '0';
  let linkObjs = [...objs, ...rtObjs];
  let libArgs = [];
  if (libWant) {
    const members = [...names.filter((n) => n !== r.entry).map((n) => objOf.get(n)), ...rtObjs];
    const lbk = hash16([...members, arch, os, fmt,
      LIBC === null ? '' : LIBC].join('|'));
    const libPath = join(objDir, `libomniasy-${lbk.slice(0, 8)}.dylib`);
    if (exists(libPath)) {
      vStep(`asy 动态库     复用 ${libPath}  ${fileSize(libPath)} bytes`);
    } else {
      mkdirAll(objDir);
      const rcl = subMain(['c', 'link', ...members, '-o', libPath,
        '--arch', arch, '--os', os, '-f', fmt, '--shared',
        '--install-name', libPath, '--stdlib',
        ...(LIBC === null ? [] : ['--libc', LIBC]), '-q']);
      if (rcl !== 0) throw new OmniError(`asy c 模块：动态库没链上（成员 ${members.length} 格）`);
      /* 签名是 dyld 的硬要求，不是可选项（arm64 macOS）。tcc 自己也是 `system("codesign …")`。 */
      if (hostIsDarwin()) spawn('codesign', ['-f', '-s', '-', libPath], 'c');
      vStep(`asy 动态库     新造 ${libPath}  ${fileSize(libPath)} bytes（${members.length} 格）`);
    }
    linkObjs = [objOf.get(r.entry), mainObj];
    libArgs = ['--dylib', libPath];
  }
  /* **链接也要有一格键**：`.o` 的名字里带内容哈希，所以"同一串 `.o` + 同一组开关"链出来
     一定是同一个二进制 —— 没改任何东西的一趟里重链一遍是纯浪费（量出来 309~475ms，
     比这条路上别的任何一段都贵）。键落在 `<程序>.out.link` 里、二进制**名字不变**：
     按键起名的话改一个字符就多一份 3.5 MB 的产物，一天下来全是垃圾。 */
  const lk = hash16([...linkObjs, ...libArgs, arch, os, fmt, ...stk,
    LIBC === null ? '' : LIBC, CROSS === null ? '' : CROSS.sysroot].join('|'));
  /* 只在自己那个目录里记这一格键：用户指定的 `-o` 旁边不该多一份 `.link`。 */
  const lkPath = outPath === undefined ? `${exe}.link` : null;
  if (lkPath !== null && exists(exe) && exists(lkPath) && readText(lkPath) === lk) {
    vStep(`c link         复用 ${exe}  ${fileSize(exe)} bytes`);
    return exe;
  }
  const rc = subMain(['c', 'link', ...linkObjs, ...libArgs, '-o', exe,
    '--arch', arch, '--os', os, '-f', fmt, '--stdlib', ...stk,
    ...(CROSS === null ? [] : ['--sysroot', CROSS.sysroot]),
    ...(LIBC === null ? [] : ['--libc', LIBC]), '-q']);
  if (rc !== 0) throw new OmniError(`asy c 模块：链接没过（各模块的 C 留在 ${dir}）`);
  spawn('chmod', ['+x', exe], 'c');
  if (lkPath !== null) writeText(lkPath, lk);
  vStep(`c link         ${linkObjs.length} 个 .o${libArgs.length > 0 ? ' + 1 份动态库' : ''}`
    + ` -> ${exe}  ${fileSize(exe)} bytes`);
  return exe;
}

function asyModsFast(path, dir) {
  const nm = cap('asy.fileUnitName')(path);
  const mainPath = join(dir, `main-${nm}.js`);
  const cs = srcStamp();
  // 不成立时**说清是哪一格不成立**：这条快路一旦悄悄失效，整个前端就白跑一趟
  // （量出来的样子是「换个入口跑一趟，再跑回来又是满编 0.9s」），而从日志上看不出来。
  const miss = (why) => { vStep(`模块清单不命中 ${why}`); return null; };
  if (!exists(mainPath)) return miss('还没有这个入口的启动器');
  const entry = unitIndex(dir).fresh(nm, cs);
  if (entry === null) return miss('入口那一份不新了（或者还没编过）');
  for (const n of entry.needs) {
    if (!exists(join(dir, `${n}.js`))) return miss(`产物 ${n}.js 没了`);
    if (unitIndex(dir).fresh(n, cs) === null) return miss(`产物 ${n} 不新了（它的源文件或 include 变了）`);
  }
  if (!exists(join(dir, 'omni_rt.js'))) return miss('运行时那一份没了');
  vStep(`模块清单命中   ${entry.needs.length} 份产物一份没动`);
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
/* MSVC 那一档：找一次、配一次环境，之后这一趟都用它。 */
let MSVC_FOUND = null;
let MSVC_ENV_DONE = false;

/** 递给 `cli/msvc.js` 与 `cli/clang.js` 的宿主那几格（那两份自己不 import 宿主，好在测试里换掉）。 */
function ccIo() {
  const cacheFile = () => join(cacheRoot(), "msvc-env.json");
  return {
    env, exists, readDir, readText, isDir, mtimeMs, spawn, join,
    fail: (m) => new OmniError(m),
    cacheGet: (key) => {
      try {
        if (!exists(cacheFile())) return null;
        return JSON.parse(readText(cacheFile()))[key] ?? null;
      } catch { return null; }
    },
    cacheSet: (key, val) => {
      try {
        const all = exists(cacheFile()) ? JSON.parse(readText(cacheFile())) : {};
        all[key] = val;
        mkdirAll(cacheRoot());
        writeText(cacheFile(), JSON.stringify(all));
      } catch { /* 存不上下趟再问一遍，不是错 */ }
    },
  };
}

/** 找人 + 把 vcvars 那套环境捞进本进程。`ccRun` 与 `ccJob` 共用，各只做一次。 */
function msvcReady() {
  const io = ccIo();
  if (MSVC_FOUND === null) {
    const tgtArch = CROSS === null ? hostArch() : CROSS.arch;
    MSVC_FOUND = msvcFind(io, tgtArch);
    if (MSVC_FOUND.cl === null) {
      const looked = (MSVC_FOUND.looked ?? []).join("；");
      throw new OmniError("--cc msvc：这台机器上找不到 cl.exe（看过：" + looked
        + "）。装一份 VS 的「使用 C++ 的桌面开发」或 Build Tools，"
        + "或者用 OMNI_MSVC_CL 指一份 cl.exe");
    }
    vSay("msvc: " + MSVC_FOUND.cl + "（" + MSVC_FOUND.from + "）");
  }
  if (!MSVC_ENV_DONE) {
    const e = msvcEnv(io, MSVC_FOUND, { selfLibc: LIBC === 'self' });
    for (const k of Object.keys(e)) setEnv(k, e[k]);
    MSVC_ENV_DONE = true;
  }
}

/**
 * **LLVM 那一档：只找人，不配环境。** clang 自己会找 MSVC 与 Windows SDK（量过：普通会话、
 * `INCLUDE`/`LIB` 都空着，`clang` 与 `clang-cl` 都直接编得出跑得起来的 exe），所以这儿一格
 * 环境变量都不设 —— 设了反而会盖掉它自己挑的那套。
 *
 * 按「要哪一份 exe」记账（`clang` 与 `clang-cl` 可能来自两套安装），一趟里各只找一次。
 */
const CLANG_FOUND = new Map();
function clangReady(cc) {
  const want = clangWant(cc) ?? 'clang';
  const hit = CLANG_FOUND.get(want);
  if (hit !== undefined) return hit;
  const io = ccIo();
  const f = clangFind(io, cc, vsRoots(io));
  if (f.exe === null) {
    throw new OmniError(`--cc ${want}：这台机器上找不到 ${want}.exe（看过：`
      + (f.looked ?? []).join('；')
      + '）。装一份 LLVM（https://releases.llvm.org 的 Windows 安装包，或者 VS 安装器里'
      + '勾「适用于 Windows 的 C++ Clang 工具集」），或者用 OMNI_CLANG 指一份');
  }
  vSay(`${want}: ${f.exe}（${f.from}）`);
  CLANG_FOUND.set(want, f);
  return f;
}

/**
 * **自带 libc（`--libc self`）+ 外部 cc**：这一趟要不要自己编、自己链那份 libc。
 * msvc 与 Windows 上的 clang/clang-cl 都算 —— 两台都是「自己带 CRT」的，我们那份要不要上场
 * 由 `--libc self` 明说（缺省不上，见 `main` 里那格判据）。
 */
function selfLibcExt(cc) {
  if (LIBC !== 'self' || CROSS === null || targetOs() !== 'win32') return false;
  return isMsvc(cc) || (hostOs() === 'win32' && isClang(cc));
}



/**
 * **外部 cc 的唯一出口**（`spawn` 要的 `[cmd, ...args]`）。
 *
 * 三条腿：
 *   tcc / gcc / 真正的 clang-on-unix   原样递 —— 整棵编译器里拼的就是它们的说法
 *   msvc                               `cl.exe` 要先找出来（PATH 上没有）、开关要翻成 `cl` 说法
 *   Windows 上的 clang / clang-cl      人要找（PATH 上可能没有），开关按方言分两路：
 *                                      `clang` 是 GNU 说法（滤掉几格 Windows 上没有的），
 *                                      `clang-cl` 是 `cl` 说法（借 `msvcArgs` 那台翻译机）
 *
 * **Windows 之外不走 clang 这一腿**：Linux/macOS 上 `clang` 本来就在 PATH 上、吃的就是 GNU
 * 说法，原样递才对。
 */
function ccXlate(cc, argv) {
  if (isMsvc(cc)) {
    msvcReady();
    return [MSVC_FOUND.cl, ...msvcArgs(argv, ccIo(), { selfLibc: LIBC === 'self' })];
  }
  if (hostOs() === 'win32' && isClang(cc)) {
    const f = clangReady(cc);
    const io = ccIo();
    const extra = clangTargetArgs(hostArch(), CROSS === null ? null : CROSS.arch);
    const selfLibc = LIBC === 'self';
    /* **自带 libc 那一档还要把 MSVC 那套环境配上**（`--libc self` 才走这一格）。
     * 不是为了头（那边 `-nostdlibinc` / `/X` 把系统头全掐了），是为了**挑链接器**：
     * clang 的 MSVC 工具链在 PATH 上找得到 `link.exe` 就用它，找不到才退回 `lld-link`——
     * 而这一档上那两个链接器的行为不一样：`lld-link` 会把 `libcmt.lib` 里那些与我们的 libc
     * 重名的对象也拉进来，报一串
     *   lld-link: error: duplicate symbol: memcmp（还有 memcpy/snprintf/_fltused…）
     *   >>> defined at .omni-cache/rt/host-clang-cl/libc-string.o
     *   >>> defined at libvcruntime.lib(memcmp.obj)
     * 而 `link.exe` 按"对象里的定义优先于库里的"处理，同一组输入它链得出来（`--cc msvc`
     * 这一档就是这么跑通的）。`libcmt.lib` 本身是为了 `__chkstk` 那一格，躲不开。
     * 顺带 `LIB` 也配上了 —— 那正是 `libcmt.lib` 从哪儿找。 */
    if (selfLibc) msvcReady();
    if (isClangCl(cc)) return [f.exe, ...msvcArgs(argv, io, { selfLibc, clangCl: true, extra })];
    return [f.exe, ...clangArgs(argv, io, { selfLibc, target: extra })];
  }

  return [cc, ...argv];
}


/**
 * **MSVC 插桩那一档要的那份 `.obj`**（`--profile cc`）。
 *
 * `cl` 的 `/Gh` `/GH` 只管"每个函数进出各调一次 `_penter` / `_pexit`"，那一对**要我们自己
 * 提供**（不在任何库里，`/NODEFAULTLIB` 与否都一样）。它们不能用 C 写 —— 量出来的原因写在
 * `runtime/omni_prof_msvc_x64.asm` 头上（那两个钩子摆在"入参还在寄存器里"与"返回值已就位"
 * 这两个位置上，必须保住所有易失寄存器）。所以是一份汇编，拿**工具链自带的 `ml64.exe`**
 * （与 `cl.exe` 同一个目录）汇成 `.obj` 跟着一起链。
 *
 * 只在 `.asm` 比 `.obj` 新的时候汇一遍：这一格的输入就一份文件，不值得一套缓存键。
 */
function msvcInstrObjs(cc) {
  if (!isMsvc(cc)) return [];
  msvcReady();
  if (MSVC_FOUND.target !== 'x64') {
    throw new OmniError(`--profile cc 在 msvc + ${MSVC_FOUND.target} 上还没接：`
      + '`_penter`/`_pexit` 那一对只有 x64 一版汇编（arm64 要 armasm64、另一套寄存器与另一套'
      + '调用约定）。那边先用 `--cc clang`（它有 -finstrument-functions）或 `--profile sample`');
  }
  const src = join(RUNTIME_DIR, 'omni_prof_msvc_x64.asm');
  if (!exists(src)) throw new OmniError(`--profile cc（msvc）：找不到 ${src}`);
  const dir = join(cacheRoot(), 'work', 'prof-msvc');
  const obj = join(dir, 'omni_prof_hooks.obj');
  if (exists(obj) && mtimeMs(obj) >= mtimeMs(src)) return [obj];
  mkdirAll(dir);
  const ml = join(dirname(MSVC_FOUND.cl), 'ml64.exe');
  if (!exists(ml)) {
    throw new OmniError(`--profile cc（msvc）：这份工具链里没有 ${ml} —— 汇编器本来与 cl 一起`
      + '装（VS 安装器里「MSVC … 生成工具」那一格）。缺了它这一档编不出来');
  }
  const r = spawn(ml, ['/nologo', '/c', `/Fo${obj}`, src], 'c');
  if (r[0] !== 0) {
    throw new OmniError(`ml64 汇不动 ${src}（退出码 ${r[0]}）\n${r[1] ?? ''}${r[2] ?? ''}`);
  }
  vSay(`msvc: 插桩钩子 ${obj}（ml64）`);
  return [obj];
}

/** 上面那条翻译之后真的把它起起来。 */

function ccRun(cc, argv, mode) {
  const [cmd, ...args] = ccXlate(cc, argv);
  if (!isMsvc(cc)) return spawn(cmd, args, mode);
  /* **`cl` 把每个输入文件的名字回显到 stdout** —— 而 stdout 是**被编译的那个程序**的输出流，
   * 不是编译器的日记本。量到的是 `run --backend c --cc msvc` 的第一行多出一句
   *   01_basics.exe.c
   * 于是 js==c 那道门第一行就不一样。`/nologo` 只压横幅，这句回显没有开关可关
   * （MSVC 从 1.0 起就这么干），所以在这儿滤：它是**单独一行、正好等于某个输入的文件名**。 */
  const names = new Set(args.filter((a) => /\.(c|cc|cpp|cxx)$/i.test(a)).map((a) => basename(a)));
  const r = spawn(cmd, args, mode === 'o' ? 'c' : mode);
  const keep = String(r[1] ?? '').split(/\r?\n/).filter((l) => !names.has(l.trim()));
  const txt = keep.join('\n');
  if (mode === 'o' && txt.trim() !== '') stdout(txt.replace(/\n+$/, ''));
  return [r[0], txt, r[2]];
}


/** 一格作业（`spawnPar` 吃 `[cmd, ...args]`）。与 `ccRun` 同一条解析与翻译。 */
function ccJob(cc, argv) {
  return ccXlate(cc, argv);
}


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
 * 这一趟是不是交给 **Windows 上的外部 cc**（`msvc` / `clang` / `clang-cl`）。
 * 判「自带 libc 要不要缺省打开」用它：那几台自己带着 CRT 与一整套头。
 */
function extWinCc() {
  const v = ccPick();
  return isMsvc(v) || isClang(v);
}


/**
 * 问一次 `uname`。回**它印的那一行**；两种"没答案"分得清：
 *   `''`    有子进程可这台机器没有 `uname`（真 Windows 的 cmd）
 *   `null`  **这条腿上根本没有子进程**（浏览器；`host/browser.js` 的 `spawn` 当场抛）
 *
 * 为什么要分：`hostOs()` 把"没有 uname"读成 Windows，那条推断在 node 上是对的，
 * 可在页面里是假的 —— 那儿只是没有 `fork`。三个问平台的地方（`hostArch` /
 * `hostIsDarwin` / `hostOs`）共用这一格，别各写一个 try。
 */
function unameOut(flag) {
  try {
    const r = spawn('uname', [flag], 'c');
    return r[0] === 0 ? r[1].trim() : '';
  } catch {
    return null;
  }
}

/**
 * 本机是哪个架构。与 `hostIsDarwin` 同一条路子（问一次 `uname` 记住）——
 * `process.arch` 不在封闭 ABI 里（ADR-0011 决策 2），这份源码要能被自己编译。
 */
let ARCH_CACHE = '';
function hostArch() {
  if (ARCH_CACHE === '') {
    /* **Windows 上先问环境变量**（第 win-c-backend 刀）：那儿压根没有 `uname` 这个程序，
     * 于是 `unameOut` 回空串、这一格从前一律落成 `x86_64` —— 在 ARM64 的机器上就是错的
     * （拿它去挑 sysroot 与后端，编出来的是另一台机器的代码）。`PROCESSOR_ARCHITECTURE`
     * 是 cmd 自己都在用的那一格（ARM64 / AMD64 / x86），32 位进程跑在 64 位系统上时
     * 真相在 `PROCESSOR_ARCHITEW6432` 里，所以两格都看。 */
    const w = (env('PROCESSOR_ARCHITEW6432') ?? env('PROCESSOR_ARCHITECTURE') ?? '').toLowerCase();
    if (w !== '') {
      ARCH_CACHE = w === 'arm64' || w === 'aarch64' ? 'arm64' : 'x86_64';
      return ARCH_CACHE;
    }
    const m = unameOut('-m') ?? '';
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
  /* 先找 `<arch>-<os>`，找不到再找 `<os>`（第 win-c-backend 刀）。
   *
   * 为什么多这一格：win32 那一份**与 arch 无关** —— 它的平台层调的是 kernel32 的导入函数
   * （Windows 上没有稳定的裸 syscall），头也一样，于是 arm64-win32 与 x86_64-win32
   * 是**同一份**东西。另两个目标反过来：它们的 `libc/io.c` 里是 syscall 号，那是
   * 一个 arch 一套，所以仍然按 `<arch>-<os>` 放。
   *
   * 退回来的那一份**不悄悄退**：`--sysroot` 显式给的永远优先，而这一层退不到任何一份时
   * 照旧抛错（交叉编译按本机的头编出来的东西最贵，见下面那段）。 */
  for (const d of dirs) {
    for (const n of [name, tgt.os]) {
      const p = join(d, n);
      if (isDir(p)) return p;
    }
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
/**
 * **自带 libc（`--libc self`）那一档，我们那套头往哪儿找**（第 msvc 刀，第 clang 刀扩到 LLVM）。
 *
 * 两处用它：`ccFlags`（运行时与生成的 C）与 `cFileViaCc`（**用户自己那份 `.c`**）。
 * 后者从前没给，量到的是 `hello.c(1): fatal error C1083: Cannot open include file: stdio.h`。
 *
 * **偏偏不能摆进 `ccXlate`**（外部 cc 的唯一出口，那儿看着更顺手）：libc 自己那几份 `.c`
 * 要的是**另一套**头（`<sysroot>/libc` 那些内部头），它们也走同一条出口 —— 摆在那儿就等于
 * 把给用户程序的那套公开头塞给 libc 自己，两套 `struct __FILE` 打起来。
 *
 * 两台 cc 要的不一样：
 *   `cl`            `INCLUDE` 里故意只有 VC 自己那一份（UCRT 一进来就把 time_t/size_t 按它
 *                   的说法重定义），所以 freestanding 那几格（stddef/float/limits）得由我们
 *                   `<sysroot>/cc-include` 里那三个头顶上
 *   `clang`/`clang-cl`  有 `-nostdlibinc`：系统与 CRT 的头掐掉、**编译器自己那几个 freestanding
 *                   头还在**，于是只要给 `<sysroot>/include` 一条就够 —— 那三个头让 clang 自己
 *                   那份来（它那份跟着它的 ABI 走，比我们抄一遍稳）
 */
function selfIncArgs(cc) {
  if (LIBC !== 'self' || CROSS === null) return [];
  if (isMsvc(cc)) {
    return ['-I', join(CROSS.sysroot, 'include'), '-I', join(CROSS.sysroot, 'cc-include')];
  }
  if (hostOs() === 'win32' && isClang(cc)) return ['-I', join(CROSS.sysroot, 'include')];
  return [];
}

function ccFlags(cc) {
  // -pthread：入口可能跑在一条大栈的线程上（omni_run_entry），编译与链接两边都要这一位。


  // macOS 上 pthread 就在 libSystem 里、这个开关等于空操作；glibc 2.34 起也已并进 libc。
  /* **自带 libc**（方案 B）：用户程序与运行时那一套头在 `<sysroot>/include`，
   * 不是 MSVC 的 UCRT。libc 自己那几份 `.c` 反过来只吃 `<sysroot>/libc`（见 runtimeObjects）。 */
  const selfInc = selfIncArgs(cc);
  return isTcc(cc) ? ['-I', RUNTIME_DIR]
    : [optFlag(), '-std=c99', '-ffp-contract=off', '-w', '-pthread', '-I', RUNTIME_DIR, ...selfInc];
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
    DARWIN_CACHE = unameOut('-s') === 'Darwin' ? 1 : 2;
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
 *
 * **浏览器那条腿上根本没有子进程**（`host/browser.js` 的 `spawn` 当场抛），所以这儿
 * 接住它、记成 `linux`。为什么是"接住"而不是"报出去"：这一格被 `discoverPlugins` 与
 * `omni c` 那一组的默认值问到，而页面上跑一份 `.go` 也会路过它 —— 真要链接、真要装
 * 插件的那几档在这条腿上自己就会明着拒（那才是该响的地方）。记成哪一个都不影响答案：
 * 页面上没有 `.o`、没有链接器、没有 `.dylib`。
 */
let OS_CACHE = '';
function hostOs() {
  if (OS_CACHE === '') {
    /* 真 Windows 上**不必起子进程就能认出来**（第 win-c-backend 刀）：`OS=Windows_NT`
     * 与 `SystemRoot` 是那儿一定有的两格。省下的不只是一次 `uname`（那儿压根没有这个
     * 程序）—— 那一趟 spawn 在这条腿上是要真去 CreateProcessA 的，白花几十毫秒。 */
    if ((env('OS') ?? '') === 'Windows_NT' || (env('SystemRoot') ?? '') !== '') {
      OS_CACHE = 'win32';
      return OS_CACHE;
    }
    const s = unameOut('-s');
    if (s === null) OS_CACHE = 'linux';          /* 没有子进程的腿（浏览器）：见上 */
    else if (s === 'Darwin') OS_CACHE = 'osx';
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
 * **这一趟在给谁编**（本机还是 `--sysroot`/`--os` 指的那个目标）。
 *
 * 产物的名字要按它拼，不是按 `hostOs()`：Windows 上没有后缀的文件**压根启动不了**
 * （`dist/omni` 这个名字在 cmd 里敲下去是「找不到命令」），插件也得是 `.dll` 而不是
 * 本机那一套 `.dylib`/`.so` —— 在 macOS 上交叉编 Windows 的产物时这两处都会拼错。
 */
function targetOs() {
  return CROSS === null ? hostOs() : CROSS.os;
}

/**
 * 可执行文件在目标平台上该叫什么。Windows 上要 `.exe`（已经带后缀的不动），
 * 别的平台原样回去。
 */
function exeName(out) {
  if (targetOs() !== 'win32') return out;
  return /\.[A-Za-z0-9]+$/.test(basename(out)) ? out : `${out}.exe`;
}

/**
 * **内部产物**（`run` 那一趟的临时程序、暖存里那一份）在 win32 上的名字。
 *
 * 与 `exeName` 的区别：那一格是"用户用 `-o` 说了名字"，已经带后缀的就不动；这一格的名字
 * 是我们自己起的（`01_basics`、`02-strings-1f2e3d4c.out`），而 `CreateProcess` **只认
 * `.exe`** —— 量到的是
 *   `Error: cannot spawn: spawnSync …/work/run-01_basics.omni/01_basics ENOENT`
 * PE 已经链好了（1647104 字节、4 节、49 个导入桩），只是那个名字在 Windows 上起不来。
 * `.out` 这种我们自己加的后缀要**换掉**，不是往后面再接一段。
 */
function runExeName(out) {
  if (targetOs() !== 'win32') return out;
  if (out.endsWith('.exe')) return out;
  return out.endsWith('.out') ? `${out.slice(0, -4)}.exe` : `${out}.exe`;
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
  const r = ccRun(cc, ['-O2', '-w', hostIsDarwin() ? '-dynamiclib' : '-shared',
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
  /* **两份源码一份 dylib**：`omni_r3_gl.c` 是三维那一档的后端、`omni_ev_gl.c` 是 EVAL
     两门语言的设备（`docs/design/eval-realtime-gpu.md` §13）。两者没有共用的语义，共用的
     只是这套"顺手编一下、拿不到就回落"的挂法 —— 所以同一份库里两组符号，两侧各自 dlsym
     自己那几个名字。缺一份就只编另一份（`omni_ev_gl.c` 还没进 dist 的那种树上照旧能跑）。 */
  const srcs = ['omni_r3_gl.c', 'omni_ev_gl.c'].map((f) => join(GL_DIR, f))
    .filter((f) => exists(f));
  const hdr = join(GL_DIR, 'omni_gl.h');
  if (srcs.length === 0 || !exists(hdr)) return null;
  const cc = findClang();
  const slot = cacheSlot(cacheRoot(), 'gl', basename(cc),
    hash16([cc, ...srcs.map((f) => `${f}:${mtimeMs(f)}:${fileSize(f)}`),
      `${mtimeMs(hdr)}:${fileSize(hdr)}`].join('|')));
  const dir = slot.dir;
  const key = slot.stamp;
  const lib = join(dir, 'libomnigl.dylib');
  if (slot.fresh && exists(lib)) return lib;
  const stage = workDirFor('gl-stage', key);
  const staged = join(stage, 'libomnigl.dylib');
  const r = ccRun(cc, ['-O2', '-w', '-dynamiclib', '-o', staged, ...srcs,
    '-I', GL_DIR, '-framework', 'OpenGL',
    /* 文件纹理的解码走 ImageIO（§20.2）。 */
    '-framework', 'ImageIO', '-framework', 'CoreGraphics',
    '-framework', 'CoreFoundation'], 'c');

  if (r[0] !== 0) {
    vStep(`gl plugin  ${cc} 编不过，这一趟走 CPU 光栅器`);
    return null;
  }
  mkdirAll(dir);
  rename(staged, lib);
  slotDone(slot);
  vStep(`gl plugin  ${exists(lib) ? lib : staged}`);
  return exists(lib) ? lib : staged;
}

/**
 * **EVAL 那台 GL 设备在 node 这一侧的入口**（`docs/design/eval-realtime-gpu.md` §16）：
 * 把 `omni_ev_gl_napi.c` 与 `omni_ev_gl.c` 编成一格 `.node`，**js 腿与解释器腿**
 * 用 `process.dlopen` 装它（`host/gfx-cpu.js` 里那条 GL 转发支路）。
 *
 * 为什么要它：那两条腿是"改完立刻能跑"的路（没有 cc、没有链接），实时那一栏靠的就是它们
 * —— 而 GPU 那一半的代码早就在 `omni_ev_gl.c` 里了，缺的只是这道门。
 *
 * 与 `glPlugin()` 两处不同：这一份是 **N-API 扩展**（`-undefined dynamic_lookup`，
 * 符号在 node 进程里）、而且 N-API 的声明用**我们自己那一份**（`runtime/omni_napi.h`，
 * ADR-0038 的立场：不外挂本机的 node 头）。编不出来回 null —— 那一趟照旧 CPU 备选。
 */
function evGlAddon() {
  if (!exists('/System/Library/Frameworks/OpenGL.framework')) return null;
  if (!isDir(GL_DIR)) return null;
  const srcs = ['omni_ev_gl_napi.c', 'omni_ev_gl.c'].map((f) => join(GL_DIR, f));
  const hdr = join(RUNTIME_DIR, 'omni_napi.h');
  for (const f of [...srcs, hdr]) if (!exists(f)) return null;
  const cc = findClang();
  const slot = cacheSlot(cacheRoot(), 'gl-node', basename(cc),
    hash16([cc, ...[...srcs, hdr].map((f) => `${f}:${mtimeMs(f)}:${fileSize(f)}`)].join('|')));
  const out = join(slot.dir, 'omni_ev_gl.node');
  if (slot.fresh && exists(out)) return out;
  const stage = workDirFor('gl-node', slot.stamp);
  const staged = join(stage, 'omni_ev_gl.node');
  const shared = ['-fPIC', '-shared']
    .concat(hostIsDarwin() ? ['-undefined', 'dynamic_lookup'] : []);
  const r = ccRun(cc, ['-O2', '-w', ...shared, '-o', staged, ...srcs,
    '-I', RUNTIME_DIR, '-framework', 'OpenGL',
    /* 文件纹理的解码走 ImageIO（§20.2）。 */
    '-framework', 'ImageIO', '-framework', 'CoreGraphics',
    '-framework', 'CoreFoundation'], 'c');
  if (r[0] !== 0) {
    vStep(`gl addon  ${cc} 编不过，js 腿那一趟走 CPU 备选`);
    return null;
  }
  mkdirAll(slot.dir);
  rename(staged, out);
  slotDone(slot);
  vStep(`gl addon  ${out}`);
  return out;
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
  /* **Windows 上没有 `getconf`**：cmd 自己就把核数摆在环境里（`NUMBER_OF_PROCESSORS`）。
   * 量到的是 `Error: cannot spawn: spawnSync getconf ENOENT` —— 而且那一下是**致命**的，
   * 不是"问不出来就猜 4"：`spawn` 在这条腿上取不到程序直接抛。 */
  if (hostOs() === 'win32') {
    const w = Number(String(env('NUMBER_OF_PROCESSORS') ?? '').trim());
    JOBS_CACHE = Number.isInteger(w) && w > 0 ? (w > 16 ? 16 : w) : 4;
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
  /* **Windows 上退回串行**：这一格的实现是"生成一份 sh 脚本、里头 `cmd & cmd & wait`"，
   * 而那儿没有 `/bin/sh`（`cmd` 的 `&` 是顺序执行、`start /b` 又没有 `wait`）。
   * 退回串行只是慢，不影响任何一格产物 —— 真要并行，正解是在 Windows 上另写一份
   * （`start /b` + 轮询 rc 文件），那是另一刀，不该顺手塞在这儿。 */
  if (hostOs() === 'win32') {
    return jobs.map((j) => spawn(j[0], j.slice(1), 'c'));
  }
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
  /* 一格**按名字**的暖存（`rt/host-cc`），身份写在里头那份 `stamp` 里 —— 见 cacheSlot。
     从前是拿 `hash16(cc|flags|deps)` 当目录名：一台机器上永远只有一份，那串十六进制
     买不到东西，配置真变了的时候旧的那一格还留着没人清。 */
  const slot = cacheSlot(cacheRoot(), 'rt', `host-${basename(cc)}`,
    hash16([cc, ...flags, ...deps, libcStamp()].join('|')));
  const dir = slot.dir;
  const objs = srcs.map((p) => join(dir, `${basename(p, '.c')}.o`));
  /* **libc 那一批**（方案 B，只在 msvc + 自带 libc 时有）：与运行时那一批**头不一样**，
   * 所以分两批编。它们只吃 `<sysroot>/libc` 与公用的 `src/sysroot/libc`（内部头：
   * syscall.h、`struct __FILE`）—— 给用户程序那一套 glibc 形状的头绝不能进来。 */
  const libcSelf = selfLibcExt(cc);
  const libcDir = libcSelf ? join(CROSS.sysroot, 'libc') : '';
  const libcShared = libcSelf ? join(CROSS.sysroot, '..', 'libc') : '';
  const libcSrcs = [];
  if (libcSelf) {
    for (const d of (isDir(libcShared) ? [libcDir, libcShared] : [libcDir])) {
      for (const f of readDir(d)) if (f.endsWith('.c')) libcSrcs.push(join(d, f));
    }
    libcSrcs.sort();
  }
  const libcObjs = libcSrcs.map((p) => join(dir, `libc-${basename(p, '.c')}.o`));
  if (slot.fresh && objs.every((o) => exists(o)) && libcObjs.every((o) => exists(o))) {
    vStep(`runtime .o  ${objs.length} objects, cache hit ${dir}`);
    return [...objs, ...libcObjs];   /* libc 那一批也要回去 —— 少了它链接期全是 unresolved */
  }

  // 先编进暂存目录再整体 rename：中断不会留下半个缓存
  // **每个进程自己一个暂存目录**（`scratchDir` 按进程号命名）：同一刻两个进程各建各的，
  // 不会撞文件名；而且用完就扔 —— 从前那个时间戳键每趟留一个目录（task #55 的后半截）。
  const stage = scratchDir('rt-stage');
  const staged = srcs.map((p) => join(stage, `${basename(p, '.c')}.o`));
  if (libcSrcs.length > 0) {
    mkdirAll(dir);   /* 这一批直接落缓存那一格，目录得先在 */
    /* `cc-include` 只给 `cl`：clang 那一档有 `-nostdlibinc`，freestanding 那几个头用它自己的
     * （`ccXlate` 已经把那一格递上了）。 */
    const ccinc = isMsvc(cc) ? ['-I', join(CROSS.sysroot, 'cc-include')] : [];
    const linc = isDir(libcShared) ? ['-I', libcDir, '-I', libcShared, ...ccinc]
      : ['-I', libcDir, ...ccinc];
    const lr = spawnPar(libcSrcs.map((p, i) => ccJob(cc,
      [optFlag(), '-w', ...linc, '-c', '-o', libcObjs[i], p])));
    for (let i = 0; i < lr.length; i++) {
      if (lr[i][0] !== 0) {
        throw new OmniError(`自带那份 libc 编不过（${cc}）：${basename(libcSrcs[i])}\n`
          + `${lr[i][1] ?? ''}${lr[i][2] ?? ''}`);
      }
    }
    vStep(`libc .o  ${libcSrcs.length} objects compiled with ${cc}`);
  }
  const rs = spawnPar(srcs.map((p, i) => ccJob(cc, [...flags, '-c', '-o', staged[i], p])));
  for (let i = 0; i < rs.length; i++) {
    if (rs[i][0] !== 0) {
      /* 两个流都印：`cl.exe` 的诊断在 stdout 上（GNU 那几个在 stderr），
         只印一个的话 msvc 这条腿报错等于一片空白。 */
      throw new OmniError(`omni runtime failed to compile with ${cc}:\n`
        + `${rs[i][1] ?? ''}${rs[i][2] ?? ''}`);
    }
  }
  // 目标已存在 = 别人先建好了，下面那句会用它（rename 到一个非空目录在两个宿主上都是硬错，
  // 而宿主的错误不是可以 catch 的异常，所以先看一眼）。父目录得先在，rename 才有地方落。
  /* 一份一份搬进那一格（**原地**：这一格的名字是固定的，旧的那几份就该被盖掉），
     搬完才写 stamp —— 中断了下一趟发现 stamp 对不上，重来。 */
  mkdirAll(dir);
  let kept = staged;
  for (let i = 0; i < staged.length; i++) rename(staged[i], objs[i]);
  slotDone(slot);
  vStep(`runtime .o  ${srcs.length} objects compiled with ${cc}, ${jobCount()} jobs`);
  if (objs.every((o) => exists(o))) {
    /* 缓存那一份已经落地 -> 暂存里剩下的没人要了（`rename` 成功时它已经不在了，
       这一句管的是"别人先建好了"那一路）。 */
    dropScratch(stage);
    kept = objs;
  }
  return [...kept, ...libcObjs];
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
  const slot = cacheSlot(cacheRoot(), 'rt', `self-${arch}-${os}`,
    /* 键里**必须有编译器自己的印记**（`srcStamp()`，第 win-c-backend 刀）：这一路的 `.o`
     * 是**我们自己那台后端**编出来的，改了 `x64/from_mir.js` 的调用约定而键不变，
     * 下一趟就把旧的 `.o` 又端上来 —— 量到过：改完 Win64 的 ABI 再编，`cc 800ms`
     * 全是缓存命中，跑出来的还是 SysV 那一版（体积都一样，看不出来）。
     * 与上面 `jsCachePut` 那一格同一个道理，也与第七十九刀"产物名只取基名"同一类错：
     * 一个会跑错程序的缓存。
     *
     * **`OMNI_MIR_OPT` 也在键里**（2026-09-25 补）：这一路的 `.o` 过的是公共 MIR 优化管线，
     * 开着档编出来的字节与不开是两份东西，而从前键里没有它 —— 只要有人拿
     * `OMNI_MIR_OPT=2` 在冷缓存上编过一趟，后面**所有**默认档的构建都会安静地端到
     * 那份优化过的运行库（体积差不多，看不出来）。这里存的是原文而不是档位：
     * `''` 与 `'0'` 语义相同但各占一格，多一格空目录比少一格判据便宜。
     *
     * **`libcStamp()` 同理**（第 msvc 刀）：自带 libc 那一档的 `.o` 跟着 `src/sysroot` 里那套
     * 头与 `.c` 走，而它们不在 `deps`（那一格只看 `src/runtime`）—— 改完 sysroot 再编，
     * 量到的是"改了没效果"，因为端上来的还是旧的那一批。 */
    hash16(['self', arch, os, srcStamp(), libcStamp(), env('OMNI_MIR_OPT') ?? '',
      CROSS === null ? '' : CROSS.sysroot, ...deps].join('|')));
  const dir = slot.dir;
  const objs = srcs.map((p) => join(dir, `${basename(p, '.c')}.o`));
  if (slot.fresh && objs.every((o) => exists(o))) {
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
  /* **接力棒绑在身份上**（见 slotRelay）：同一个 stamp 才是这一趟的半成品。
     从前这儿只判 `exists(objs[i])`，于是改了一行运行时源码之后旧的 `.o` 照旧沿用 ——
     量出来是链接期 `符号 '_omni_js_frozen_tbl_g' 没有定义`（更坏的一种是答案静默地错）。 */
  const relay = slotRelay(slot);
  let made = 0;
  for (let i = 0; i < srcs.length; i++) {
    if (relay && exists(objs[i])) continue;   // 上一趟（也许被掐掉了）留下的，接着往下编
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
  slotDone(slot);               // 这一格齐了：下一趟按 stamp 直接命中
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
  /* **按模块切**是自带那台 C 前端上的默认（§12）：一个源文件一份 `.c`/`.h`、各自一格 `.o`
   * 暖存，改一个模块只重编它那一格。插件那几路（绑定 / 剪枝 / 计时表）照旧走单体，
   * 理由在 buildSelfModules 的头上。这一趟走哪条由 `PER_MODULE_C` 说（见 perModuleWanted）；
   * 这儿再核一遍那几个参数 —— `buildPluginSet` 那条路不经 switch，状态对它不作数。 */
  if (PER_MODULE_C && plugin === undefined && extern !== true && own === undefined
    && bind === undefined) {
    return buildSelfModules(mod, outPath, dir);
  }
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
      /* msvc 那一档还要多一份 `.obj`（`/Gh /GH` 要的 `_penter`/`_pexit`）—— 见 `msvcInstrObjs`。 */
      ...(PROF !== null && PROF.mode === 'cc' ? msvcInstrObjs(cc) : []),

      cPath, ...runtimeObjects(cc),
      '-o', outPath, '-lm', ...libs, ...libLinkArgs(mod.libs)]
    : [...ccFlags(cc), ...shared, cPath, '-o', outPath, ...libs, ...libLinkArgs(mod.libs)];
  const tCc0 = nowMs();
  const r = ccRun(cc, cargs, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`C backend produced code that ${cc} rejected:\n`
      + `${r[1] ?? ''}${r[2] ?? ''}\n(kept at ${cPath})`);
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
  const os = CROSS === null ? hostOs() : CROSS.os;
  const fmt = fmtOfOs(os);
  const sysIncs = CROSS === null ? undefined : sysIncDirs(['--sysroot', CROSS.sysroot]);
  const sysArgs = [
    ...(CROSS === null ? [] : ['--sysroot', CROSS.sysroot]),
    /* `--libc self` 也要递下去（第一百四十片）：那次 `c link` 是**这儿**发的，
     * 而「链哪一份 libc」是链接那一步的事 —— 与 `--sysroot` 同一条路。 */
    ...(LIBC === null ? [] : ['--libc', LIBC]),
  ];
  const t0 = nowMs();
  /* 生成的那一份 C 的 `.o` **进暖存**（`modules/c/<程序名>-<8 位>.o`）。
   *
   * 键就是这一份 `.o` 的全部输入：生成的 C 正文、目标（arch/os/格式）、sysroot/libc 那几格、
   * 以及"这一趟插不插桩"。同一份程序连跑两趟，第二趟一格都不用编 —— 量出来这一步是
   * 581ms~1166ms（696KB 的 C），从前每趟都白编一次。
   *
   * 先编进暂存再 rename 进暖存：两个进程同时编同一份时，读到的不会是半个文件。
   *
   * ⚠️ **编译器指纹（`srcStamp()`）也在键里**（2026-09-22 补上的一个真错）：从前键里只有
   * 生成的 C 与目标，于是**改了 MIR 优化管线或后端这一格照旧命中** —— 重编一趟，跑的还是
   * 上一版编出来的 `.o`。查 `GP_IN_F`（`regalloc.js`）时被它骗了很久：`-o gf_pt` 编了四趟，
   * 后三趟全是第一趟那个有 bug 的 object（段错误一模一样），而只要换个输出名就"好了"——
   * 文件名里有 `progName`，换名字等于换一格。与 `srcStamp` 那一段记的 asy 那次同一类错：
   * **一个会跑错程序的缓存是 bug，不是性能优化**。代价是改一次编译器、下一趟重编一份 C。
   *
   * 这是"C 也要标准模块化"的第一步：等发射按单元切开（每个单元一份 `.c` + 自动生成的 `.h`），
   * 每一份各自走这同一格暖存，改一个单元就只重编它那一格。现在还是**整程序一份**。 */
  const objKey = hash16([srcStamp(), cText, arch, os, fmt, LIBC === null ? '' : LIBC,
    CROSS === null ? '' : CROSS.sysroot, extern === true ? 'x' : '',
    plugin === undefined || plugin === null ? '' : 'p',
    PROF !== null && PROF.mode === 'cc' ? 'prof' : ''].join('|'));
  const objDir = join(cacheRoot(), 'modules', 'c');
  const obj = join(objDir, `${progName(outPath)}-${objKey.slice(0, 8)}.o`);
  if (exists(obj)) {
    vStep(`c obj 命中暖存  ${obj}  ${fileSize(obj)} bytes`);
  } else {
    /* `--profile cc` 那一趟：**生成的这一份**要插桩（第一百五十片第三格）。运行时那二十份
     * 走 `runtimeObjectsSelf`，一份都不插 —— 收集器（`omni_prof.c`）也在里头，插它就是栈爆。 */
    const tmp = `${cPath}.o`;
    cObj(cPath, tmp, arch, [RUNTIME_DIR], [], 'elf', os, sysIncs,
      PROF !== null && PROF.mode === 'cc');
    mkdirAll(objDir);
    rename(tmp, obj);
    vStep(`c obj（我们自己那台 C 前端）  ${cPath} -> ${obj}  ${fileSize(obj)} bytes`);
  }
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
  /* PE 上同一件事叫 `--stack`（`SizeOfStackReserve`，十进制，见 `pe-link` 那一段）。
   * 少了它主线程只有默认的 1MB：编译器自己一进递归下降就 0xC00000FD，而这条腿没有 SEH
   * —— 印出来的是**一个字节都没有**（量到过：`omni-arm64.exe help` 静静地死）。
   * 512MB 只是保留地址空间，页要用到才落地。DLL 没有这一格（栈是宿主进程的）。 */
  const stkPe = fmt === 'pe' && plugin === undefined ? ['--stack', String(0x20000000)] : [];
  const rc = subMain(['c', 'link', obj, ...rt, '-o', outPath,
    '--arch', arch, '--os', os, '-f', fmt, ...sh, '--stdlib', ...stk, ...stkPe, ...sysArgs, ...libs, '-q',
    /* `--profile` 这一趟顺手落一份链接图：Linux 上 profile 的每一格否则只是裸地址
       （见 writeLinkMap / profMapResolve）。不开 profile 时一个字节都不多写。 */
    ...(PROF === null ? [] : ['--map', `${outPath}.map`])]);
  if (rc !== 0) throw new OmniError(`OMNI_CC=self：链接没过（C 留在 ${cPath}）`);
  if (PROF !== null) {
    PROF.map = `${outPath}.map`;
    /* 产物路径记一格：`build --profile` 收尾时要把"照这句跑它"那条说得出来
       （见 profFoldedFinish 里 `PROF.key === 'build'` 那一格）。 */
    PROF.bin = outPath;
    /* 告诉子进程：你那份二进制的地址 -> 名字在这。子进程（链好的可执行文件）在报告期
       读这份图，用它翻 `backtrace` 拿到的裸地址。两侧都做翻名字的原因是：
       - 子进程（`omni_prof.c`）自己翻：`cc` 那一档的**标准输出**（`按自用排前 20 行`）
         就在子进程里印，那一段看不见 CLI 的事后翻。
       - CLI 事后翻（`profMapResolve`）：折叠栈落到了文件里，CLI 读回来再过五张表，
         那一段子进程已经退了。两遍翻是独立的：哪一遍先跑都行，都能改善结果。 */
    setEnv('OMNI_PROF_MAP', PROF.map);
  }
  /* 执行位（tcc 在 `tcc_output_file` 里 chmod 0777；我们自己写字节，所以自己补一句 ——
   * 少了它只能看着 `Permission denied`）。PE 上没有这一位（能不能跑看后缀），而在
   * Windows 上跑的那份核心连 `chmod` 这个程序都没有 —— 所以按**格式**分叉。 */
  if (fmt !== 'pe') spawn('chmod', ['+x', outPath], 'c');
  /* arm64 macOS 上共享库**没签名就 dlopen 不了**（量到的原话：`missing code signature
   * in <no uuid> '…/omni-c.dylib'`）。签名不在链接器里 —— tcc 自己也是链完
   * `system("codesign -f -s - <文件>")`（`tccmacho.c:2243`，configure 开 CONFIG_CODESIGN），
   * 所以这一句与 tcc 同口径。可执行文件走到这儿不签也跑得动（量过），只有 dylib 非签不可。
   * 判据是**产物的格式**，不是这台机器：在 macOS 上交叉编 `.dll` 时 `hostIsDarwin()`
   * 一样为真，而给一份 PE 签名只会得到 `the file … is not a valid Mach-O`。 */
  if (plugin !== undefined && fmt === 'macho' && hostIsDarwin()) {
    spawn('codesign', ['-f', '-s', '-', outPath], 'c');
  }
  vStep(`c link（我们自己的链接器）  -> ${outPath}  ${fileSize(outPath)} bytes`);
  if (extern === true) {
    writeText(`${outPath}.syms`, `${syms.join('\n')}\n`);
    vStep(`syms  ${syms.length} 个符号 -> ${outPath}.syms`);
  }
  tally(basename(outPath), plugin !== undefined, cText, fileSize(outPath), tGen, nowMs() - t0);
  return { cPath, cc: 'self' };
}

/**
 * 这一趟会不会**按模块**走（见 buildSelfModules）。一处判据两个用处：要不要摇树
 * （摇树看的是整程序的可达集，按模块编译不能要它）、以及走哪条出口。
 */
/**
 * C 那侧这一趟走**按模块**还是**单体**。
 *
 * 默认只有 **asy** 按模块：它的库大（`asy_builtins` 一份 2MB 的 C）而用户文件小，
 * 收益全在那儿；别的语言默认照旧单体（它们的判据还没铺齐）。`--modules` / `--one-file`
 * 显式拨，`run` 与 `build` 都收；`OMNI_C_ONEFILE=1` 是兜底（出了问题好二分）。
 *
 * 排除的那几路要的是"整份产物的符号表"那一层的东西（绑定、剪枝、计时表），
 * 与按模块编译是两件事：插件 / `--extern` / `--own` / `--bind` / `--profile`。
 */
function perModuleWanted(argv, path) {
  if (!selfCC() || PROF !== null) return false;
  for (const f of ['--plugin', '--extern', '--own', '--bind']) if (argv.includes(f)) return false;
  const b = argv.indexOf('--backend');
  if (b >= 0 && argv[b + 1] !== undefined && argv[b + 1] !== 'c') return false;
  if (argv.includes('--one-file') || env('OMNI_C_ONEFILE') === '1') return false;
  if (argv.includes('--modules')) return true;
  return typeof path === 'string' && path.endsWith('.asy');
}

/**
 * **按模块**编译（docs/design/build-system.md §12）：一个模块一份 `.c` + 一份同名 `.h`，
 * 各自走 `.o` 暖存，最后一起链。改一个模块就只重编它那一格 —— 从前是整程序一份 696KB
 * 的 `.c`，改一个字符要全编一遍。
 *
 * `.o` 的键是**这一份的全部编译输入**：它自己的正文 + 它 include 到的那几家 `.h` 的正文
 * （传递闭包）+ 目标那几格。少算一条边就是"改了签名却沿用旧的 `.o`" —— 那是答案静默地错，
 * 不是编译失败（运行时那 21 格刚踩过一次，见 modcache 的 slotRelay）。
 *
 */
function buildSelfModules(mod, outPath, dir) {
  const arch = CROSS === null ? hostArch() : CROSS.arch;
  const os = CROSS === null ? hostOs() : CROSS.os;
  const fmt = fmtOfOs(os);
  const sysIncs = CROSS === null ? undefined : sysIncDirs(['--sysroot', CROSS.sysroot]);
  const sysArgs = [
    ...(CROSS === null ? [] : ['--sysroot', CROSS.sysroot]),
    ...(LIBC === null ? [] : ['--libc', LIBC]),
  ];
  mkdirAll(dirname(outPath));
  mkdirAll(dir);
  const tGen0 = nowMs();
  const u = cap('cgen.units')(mod);
  const tGen = nowMs() - tGen0;
  LAST_CGEN_STATS = u.stats;
  const all = [u.gen, ...u.units];
  const byName = new Map();
  for (const x of all) byName.set(x.name, x);
  let bytes = 0;
  for (const x of all) {
    writeText(join(dir, `${x.name}.h`), x.h);
    writeText(join(dir, `${x.name}.c`), x.c);
    bytes += x.h.length + x.c.length;
  }
  LAST_EMIT_BYTES = bytes;
  {
    let sum = 0;
    for (const r of u.stats.values()) sum += r.bytes;
    LAST_EMIT_PROG = sum;
  }
  vStep(`backend c（按模块）  ${all.length} 份模块，${bytes} bytes -> ${dir}`);
  const t0 = nowMs();
  const objDir = join(cacheRoot(), 'modules', 'c');
  const objs = [];
  let made = 0;
  /* 每家的 `.h` 先各算一次哈希：键里拼的是**哈希**，不是 `.h` 的正文。
     拼正文是 O(n²) 字节（155 个单元 × 各自依赖的头全文 = 几个 GB），量出来是
     `JavaScript heap out of memory`。 */
  const hOf = new Map();
  for (const x of all) hOf.set(x.name, hash16(x.h));
  for (const x of all) {
    /* 这一份的编译输入：正文 + 传递闭包上那几家的 `.h`。 */
    const parts = [hash16(x.c)];
    const seen = new Set();
    const todo = [...x.deps];
    while (todo.length > 0) {
      const d = todo.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      if (!hOf.has(d)) continue;
      const y = byName.get(d);
      for (const e of y.deps) todo.push(e);
    }
    for (const d of [...seen].sort()) if (hOf.has(d)) parts.push(`${d}:${hOf.get(d)}`);
    /* 同一条规矩：**编译器指纹进键**（见 asyCModsBuild 里那段账）。 */
    const key = hash16([srcStamp(), ...parts, arch, os, fmt, LIBC === null ? '' : LIBC,
      CROSS === null ? '' : CROSS.sysroot].join('|'));
    const obj = join(objDir, `${x.name}-${key.slice(0, 8)}.o`);
    objs.push(obj);
    if (exists(obj)) continue;
    const tmp = join(dir, `${x.name}.o`);
    cObj(join(dir, `${x.name}.c`), tmp, arch, [RUNTIME_DIR, dir], [], 'elf', os, sysIncs);
    mkdirAll(objDir);
    rename(tmp, obj);
    made++;
  }
  vStep(`c obj  ${objs.length} 份模块（这一趟编了 ${made} 格）`);
  const rt = runtimeObjectsSelf(arch, os);
  const stk = fmt === 'macho' ? ['--stack-size', String(0x20000000)] : [];
  const rc = subMain(['c', 'link', ...objs, ...rt, '-o', outPath,
    '--arch', arch, '--os', os, '-f', fmt, '--stdlib', ...stk, ...sysArgs,
    ...cAbiLibs(mod.cabi ?? []).map((l) => `-l${l}`), ...selfLibArgs(mod.libs), '-q']);
  if (rc !== 0) throw new OmniError(`OMNI_CC=self：链接没过（各模块的 C 留在 ${dir}）`);
  spawn('chmod', ['+x', outPath], 'c');
  vStep(`c link（我们自己的链接器）  ${objs.length + rt.length} 个 .o -> ${outPath}`
    + `  ${fileSize(outPath)} bytes`);
  tally(basename(outPath), false, all.map((x) => x.c).join('\n'), fileSize(outPath), tGen,
    nowMs() - t0);
  return { cPath: join(dir, 'omni_gen.c'), cc: 'self' };
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
    /* 后缀按**目标**拼，不按这台机器：在 macOS 上交叉编 Windows 的插件时
     * `hostOs()` 给的是 `.dylib`，而那份东西是 PE —— 名字与内容对不上，
     * 核心那侧按名字找 `.dll` 也就找不着。 */
    const out = join(dir, `omni-${p.name}${dsoExt(targetOs())}`);
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
  /* 这一趟按模块吗 —— **进来就取快照**：底下链接那一步走 `subMain`，内层 main 会把
   * 这格全局重算掉（见 exeCacheStamp 里那段账）。 */
  const perMod = PER_MODULE_C;
  const wi = argv.indexOf('--work');
  // `--work` 给了就照它办（要的是"留在那儿"）；否则**直接链进产物缓存那一格** ——
  // 下一趟同一份源码进来，exeCacheGet 命中就只剩 exec（第一百〇五刀）。
  const cached = wi >= 0 || cache !== true ? null : exeCachePath(srcPath);
  const dir = wi >= 0 ? argv[wi + 1] : workDirFor('run', workName(srcPath));
  if (wi >= 0) mkdirAll(dir);
  const exe = runExeName(cached === null ? join(dir, progName(srcPath)) : cached);
  /* 工作目录**总是按源文件起名**（`work/run-<源名>/`）：产物落进暖存那一格时它的名字带
     内容哈希（`02-strings-1633f663.out`），从前 buildNative 按产物名算目录，于是每换一个
     哈希就多一个 `work/c-02-strings-1633f663.out/`，里头那份 `.c` 也叫
     `02-strings-1633f663.out.c` —— 目录攒垃圾、名字也读不出是谁。 */
  const built = buildNative(mod, exe, dir);
  if (cached !== null) exeCachePut(srcPath, built.cc, cap('asy.deps')(), perMod ? 'mod' : 'one');
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
  const r = ccRun(cc, args, 'o');
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
    const r = ccRun(cc, ['-O2', '-w', ...shared, '-I', RUNTIME_DIR, src, '-o', staged], 'o');
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
  const r = ccRun(cc, args, 'o');
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
  const exe = join(dir, progName(srcPath));
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
  const r = ccRun(cc, args, 'o');
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
/** 进程**起来时**那两格的样子（见 asyRunSetup 里那段"一趟一格"）。 */
const ASY_ENV0 = {
  fmt: env('OMNI_ASY_OUTFORMAT') ?? '',
  name: env('OMNI_ASY_OUTNAME') ?? '',
};
function asyRunSetup(path, rest) {
  if (!path.endsWith('.asy')) return;
  /* **一趟一格**：这两格设置住在环境里，而常驻工人（`omni serve` 的热工人池）一个进程
     跑很多趟 —— 上一趟的 `-f svg` 会留给下一趟，于是后面那趟明明没给 `-f` 也出 SVG。
     量出来的：tests/serve 那格「不认的格式当没给」原先是红的（先来一趟
     `format: 'svg'`，紧跟那趟还是 SVG）。与 `SRC_SX` 同一族（见 `main` 的头注）。
     **退回进程启动时的样子、不是清空**：外面的跑手是用环境喂它们的
     （`tests/asy/eps.js:381` 的 `env: { …, OMNI_ASY_OUTFORMAT: 'eps', OMNI_ASY_OUTNAME: pic }`）。 */
  setEnv('OMNI_ASY_OUTFORMAT', ASY_ENV0.fmt);
  setEnv('OMNI_ASY_OUTNAME', ASY_ENV0.name);
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
  const flags = ['-O2', '-g', ...selfIncArgs(cc)];
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
    const prc = ccRun(cc, ['-O2', '-g', '-I', RUNTIME_DIR, '-c',
      join(RUNTIME_DIR, 'omni_prof.c'), '-o', pobj], 'c')[0];
    if (prc !== 0) throw new OmniError(`${cc} 编不过收集器 omni_prof.c（退出码 ${prc}）`);
    objs.push(pobj);
    if (instr) {
      flags.push('-finstrument-functions');
      /* msvc 那一档：`/Gh /GH` 要的 `_penter`/`_pexit` 在一份自己汇的 `.obj` 里。 */
      objs.push(...msvcInstrObjs(cc));
    }

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
      const src = ccRun(cc, ['-O2', '-c', shim, '-o', sobj], 'c')[0];
      if (src !== 0) throw new OmniError(`${cc} 编不过采样启动那一格（退出码 ${src}）`);
      objs.push(sobj);
    }
  }
  /* `-lm`：数学库在 Linux 上是单独一份（macOS 上并进 libSystem，多给这一格也无害）。
   * `.c` 输入里 `sqrt`/`pow` 太常见，少这一格会在链接那一步倒。 */
  /* **msvc + 自带 libc**：用户这份 `.c` 也得链上我们那份 libc —— `printf` 与入口 `_start`
   * 都在里头（这条腿走 `/NODEFAULTLIB`，MSVC 的 CRT 一格都不接）。量到的是
   *   LINK : error LNK2001: unresolved external symbol _start
   *   hello.obj : error LNK2019: unresolved external symbol printf
   * 复用 `runtimeObjects` 那一格缓存，只挑 `libc-*` 那几份（运行时那 20 多份这儿用不上）。 */
  const libcObjs = selfLibcExt(cc)
    ? runtimeObjects(cc).filter((o) => basename(o).startsWith('libc-')) : [];
  const args = [...flags, path, ...objs, ...libcObjs, '-o', exe, '-lm'];
  const r = ccRun(cc, args, 'c');
  const rc = r[0];
  vStep(`${cc} ${mode === null ? '' : `--profile ${mode} `}${path} -> ${exe}`);
  if (rc !== 0) throw new OmniError(`${cc} 编不过 ${path}（退出码 ${rc}）\n` + `${r[1] ?? ''}${r[2] ?? ''}`);
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
      '-f', fmt, '--arch', arch, '--os', os, '--stdlib', '-q',
      /* 交叉与 `--libc self` 也要递下去（第 win-c-backend 刀）：从前这儿只有 arch/os，
       * 于是 `build x.c --arch arm64 --os win32 --libc self` 落进 `c link` 的**本机**那一支，
       * 报的是 `pe: 找不到 x86_64-win32-libtcc1.a` —— 连目标都没换过去。
       * 这两格一递，`c link` 里那段 `--libc self` 自己会把 sysroot 那份 libc 编进来、
       * 把 `-L`/`--target`/入口摆好（与 `buildSelf` 走的是同一段）。 */
      ...(LIBC === null ? [] : ['--libc', LIBC]),
      ...(CROSS === null ? [] : ['--sysroot', CROSS.sysroot])]);
    if (rc !== 0) return rc;
    if (os !== 'win32') spawn('chmod', ['+x', out], 'c');
  }
  stderr(`omni: built ${out} via ${via === null ? `自带的 C 前端 + ${fmt} 链接器` : ccPick()}\n`);
  return 0;
}

/* ---- 开发期的墙上时限（每一个动词都有，不只 `run`）
 *
 * 账写在 `docs/design/dev-deadline.md`。这儿三句：
 *
 *   * **为什么每个动词都要**：`run` 早就有 30s 的默认时限，可挂住的那一趟常常不是 `run`
 *     —— `build` 里一个不收敛的定点循环、判据脚本直接跑链出来的可执行文件。
 *     开发期一次这样的挂住就是十几分钟，而那十几分钟里**一个字节的信息都没有**。
 *   * **两个预算，一个机制**：`OMNI_TIMEOUT`（跑一个程序，默认 30s）与
 *     `OMNI_BUILD_TIMEOUT`（编译这一趟，默认 300s）。分开是因为"编一份大东西要五分钟"
 *     是正常的，而"跑一个例子要五分钟"不是。
 *   * **哪儿来的数**：`--timeout SEC`（这一趟）> 环境变量 > 仓库根的 `.env` > 默认。
 *     `0` / `off` / `none` = 不限；`--release` 或 `OMNI_RELEASE=1` 也不限。
 *
 * 时限本身由宿主拿着（`runTimeout`）—— 只有它能中断两种"跑"：子进程那一路是
 * `spawnSync` 的时限，本进程那一路（`evalJs` / 解释器 / 我们自己那台编译器）是另一根
 * 线程上的看门狗。这儿留一份**同样的截止时刻**，用来在回到这一层的时候判断"这一趟是不是
 * 被时限打断的"：子进程被杀之后 `spawn` 是**正常返回**的，退出码分不出"超时"与"失败"。
 *
 * 印字的人有两个（子进程那一路是这儿、本进程那一路是看门狗），但那句话只有一份 ——
 * 文本是造好之后交给宿主的，不是两边各写一遍。
 *
 * **链出来的可执行文件自己也带一格**（SIGALRM，默认同样 30s，同样读 `OMNI_TIMEOUT` /
 * `.env`）—— 见 `src/runtime/omni_js_host.c` 的 `omni_deadline_init_`。那一格管的是
 * "不经 omni 跑"的那条路。
 */
const RUN_TIMEOUT_DEFAULT_S = 30;
const BUILD_TIMEOUT_DEFAULT_S = 300;
/** 跑一个程序的那几个动词（别的都按"编译"算）。 */
const RUNNING_VERBS = new Set(['run', 'run-c', 'exec', 'interp']);
/**
 * **常驻/交互那几个动词一格时限都不装**。
 *
 * `serve` 是守护进程、`repl` 是人坐在前面敲 —— 给它们一格 300s 的墙上时限，
 * 意思就是"用到五分钟自己死"。这两格的"挂住"是**正常状态**，不是要治的毛病。
 */
const LONG_VERBS = new Set(['serve', 'repl']);
let RUN_DEADLINE = 0;
let RUN_TIMEOUT_MSG = '';

/** 仓库根的 `.env` 里那一行（读不到回 null）。只读一次，缓存。 */
let DOTENV = null;
function dotEnv(name) {
  if (DOTENV === null) {
    DOTENV = new Map();
    /* 落点与缓存根同一条规矩（见 host/cache.js 的 treeRoot）：先当前目录，
       再往上找带标志文件的那一层。读不到就是空表 —— 没有 `.env` 是正常情形。 */
    for (const p of ['.env', join(cwd(), '.env')]) {
      try {
        if (!exists(p)) continue;
        for (const line of readText(p).split('\n')) {
          const s = line.trim().replace(/^export\s+/, '');
          const eq = s.indexOf('=');
          if (eq <= 0 || s.startsWith('#')) continue;
          DOTENV.set(s.slice(0, eq).trim(), s.slice(eq + 1).trim().replace(/^["']|["']$/g, ''));
        }
        break;
      } catch { /* 读不动就当没有 */ }
    }
  }
  return DOTENV.has(name) ? DOTENV.get(name) : null;
}

/** 一格秒数的三级来源：环境变量 -> `.env` -> 默认。`0`/`off`/`none` 回 0（= 不限）。 */
function timeoutBudgetS(name, dflt) {
  const raw = env(name) ?? dotEnv(name);
  if (raw === null || raw === undefined || raw === '') return dflt;
  if (raw === 'off' || raw === 'none') return 0;
  const t = String(raw).endsWith('s') ? String(raw).slice(0, -1) : String(raw);
  const n = Number(t);
  return (t === '' || !(n >= 0) || n === Infinity) ? dflt : n;
}

/**
 * **EVAL 两门语言（`.pss` / `.kc`）的那几格图形旗子 -> 设备读的那几格环境变量。**
 *
 * 为什么走环境变量而不是"传参进去"：设备有三份实现（`host/gfx-cpu.js` 给 js 与 interp
 * 两条腿、`runtime/omni_fmt.c` 给 C 腿、`studio/gfx-gl.js` 给浏览器），而 C 腿是**另一个
 * 进程**里的一份产物 —— 环境变量是这四条腿唯一都认的那格口径，而且它**不进产物缓存的
 * 印记**（同一份编好的东西换个旗子再跑就换个行为，与 `.asy` 的出图设置同一条规矩）。
 *
 * 旗子照 c_impl 的 `polydraw-render` / `polydraw-view`（`/Users/wurui/Documents/polydraw`）：
 *
 *   omni run x.pss                        render（默认）：画一帧，落 .omni-cache/gfx/frame.png
 *   omni run x.pss --frame 30 -o out.png  走到第 30 帧、**只交出那一帧**（前 30 帧真跑过去）
 *   omni run x.pss --w 640 --h 480        画布尺寸（默认 320×240）
 *   omni run x.pss --perf                 每帧耗时与 fps 印到 stderr（`#perf gfx …`）
 *   omni run x.pss --mode view            有窗口地跑 —— **这条腿上还没有窗口**（任务 #24），
 *                                         当场说清楚；浏览器里的 Studio 就是 view 那一档
 *
 * `--mode` 这格名字与类型模式（`mixed|dynamic|static`，ADR-0008）共用 —— 取值不重叠，
 * 所以只认 `render`/`view` 这两个值，别的原样留给那一档。
 */
function applyGfxFlags(verb, path, rest) {
  if (verb !== 'run' || path === undefined || path === null) return;
  if (!(path.endsWith('.pss') || path.endsWith('.kc'))) return;
  /* **素材（文件纹理）按脚本所在的目录找**：`glsettex(0,"earth.jpg")` 里那是个相对路径，
     而原版是在脚本旁边跑的（`kzopen` 按 cwd）。判据从仓库根跑，所以这儿把脚本那一格目录
     交给设备（`OMNI_GFX_DIR`）—— 环境变量对两条腿都管用（js 腿同进程、原生腿继承）。 */
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  setEnv('OMNI_GFX_DIR', cut > 0 ? path.slice(0, cut) : '.');
  const val = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : undefined;
  };
  const num = (n, name) => {
    const v = val(n);
    if (v === undefined) return;
    const k = Number(v);
    if (!Number.isFinite(k) || k < 0) throw new OmniError(`${n} 要一个非负的数，拿到 ${v}`);
    setEnv(name, String(Math.trunc(k)));
  };
  const m = val('--mode');
  if (m === 'view') {
    throw new OmniError('--mode view 要一格窗口，而这条腿上还没有本机 OpenGL 设备'
      + '（任务 #24，docs/design/eval-realtime-gpu.md 第 2.2 节）——'
      + ' 现在能实时看的是 `omni serve` 那一页（浏览器 WebGL2 直通 GPU）；'
      + ' 离屏出图用默认的 `--mode render`');
  }
  if (m === 'render') setEnv('OMNI_GFX_MODE', 'render');
  num('--frame', 'OMNI_GFX_FRAME');
  num('--w', 'OMNI_GFX_W');
  num('--h', 'OMNI_GFX_H');
  const o = val('-o');
  if (o !== undefined) setEnv('OMNI_GFX_OUT', o);
  if (rest.includes('--perf')) setEnv('OMNI_GFX_PERF', '1');
  /* `--gfx 哪一档设备`：`host`（设备在宿主，CPU 备选）/ **`gl`（本机 OpenGL，真 GPU ——
     挂不上就自己回落 host）** / `ir`（生成出来的 CPU 光栅器）/ **`null`（只记账不画）**。
     `null` 那一档是量东西用的：一帧的时间里去掉光栅化那一截 = 语言这一半的开销
     （与 c_impl 的 `bench` 同一个口径），而且它**认所有名字**，所以一份脚本能一路跑到底、
     账上那串名字就是"它要哪几格 API"。`gl` 只有原生腿有意思（js 腿不 dlopen 插件）。 */
  const g = val('--gfx');
  if (g !== undefined) {
    if (!['host', 'gl', 'ir', 'null'].includes(g)) {
      throw new OmniError(`--gfx 只有 host|gl|ir|null 四档，拿到 ${g}`);
    }
    setEnv('OMNI_GFX', g);
    /* `gl` 那一档要两份东西摆好（编不出来就静默回落 CPU 备选）：
         - `OMNI_GL_LIB`    原生腿 dlopen 的那份 dylib（§13.8）；
         - `OMNI_EV_GL_ADDON` js 腿 / 解释器腿 `process.dlopen` 的那份 .node（§16）。
       **两条腿共用同一份设备代码**，只是进门的方式不同。 */
    if (g === 'gl') {
      const cur = env('OMNI_GL_LIB');
      if (cur === undefined || cur === null || cur === '') {
        const lib = glPlugin();
        if (lib !== null) setEnv('OMNI_GL_LIB', lib);
      }
      const curA = env('OMNI_EV_GL_ADDON');
      if (curA === undefined || curA === null || curA === '') {
        const addon = evGlAddon();
        if (addon !== null) setEnv('OMNI_EV_GL_ADDON', addon);
      }
    }
  }
  /* **这几格旗子是"设备在宿主那一侧"那条路的**（帧循环、画布尺寸、输入、性能账都在设备里）。
     给了其中任何一格就把那条路打开（`OMNI_GFX=host`）—— 不打开的话旗子会静默没效果：
     默认那条路是**生成出来的 CPU 光栅器**（`ext/polydraw/gfx-rt.js`），它只画一帧、
     尺寸在脚本里。已经明说 `OMNI_GFX=` 的照旧听用户的。
     GL 立即模式那一族在宿主的 CPU 备选上没有（只有 GPU 那两档设备有）——
     那时设备会自己报出"这格设备上没有 glbegin"，见 docs/design/eval-realtime-gpu.md。 */
  const touched = m === 'render' || rest.includes('--perf')
    || ['--frame', '--w', '--h'].some((f) => rest.includes(f));
  const cur = env('OMNI_GFX');
  if (touched && (cur === undefined || cur === null || cur === '')) setEnv('OMNI_GFX', 'host');
}

function armDevDeadline(verb, rest) {
  /* 发布那一档没有时限（生成出来的程序里那一格也由 `--release` 关掉）。 */
  if (rest.includes('--release') || env('OMNI_RELEASE') === '1') return;
  /* 常驻/交互那几个动词也没有 —— 见 `LONG_VERBS`。 */
  if (LONG_VERBS.has(verb)) return;
  const running = RUNNING_VERBS.has(verb);
  const i = rest.indexOf('--timeout');
  const raw = i >= 0 ? rest[i + 1] : null;
  let sec = running
    ? timeoutBudgetS('OMNI_TIMEOUT', RUN_TIMEOUT_DEFAULT_S)
    : timeoutBudgetS('OMNI_BUILD_TIMEOUT', BUILD_TIMEOUT_DEFAULT_S);
  if (raw !== null && raw !== undefined) {
    /* `30s` 也收：写时限的人十个有九个会带那个单位。 */
    const t = raw.endsWith('s') ? raw.slice(0, -1) : raw;
    sec = Number(t);
    if (t === '' || !(sec >= 0) || sec === Infinity) {
      throw new OmniError(`${verb}: --timeout 要一个秒数（0 = 不限），拿到的是 '${raw}'`);
    }
  }
  if (sec === 0) return;
  const knob = running ? 'OMNI_TIMEOUT' : 'OMNI_BUILD_TIMEOUT';
  RUN_TIMEOUT_MSG = `omni: 超时 —— 这一趟 ${verb} 过了 ${sec}s（--timeout / ${knob} / .env），已中止\n`;
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
  /* 内层是**另一条命令**（`c link` / `c obj`），它算出来的这两格与外层无关 ——
   * 不存不还原就会把外层的判断改掉（那一格已经害过产物缓存一次）。 */
  const savedPerMod = PER_MODULE_C;
  const savedPruneOff = PRUNE_OFF;
  /* 内层抛出去的时候这个计数就不还原了 —— 那一趟整个是要失败退出的，
   * 而 `main` 没有 try/finally（这一层不为「反正要退出」的路径加结构）。 */
  const rc = main(argv);
  PER_MODULE_C = savedPerMod;
  PRUNE_OFF = savedPruneOff;
  MAIN_NEST--;
  return rc;
}

function main(argv) {
  /**
   * **一趟一格**：`SRC_SX` 是"借来语言那条路译出来的核心方言"，它是**这一趟**的东西。
   *
   * 不清的话，常驻工人（`omni serve` 的热工人池）里上一趟 `.go` 留下的那份 sx 会被
   * 下一趟 `.omni` 捡走 —— `compileFront` 见到它就不读文件了（`compileProgram(path, SRC_SX, …)`）。
   * 量出来的症状：先跑 `tests/go/cases/01-loop-call.go`，再跑一份 `.omni`，报的是
   * `ext/omni/examples/scicomp.omni:2:7: error: expected '(', found 'sum'` ——
   * **那行 `sum` 是上一趟那份 go 的**。工人那边的"一次只做一件事"防的是并发串味，
   * 防不了这一种（顺着来的脏），所以在入口处清。
   */
  SRC_SX = undefined;
  SRC_SX_FROM = undefined;
  /**
   * **`--client` 摆在最前面**（`docs/design/omni-serve-studio.md` §3）：
   * `omni --client run x.go` 把**同一条命令**发给 `omni serve` 去跑，回来的
   * stdout / stderr / 退出码原样落地。默认的 omni 仍旧是 CLI —— 这一格是 opt-in。
   *
   * 要在 `findCmd` 之前剥：命令树按"第一个词是不是动词"走，前缀里的开关会被拦在门口
   * （与上面 `--profile` 那一格同一条理由）。
   *
   * 服务地址：`--server URL` > `OMNI_SERVER` > `http://127.0.0.1:7111`。
   *
   * 走**另一个进程**（`src/client.js`），理由与 `serve` 那一格相同：`fetch` + `await`
   * 那一族不该进 `check:self` 的静态模块图。
   */
  {
    const ci = argv.indexOf('--client');
    if (ci >= 0) {
      const rest = [...argv.slice(0, ci), ...argv.slice(ci + 1)];
      const si = rest.indexOf('--server');
      const server = si >= 0 ? rest[si + 1] : (env('OMNI_SERVER') ?? 'http://127.0.0.1:7111');
      const args = si >= 0 ? [...rest.slice(0, si), ...rest.slice(si + 2)] : rest;
      const entry = join(installDir(), 'client.js');
      const [st] = spawn('node',
        [exists(entry) ? entry : join(cwd(), 'src', 'client.js'), server, ...args], 'i');
      return st;
    }
  }
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
    /* `--cc CC`：生成的 C 交给谁（`self` = 我们自己那台）。比 `OMNI_CC` 优先。
     *
     * **要在 `--libc` 之前解析**：下面那一格「win32 上缺省 `self`」的判据要看这一趟到底
     * 交给谁编 —— 交给 msvc/clang 的话缺省就不是我们那份 libc 了。 */
    const ci = rest.indexOf('--cc');
    CC = ci < 0 ? null : rest[ci + 1];
    const bi = rest.indexOf('--libc');
    /* **win32 宿主上缺省是 `self`（只对我们自己那台 cc）**：那儿我们既没有 `msvcrt` 的导入库、
     * 也没有 `x86_64-win32-libtcc1.a`（编译器支持例程那一份），于是不给 `--libc` 的一趟停在
     *   pe: 找不到 x86_64-win32-libtcc1.a
     * 自带那份 libc 反过来什么都不缺：平台层直接调 kernel32 的导入函数，libtcc1 里那些
     * 支持例程我们自己的后端本来就自己发。于是「本机 Windows」与「交叉到 Windows」
     * 走的是同一条路 —— 那两条以前不对称，只因为交叉那条命令行上一直写着 `--libc self`。
     *
     * **`--cc msvc|clang|clang-cl` 那几趟不在此列**：那几台自己带着 CRT 与一整套头，缺省就该
     * 用它们自己的（`--cc msvc` 编出来的东西跟别处 `cl` 编出来的一样，这是拿它的人预期的样子）。
     * 要走我们那份就明写 `--libc self`。明写 `--libc msvcrt` 仍然按写的来。 */
    LIBC = bi < 0 ? null : rest[bi + 1];
    const si = rest.indexOf('--sysroot');
    /* `run-c` / `run-llvm` / `run-jit` 是 `run --backend X` 的老拼法（cmds.js 那张表，
     * 各自一格 key）。漏了它们的样子是「测试套件那条 run-c 腿一声不响地还走老路」——
     * 这句话 cli.js 里另一处（`perModuleC` 那个判据）已经写过一遍，这儿是同一个坑。
     * 量到的：tests/run.js 的 c 腿报 `pe: 找不到 x86_64-win32-libtcc1.a`。 */
    const infer = node.key === 'build' || node.key === 'run' || node.key === 'run-c'
      || node.key === 'run-llvm' || node.key === 'run-jit' || node.key === 'plugins';
    if (si >= 0) {
      CROSS = { ...cTgt(rest), sysroot: rest[si + 1] };
    } else if (infer) {
      const tgt = cTgt(rest);
      const cross = tgt.arch !== hostArch() || tgt.os !== hostOs();
      /* **win32 宿主上缺省是 `self`，但只对我们自己那台 cc**（那儿没有 msvcrt 的导入库、
       * 也没有 libtcc1.a）—— 而且只在**会推 sysroot 的这几条命令**上给：`omni c obj|link`
       * 那一层不推，给了就成了「要 self 却没有 sysroot」，报 `--libc self 要配 --sysroot`。
       * （那正是我上一版改出来的回归：tests/run.js 的每条腿都走那一层。）
       *
       * **外部 cc（msvc / clang / clang-cl）缺省不用我们那份 libc**：它们各自带着 CRT 与
       * 一整套头，那是它们平常的样子，也是别人拿 `--cc msvc` 时预期的样子。要走我们那份
       * 就明说 `--libc self`（于是 `-nostdlibinc` / `/NODEFAULTLIB` 那一套才上场）。 */
      if (LIBC === null && hostOs() === 'win32' && !extWinCc()) LIBC = 'self';
      CROSS = (cross || LIBC === 'self') ? { ...tgt, sysroot: bundledSysroot(tgt) } : null;
    } else {
      CROSS = null;
    }
    /* `--cc` 已经在上面（`--libc` 之前）解析过了。 */
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
      /* 这一趟是哪个动词：`build` 只编译、谁都不跑 —— 收尾那一句要按它分开说
         （见 profFoldedFinish 里那一格）。 */
      PROF.key = node.key;
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
  if (!nested) {
    /* 第一行之前那一截（宿主启动 + 装编译器）**也要印出来**：不印它，`-v` 里那些
       步骤加起来永远比外面 `time` 的 `real` 小一截，而那一截其实是固定成本。 */
    vBoot();
    vMark = nowMs();
  }
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
  /* **每个动词都有时限**（见 armDevDeadline）。摆在这儿而不是各条腿里：`--backend` 会
   * 把 `run` 换成另一条 case（`run-c`/`interp`/`c-run`…），而判据是**用户敲的那个动词**
   * （`node.key`）—— 一条腿都不能漏，漏掉的那条就是「挂在终端上，十几分钟一个字节的
   * 信息都没有」。跑一个程序默认 30s、编译这一趟默认 300s，两个预算分开算。 */
  armDevDeadline(node.key, rest);
  /* EVAL 两门语言那几格图形旗子（`--mode`/`--frame`/`--w`/`--h`/`-o`/`--perf`）落成设备
     读的环境变量。摆在这儿的理由与上面那句一样：`--backend` 会把 `run` 换成另一条 case，
     而这几格旗子对三条腿都管用（C 那条是子进程，环境变量跟着过去）。 */
  applyGfxFlags(node.key, path, rest);
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
   */
  if (path !== undefined && path !== null
      && ['run', 'build', 'emit', 'check'].includes(node.key)
      && lang(path) === null && borrowedExts().some((e) => path.endsWith(e))) {
    const sx = coreSxText(path, rest);
    if (sx === null) return 1;
    /* 核心方言那份文本**留在内存里**（`SRC_SX`），不落盘。
     *
     * 它是这条路的**中间格式**，不是产物：落盘一份的话就多出一摊 `src-sx/<内容哈希>/`
     * 目录、一格谁也不清的缓存，而下游（compileProgram）本来就收得下文本。
     * `--emit-sx` 那一档才写出来（调试通道）。
     *
     * 名字还是按原来的主干编（`pt.go` -> `pt.sx`）：`build` 不给 `-o` 时默认名还是 `pt`，
     * 诊断里的路径也还看得出是谁。这个路径**不存在**，只当名字用。 */
    const sxPath = join(cacheRoot(), 'src-sx', `${basename(path, path.slice(path.lastIndexOf('.')))}.sx`);
    const ei = rest.indexOf('--emit-sx');
    if (ei >= 0) {
      const to = rest[ei + 1] !== undefined && !rest[ei + 1].startsWith('-') ? rest[ei + 1] : sxPath;
      mkdirAll(dirname(to));
      writeText(to, sx);
      stderr(`omni: 核心方言 -> ${to}（${sx.length} 字节）\n`);
    }
    if (VERBOSE) stderr(`omni: ${path} -> 核心方言（内存里，${sx.length} 字节）\n`);
    SRC_SX = sx;
    /* **原来那份源码的路径留一格**：`path` 与 `files[0]` 下一行就被换成那个虚拟的
       `.sx` 了，而诊断里要指的是用户敲的那份（`emit ast` 那一格照它印命令）。 */
    SRC_SX_FROM = path;
    path = sxPath;
    files[0] = sxPath;
  }
  /**
   * **`--engine` 只剩一台**（ADR-0044）：`omni`（前端 → OIR → 后端）。
   * 节点图那台机器（`--engine graph`）随着十一门语言全迁到公共降级器一起拆掉了 ——
   * 借来的语言现在与 `.c` 一样按后缀选前端，不用给 `--engine`。
   */
  if ((node.key === 'run' || node.key === 'build') && rest.includes('--engine')) {
    const ei = rest.indexOf('--engine');
    const eng = ei + 1 < rest.length ? rest[ei + 1] : null;
    if (eng !== null && eng !== 'omni') {
      throw new OmniError(`没有 --engine ${eng} 这一条 —— 现在只有一台：omni（默认，前端 -> OIR -> 后端）。`
        + '借来的语言按后缀选前端，不用给 --engine（ADR-0044）');
    }
  }
  /* `run --stat` 在 js 那条腿上现在**有账可报**（时间 + 各层的账，见 `statReport`）；
   * 别的腿（llvm / jit / interp）还没接上那张表 —— 一声不响是最坏的，所以说一句。 */
  if (node.key === 'run' && STAT !== null && rest.indexOf('--backend') >= 0) {
    stderr('omni: run --stat：这一趟的后端还没接上那张表 —— js 腿（默认）有，'
      + '`build --stat` 上是全的\n');
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
        if (cmd !== 'elf-link' && cmd !== 'macho-link' && cmd !== 'pe-link') {
          throw new OmniError('--libc self 现在有 ELF（linux）、Mach-O（osx）与 PE（win32）三条腿');
        }
        if (sysroot === null) throw new OmniError('--libc self 要配 --sysroot');
        const selfOs = cmd === 'macho-link' ? 'osx' : (cmd === 'pe-link' ? 'win32' : 'linux');
        const selfFmt = cmd === 'macho-link' ? 'macho' : (cmd === 'pe-link' ? 'pe' : 'elf');
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
          /* 键里还得有 `srcStamp()`：改了前端/后端/sysroot 之后，源文件的 mtime 没动，
           * 缓存就把上一版编的 `.o` 又端上来 —— x64 那一版「过了」的 run 就是这么来的
           * （`cc 800ms`、字节数一模一样）。编译器自己的指纹进 key，才不会跑错程序。 */
          const o = join(workDirFor('libc-self',
            hash16(`${selfFmt}|${selfArch}|${selfOs}|${srcStamp()}|${src}`)), base + '.o');
          cObj(src, o, selfArch, incs, [], 'elf',
            selfOs, [cap('c.sysInclude')()[0], ...incs]);
          if (base === 'start') objs.unshift(o); else objs.push(o);
        }
        files.unshift(...objs.filter((o) => o.endsWith('start.o')));
        files.push(...objs.filter((o) => !o.endsWith('start.o')));
        /* 入口的**符号名**三条腿不一样：Mach-O 的 C 符号带一条前导下划线，所以
         * C 里的 `_start` 在那边是 `__start`（ELF 与 PE 上就是 `_start`）。
         * `macho_exe` 的默认入口是 `_main`（见它的文件头），不改就找不着。
         *
         * **共享库走的是另一个入口**（`--shared`，插件那一路）：PE 上是 `__dllstart`
         * （`pe_load.js` 的 `peStart` 就找这个名字，实现在 win32 sysroot 的 `start.c`）。
         * 给成 `_start` 的话，DLL 一被 `dlopen` 就去跑 `main` —— 那是另一个程序。 */
        const selfShared = rest.includes('--shared');
        if (!rest.includes('-e')) {
          if (selfFmt === 'pe' && selfShared) rest.push('-e', '__dllstart');
          else rest.push('-e', selfFmt === 'macho' ? '__start' : '_start');
        }
        /* PE 上还要指出「库到哪儿找」与「哪个目标」：kernel32 的 `.def` 在 sysroot 的
         * `lib/` 下，而 `pe-link` 的 `--target` 默认是 x86_64-win32。msvcrt 与 libtcc1
         * 不接那一格由 `pe_load` 的 `selfLibc` 管（它认命令行上的 `--libc self`）。 */
        if (selfFmt === 'pe') {
          rest.push('-L', join(sysroot, 'lib'));
          if (!rest.includes('--target')) rest.push('--target', `${selfArch}-win32`);
        }
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
  /**
   * `omni serve` —— 常驻服务 + Omni Studio（`docs/design/omni-serve-studio.md`）。
   *
   * **另起一个进程**（`src/serve.js`），理由写在那份文件的头注里：serve 用到
   * `node:http` / `async` 那一族，而 `check:self` 会把静态 import 到的每一份都编一遍；
   * 动态 `import()` 我们自己那台 JS 前端还不认。serve 本来就是一个独立的常驻程序。
   *
   * stdio 全直通（`'i'`）：日志直接落到终端，Ctrl-C 直接到那个进程。
   */
  if (cmd === 'serve') {
    /* `installDir()` 是"运行中的程序镜像所在目录" —— 也就是 `src/`（`src/cli.js` 的目录）。
       装出去的那一档（`dist/omni`）旁边没有 `serve.js`，那时回退到 `cwd()/src`。 */
    const entry = join(installDir(), 'serve.js');
    const [st] = spawn('node', [exists(entry) ? entry : join(cwd(), 'src', 'serve.js'), ...rest], 'i');
    return st;
  }
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
  /**
   * `omni jit-selftest`（ADR-0045 的 D1）：**把字节变成能跑的代码**这一格的最小判据。
   *
   * 发两条指令（`mov w0,#42` / `ret`）、`protect(rx)`、跳进去，要回 42。
   * 这一格是自己那台 JIT 的地基 —— 它不成立，后面发多少字节都白搭。
   * 走的是已有的注入宿主（`omni_ffi_host.node`，ADR-0038）：`mem` 要一块页对齐的内存、
   * `protect` 做 mprotect（**arm64 上顺手刷 icache**，少了它的症状是"有时候跑到旧字节上"）、
   * `calli` 把那个地址当 `int64_t (*)(void)` 叫一次。
   *
   * 摆在"要不要源文件"那道门**之前**：它不吃任何文件。
   */
  if (cmd === 'jit-selftest') {
    const fh = ffiHost();
    const pg = fh.page();
    const arch = hostArch();
    /* **手写机器码**，不过编译器 —— 这一格判的就是"我们自己算出来的字节对不对"。
     * arm64：`MOVZ W0,#42` = 0x52800000 | (42<<5) = 0x52800540；`RET` = 0xD65F03C0（小端）。
     * x86-64：`mov eax,42` = B8 2A 00 00 00；`ret` = C3。 */
    const code = arch === 'arm64'
      ? [0x40, 0x05, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6]
      : [0xb8, 0x2a, 0x00, 0x00, 0x00, 0xc3];
    const m = fh.mem(pg);
    const u8 = new Uint8Array(m.buf);
    for (let i = 0; i < code.length; i++) u8[i] = code[i];
    fh.protect(m.addr, pg, 0);            // 0 = rx
    const got = fh.calli(m.addr);
    const ok = Number(got) === 42;
    stdout(`jit selftest ${arch}: ${code.length} 字节 -> ${got} ${ok ? '（对）' : '（要 42）'}\n`);
    return ok ? 0 : 1;
  }
  if (!path) throw new OmniError(`command '${cmd}' needs a source file`);
  /* 借来语言那条路的入口是**内存里那份核心方言**（`SRC_SX`），路径只当名字用 —— 那一格
   * 本来就不存在，所以这一问跳过它。 */
  if (SRC_SX === undefined && !exists(path)) throw new OmniError(`no such file: ${path}`);

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
  /* 这一趟按模块编译吗（要不要摇树，见 PRUNE_OFF）。摆在 switch **之前**：
   * `--backend c` 会把 `run` 换成 `run-c` 那条 case，摆在 case 里就看不见了 ——
   * 量出来是"设了 PRUNE_OFF 却照旧 `prune 1195 -> 264`"。
   * 解释器那两档（`--interp` / `--mir`）照旧摇：它们不出 `.o`，摇了只是跑得快些。 */
  /* asy 的 C 腿**默认**走每模块独立那条路（§12 末节）：`run`（要 C 那条腿时）与 `build`
   * 两个动词都吃。两个逃生口：
   *   - `--one-file` / `OMNI_C_ONEFILE=1` —— 单体那条**对照腿**（见 perModuleWanted）
   *   - `OMNI_ASY_CMODS=0` —— 退回"一棵合并的树切开"那条路（`buildSelfModules`）
   * 判据：tests/asy/cases 下 180 份有期望值的例子走这条路**全过**（154s，每份 0.85s）。 */
  if (asyCModsWanted(node.key, path, rest)) {
    if (node.key === 'build') {
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : `${progName(path)}.out`;
      const exe = asyCModsBuild(path, out);
      stderr(`omni: built ${exe} ${fmtBytes(fileSize(exe))}  按模块（每模块独立）\n`);
      return 0;
    }
    const exe = asyCModsBuild(path);
    const st = spawn(exe, [], 'i')[0];
    vStep(`exec ${exe}  exit=${st}`);
    return st;
  }
  PER_MODULE_C = (node.key === 'run' || node.key === 'build')
    && !rest.includes('--interp') && !rest.includes('--mir')
    && perModuleWanted(rest, path);
  /* 按模块就不摇树（摇树看整程序的可达集，与"模块各自独立"冲突）—— 同一格状态两个用处，
     分成两处判就会出现"摇过的树喂给按模块的出口"。 */
  PRUNE_OFF = PER_MODULE_C;
  /* 产物缓存（链好的可执行文件）：**输入一个字节没变就只剩 exec**。
   *
   * 门开在 switch **之前**：`--backend c` 会把 `run` 换成 `run-c` 那条 case，而"用户说的
   * 是把它跑起来"这件事只有 `node.key` 知道。从前这格条件里有 `!hasJsEngine()`
   * （只有自举出来的二进制上才查）—— 于是 node 上 `run --backend c` 每趟把整条前端 +
   * 发射 + 链接重做一遍：量出来暖态 1.5s 里 asy_builtins 的词法 125ms、settings 141ms、
   * 前端 234ms、发 C 202ms、链 394ms，而输入没变。宿主是谁与"输入变没变"没有关系。
   *
   * 只对 `.asy` 开：依赖清单来自 `cap('asy.deps')()`，别的语言那一格还没有 —— 拿上一趟
   * asy 的清单当自己的会让"改了源码却沿用旧二进制"，那是答案静默地错。 */
  if (node.key === 'run' && path !== undefined && path.endsWith('.asy')
    && !rest.includes('--interp') && !rest.includes('--mir') && !rest.includes('--work')) {
    const bi2 = rest.indexOf('--backend');
    const toC = !hasJsEngine() || (bi2 >= 0 && rest[bi2 + 1] === 'c');
    if (toC) {
      const exe = exeCacheGet(path, exeCC(), PER_MODULE_C ? 'mod' : 'one');
      if (exe !== null) {
        vStep(`run exe cache  ${fileSize(exe)} bytes  ${exe}`);
        const st = spawn(exe, [], 'i')[0];
        vStep(`exec ${exe}  exit=${st}`);
        return st;
      }
    }
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
        const dir = jsModulesDir();
        // 先问一句"上一趟的清单还成立吗"。成立就一步前端都不走 —— 判断本身只是几十个 stat。
        const hit = asyModsFast(path, dir);
        const mainPath = hit === null ? asyModsBuild(path, dir) : hit;
        /* **在本进程里跑、库那几份只装一次**（这一刀）：一份产物一段 `eval`，按启动器里的
         * 次序装过去；库那几份留在进程里，运行时与入口每趟重来。不再 spawn。
         *
         * 量出来的账（01-arith，产物全命中）：`node` 子进程 227ms 里有 110ms 是**光起一个
         * node**（这台机器上 `node -e 0` 就要 110ms）、35ms 是 V8 编那份 1.97MB 的库、
         * 78ms 是第一趟 `init()` 里的惰性编译 —— 而**第二趟 `init()` 只要 0.3ms**：库的
         * 真活儿就这么点，剩下全是编译。一段短程序每趟重新塞一遍那 2.4MB 是纯浪费。
         *
         * 产物一格没变：每份模块照旧各自降级、各自缓存；派生品也与产物一一对应
         * （`<名字>.load.js`）—— **不许**再有"按程序拼出来的一大段"。
         * `OMNI_ASY_LINK=0` 回到 spawn 那条（**对照腿**：答案不一致时第一个要比的就是它）。 */
        if (env('OMNI_ASY_LINK') !== '0') return asyRunModules(dir, mainPath);
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
      /* `--modules`：按**模块**发射 —— 一个模块一份 `.c` + 一份同名 `.h`，跟正常的
       * C 工程一样。**没有公用头**：头的 include 图严格等于模块的依赖图，改一个类型只让
       * `#include` 到它的那几家重编（docs/design/build-system.md §12 末节的定案）。
       * 与用户类型无关的那一族生成物（字面量池、`list<int>`、JS 模板）落在 `omni_gen.{h,c}`。 */
      /* `--module-files`：把这一份当**一个自足的模块**发（跨文件模块化那条路的发射单位）。
       * 调试与判据用 —— `.h` 里只有接口、`.c` 里是实现，两份一起编就该与单体同一个答案。 */
      if (rest.includes('--module-files')) {
        const wj = rest.indexOf('--work');
        if (wj < 0) throw new OmniError('emit c --module-files 要 --work DIR');
        const d2 = rest[wj + 1];
        mkdirAll(d2);
        const nm2 = progName(path);
        const mf = cap('cgen.module')(mod, nm2);
        writeText(join(d2, `${nm2}.h`), mf.h);
        writeText(join(d2, `${nm2}.c`), mf.c);
        stderr(`omni: 一份自足模块  ${nm2}.h ${fmtBytes(mf.h.length)} + ${nm2}.c ${fmtBytes(mf.c.length)} -> ${d2}\n`);
        return 0;
      }
      const si = rest.findIndex((a) => a === '--modules' || a.startsWith('--modules='));
      if (si >= 0) {
        const wi = rest.indexOf('--work');
        if (wi < 0) throw new OmniError('emit c --modules 要 --work DIR：每个模块的 .c 得有个落点');
        const dir = rest[wi + 1];
        mkdirAll(dir);
        const u = cap('cgen.units')(mod);
        writeText(join(dir, `${u.gen.name}.h`), u.gen.h);
        writeText(join(dir, `${u.gen.name}.c`), u.gen.c);
        let tot = 0;
        for (const t of u.units) {
          writeText(join(dir, `${t.name}.h`), t.h);
          writeText(join(dir, `${t.name}.c`), t.c);
          tot += t.c.length + t.h.length;
        }
        const ord = [...u.units].sort((a, b) => b.bytes - a.bytes);
        stderr(`omni: ${u.units.length} 份模块，合计 ${fmtBytes(tot)}`
          + `，${u.gen.name} ${fmtBytes(u.gen.h.length + u.gen.c.length)}\n`);
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
      /* 名字过一道 `exeName`：Windows 上没后缀的文件启动不了，所以 `-o dist/omni`
       * 在那条腿上落成 `dist/omni.exe`（`npm run build:native` 一个字不用改）。 */
      const out = exeName(oi >= 0 ? rest[oi + 1]
        : basename(path).replace(/\.(omni|omnis|omnid|js)$/, ''));
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
      /* 吃不吃产物缓存看**用户敲的是哪个动词**：`omni run x.asy --backend c` 是
       * "把它跑起来"（吃），`omni run-c x.asy` 是测试轴明说要走这条腿（不吃）。
       * 两者在这儿是同一条 case —— `--backend c` 把 `run` 改写成了 `run-c`。 */
      return runViaC(mod, rest, path, node.key === 'run' && path.endsWith('.asy'));
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
      /* **借来的那十门没有 AST 这一层**（它们走图：源码 -> 语法树 -> 图 -> 核心方言），
       * 而 `path` 此刻已经是那格虚拟的 `.sx`，`compile` 对它回的 `ast` 是 null。
       * 从前这儿就印一行 `null` —— 那是"看着像跑过了、其实什么也没说"的最坏一种。
       * 照实说这一门的下一站是哪儿，并给出能直接敲的那条命令。 */
      if (SRC_SX !== undefined) {
        const from = SRC_SX_FROM ?? files[0];
        stderr('omni: 这一门走图那一层（源码 -> 语法树 -> 图 -> 核心方言），没有 AST 这一格。\n'
          + `omni: 要看语法树：omni glr <语法文件> ${from}\n`
          + `omni: 要看核心方言：omni emit sx ${from}\n`);
        return 1;
      }
      const { ast } = compile(path, rest);
      stdout(JSON.stringify(ast, replacer, 2) + '\n');
      return 0;
    }
    // asy / jancy -> 核心方言 那一步的**文本**。核心方言的诊断报的是 `<文件>.asy.sx:L:C`，
    // 而那份 .sx 是虚拟的（从不落盘），所以没有这一条就只能拿着行号猜。印出来的
    // 内容与 lowerCoreSexpr 拿到的**逐字节相同** —— 行号可以直接对。
    case 'sx': {
      /* **借来的那十门先看 `SRC_SX`**：它们走图那一层（`coreSxText`），核心方言那份文本
       * 上面那一片已经算出来搁在内存里了，而 `path` 已经被换成一格**不存在**的
       * `src-sx/<名>.sx`（只当名字用，见那一片的头注）。
       * 从前这儿直接落到 `asy.toSx`，于是 `emit sx x.go` 拿着那个虚路径去 `readText`，
       * 报的是一串 node 的 ENOENT 栈 —— 而这条路上核心方言明明已经在手里了。 */
      if (SRC_SX !== undefined) { stdout(SRC_SX); return 0; }
      stdout(path.endsWith('.jnc') ? cap('jnc.toSx')(path, incDirs(rest), false) : cap('asy.toSx')(path));
      return 0;
    }
    // C 的预处理（ADR-0017 第五刀）。**格式与 `tcc -E` 逐字节相同** —— 那是它的
    // 测试轴（`tests/c/`）：同一份 `.c` 交给我们和 tcc，两份输出必须一样。
    // `-I <目录>` 与 `.jnc` 那一路共用同一个收集器；`-D 名字[=宏体]` 与 tcc 同形。
    /**
     * `omni c split`（ADR-0046）：**按声明切分 C 源码，且能逐字节复原**。
     *
     *   omni c split --scan FILE.c                 印清单（种类 名字 行号 字节数）
     *   omni c split --map FILE.split FILE.c -o DIR   照描述文件切 + 写 manifest
     *   omni c split --check FILE.split FILE.c -o DIR  只验：拉链回原文，逐字节比
     *
     * 三件事都**不改原文一个字节** —— 只有 slice / concat。描述文件是**人写的规划**
     * （哪个函数进哪个文件），`--map` 见到没指派的格子就报错退出，不给默认落点。
     */
    case 'c-split': {
      const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
      const src0 = rest.find((a) => !a.startsWith('-') && /\.c$/.test(a)
        && a !== val('--map') && a !== val('--check'));
      if (src0 === undefined) { stderr('omni c split: 要一份 FILE.c\n'); return 64; }
      /* **必须按字节读写**（`readBinary`/`writeBinary` 是 latin1，一字节一码位）。
         用 `readText`（utf8）会把非 ASCII 的字节转码 —— `eval.c` 上量到 238471 读成
         238465（少 6 个字节），"逐字节复原"那句话当场就不成立了。 */
      const src = readBinary(src0);
      const chunks = cSplitScan(src);
      if (rest.includes('--scan')) { stdout(cSplitFormat(src, chunks)); return 0; }
      const mapPath = val('--map') ?? val('--check');
      if (mapPath === undefined) { stderr('omni c split: 要 --scan 或 --map/--check 描述文件\n'); return 64; }
      const plan = cSplitReadPlan(readBinary(mapPath));
      const r = cSplitApply(src, chunks, plan);
      if (r.missing.length > 0) {
        stderr(`omni c split: ${r.missing.length} 格没指派（描述文件不许有默认落点）——\n`);
        for (const c of r.missing.slice(0, 10)) stderr(`  ${c.kind}\t${c.name}\t${c.line}\n`);
        return 65;
      }
      const chk = cSplitCheck(src, r.manifest, r.files);
      if (!chk.ok) {
        stderr(`omni c split: 复原不等于原文（${chk.got} vs ${chk.want} 字节）—— 不落盘\n`);
        return 70;
      }
      /* **同一份文件的格子必须连着**（理由见 split.js 的 `contiguity`）：不连续的话
         缝合文件那句"一份 include 一次"就等于悄悄重排声明次序。`--loose` 放行。 */
      const bad = cSplitContig(r.manifest);
      if (bad.size > 0 && !rest.includes('--loose')) {
        stderr('omni c split: 这几份不是一段连续区间（缝合会重排声明次序；放行加 --loose）——\n');
        for (const [f, n] of bad) stderr(`  ${f}\t${n} 段\n`);
        return 66;
      }
      /* **每份产物的 `#if` 要自己配平**：`#include` 的边界不能劈开一个条件段
         （理由与那四对踩过的文件见 split.js 的 `ppBalance`）。`--loose` 一并放行。 */
      const unbal = cSplitPpBalance(r.files);
      if (unbal.size > 0 && !rest.includes('--loose')) {
        stderr('omni c split: 这几份的条件编译没配平（切点劈开了 #if…#endif，编不过；放行加 --loose）——\n');
        for (const [f, d] of unbal) stderr(`  ${f}\t净深度 ${d > 0 ? `+${d}` : d}\n`);
        return 67;
      }
      const dir = val('-o');
      if (rest.includes('--check') || dir === undefined) {
        stderr(`omni c split: ${chunks.length} 格 -> ${r.files.size} 份；复原逐字节相同（${chk.want} 字节）\n`);
        return 0;
      }
      for (const [f, body] of r.files) {
        const p = join(dir, f);
        mkdirAll(dirname(p));
        writeBinary(p, body);
      }
      writeText(join(dir, `${basename(src0, '.c')}.manifest.json`),
        `${JSON.stringify({ source: basename(src0), len: src.length, pieces: r.manifest })}\n`);
      /* 缝合文件：`build.cmd` 照旧编这一份（unity build，原文一个字节没改）。 */
      writeText(join(dir, `${basename(src0, '.c')}.stitch.c`),
        cSplitStitch(basename(src0), r.manifest));
      stderr(`omni c split: ${chunks.length} 格 -> ${r.files.size} 份，写进 ${dir}`
        + `（复原逐字节相同，${chk.want} 字节）\n`);
      return 0;
    }
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
        /* `--libc self`：自己那份 libc 已经在 `.o` 里，于是不接 msvcrt、不接 libtcc1，
         * 只留 kernel32（见 `pe_load.js` 的 `selfLibc`）。 */
        selfLibc: valOf('--libc') === 'self',
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
      /* 链接图（`--map`）：崩溃那一句印的 `pc`/`base` 要靠它翻函数名（`pe_link` 的
       * `mapSyms`，地址是**链接期的 VA**：`pc - 运行时基址 + 映像基址`）。 */
      writeLinkMap(valOf('--map'), r.mapSyms, `# imagebase 0x${r.img.imagebase.toString(16)}`);
      /* 有导出的符号时 tcc 还顺手写一份 `<输出>.def`（`pe_build_exports` 里那段 `#if 1`）。 */
      if (r.def !== undefined) writeText(r.def.path, r.def.text);
      linkSay(`${out} (${r.bytes.length} 字节，${r.infos.length} 节，${r.nthunks} 个导入桩)\n`);
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
      linkSay(`${out} (${r.bytes.length} 字节，${r.shnum} 节，${r.phnum} 段，`
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
        linkSay(`${out} (${r.bytes.length} 字节，${r.ncmds} 条加载命令，${r.nsects} 节，`
          + `入口偏移 0x${r.entryoff.toString(16)}`
          + `${r.members.length === 0 ? '' : `，拉了 ${r.members.length} 个库成员`})\n`);
      }
      return 0;
    }
    // 一个源文件一份产物（第七十五刀）：`<名字>.sx` 与 `<名字>.js` 摊在一个目录里，

    // 名字就是源文件自己的名字。`-o 目录` 指定去处，默认 .omni-cache/modules/js-<配置>。
    // 加 `--run` 就直接跑（node 自己按 ESM 的模块图把它们串起来）。
    case 'asy-units': {
      const oi = rest.indexOf('-o');
      const dir = oi >= 0 ? rest[oi + 1] : jsModulesDir();
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

/**
 * 跑一趟命令，回**退出码**（不设进程的退出码 —— 那是进程级的事，见下面那一段）。
 *
 * 为什么单开这一格（ADR-0018 分片 3 的欠账，`src/cli.js` 的头注记着）：这一份从前
 * 既是驱动又是入口（文件末尾自己 `main(procArgs())`），于是**不能被 import 而不执行**。
 * 收成一格函数之后，`omni serve` 那侧的**热工人**就能在进程内一趟接一趟地跑
 * （`src/core/studio/worker.js`）—— 省掉每请求 110ms 的 node 启动 + 装编译器。
 *
 * 三件收尾摆在这儿而不是 `main` 的二十来个 return 上：这是所有腿唯一的汇合点，
 * 于是「哪条腿忘了渲染 / 忘了报超时」不可能漏掉一条。
 */
export function runCli(argv) {
  try {
    const st = main(argv);
    /* `--profile-out x.svg` 的第二步（第一百四十七片）：把运行时落下的折叠栈摊成火焰图。
     * 渲染是纯字符串计算（`cli/flame.js`）。 */
    profFoldedFinish();
    profSvgFinish();
    /* 总账最后印（`-v`）：它要把上面所有步骤都算进去。 */
    vTotal();
    return runTimedOut() ? 124 : st;
  } catch (e) {
    if (e instanceof OmniError) {
      stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

/* **当库用的时候不自己跑**（`OMNI_AS_LIB=1`）。
 *
 * 为什么是一格环境变量而不是"我是不是入口"那种判断：后者要 `import.meta`，而这一份
 * 要能被自己编译（`import.meta` 不在那个子集里，量出来是一条硬错）。而且直接
 * `node src/core/cli.js …` 的调用方有八处（tests/glr、tests/wat、tests/cabi、
 * tests/bootstrap 那条自举链…）—— 它们一个字都不用改。 */
if (env('OMNI_AS_LIB') !== '1') {
  setExitCode(runCli(procArgs()));
}
