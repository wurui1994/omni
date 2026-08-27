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
  writeText, readText, exists, readDir, mtimeMs, fileSize, mkdTemp, mkdirAll, rename,
  args as procArgs, env, stdout, stderr, setExitCode, spawn, tmpDir, evalJs, hasJsEngine, nowMs,
  cwd, installDir,
} from './host/native.js';
import { join, basename } from './host/path.js';
import { hash16 } from './host/hash.js';
import { linkJs } from './frontend-js/link.js';
import { lowerJs } from './frontend-js/lower.js';import { lowerWat } from './frontend-wat/lower.js';
import { lowerAsy } from './frontend-asy/lower.js';
import { parseAsyBuiltins } from './frontend-asy/types.js';
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
import { cAbiLibs } from './hir/c_abi.js';
import { emitJs, emitJsFunc } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';
import { emitLlvm } from './backend-llvm/emit.js';
import { emitSpirv } from './backend-spirv/emit.js';
import { RUNTIME_DIR, JIT_DIR, runtimeSources } from './runtime/c_runtime.js';
import { loadProgram, MODE_BY_EXT } from './module/load.js';
import { startRepl } from './repl.js';
import { interpret } from './interp/eval.js';
import { interpretMir } from './mir/interp.js';
import { bootstrapSelf } from './bootstrap.js';

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
  if (path.endsWith('.js')) return compileJs(path);
  if (path.endsWith('.wat')) return compileWat(path);
  if (path.endsWith('.sx')) return compileSexpr(path);
  if (path.endsWith('.asy')) return compileAsy(path);
  return compileProgram(path, undefined, modeFor(path, argv));
}

/**
 * asy 前端的零件：语法表 + 词法 + 内建绑定表。**文件 IO 与表加载都在这里**，
 * 降级器只拿解析好的东西 —— 整份文件的编译（asyText）与 REPL（repl.js 的 AsyLang）
 * 共用这一份，所以"从哪里找模块"这类规则不会有两份实现。
 */
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
  const parseText = (p, text, diags) => {
    const toks = lexText(tb.grammar.lex, new SourceFile(p, text), diags);
    diags.throwIfErrors();
    vStep(`asy lexer      ${p} -> ${toks.length} tokens`);
    const t = glrParse(tb, toks, diags);
    diags.throwIfErrors();
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
  const loader = (diags) => (name) => {
    let p = join(cwd(), `${name}.asy`);
    if (!exists(p)) {
      p = '';
      for (const d of searchDirs) {
        const q = join(d, `${name}.asy`);
        if (exists(q)) { p = q; break; }
      }
    }
    if (p === '' || !exists(p)) return null;
    vStep(`asy module    ${name} -> ${p}`);
    return parseText(p, readText(p), diags);
  };
  return { parseText: parseText, loader: loader, builtins: builtins, libDir: libDir };
}

/**
 * asymptote -> 核心方言 -> OIR（ADR-0014 第 2 道门槛）。
 * 语法那一半是数据（`frontend-asy/asy.grammar`，从 camp.y 照原样转写）；这里只做
 * 类型定向的那一半，出来的仍然是核心方言文本 —— 于是六条腿一条都不知道 asy 存在。
 */
function asyText(path) {
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
  });
  diags.throwIfErrors();
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
function findCC() {
  const explicit = env('OMNI_CC');
  if (explicit) return explicit;
  for (const cc of ['tcc', 'clang', 'gcc', 'cc']) {
    const r = spawn('which', [cc], 'c');
    if (r[0] === 0 && r[1].trim()) return cc;
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
  return cc === 'tcc' ? ['-I', RUNTIME_DIR]
    : [optFlag(), '-std=c99', '-ffp-contract=off', '-w', '-I', RUNTIME_DIR];
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
  const dir = join(tmpDir(), `omni-rt-${key}`);
  const objs = srcs.map((p) => join(dir, `${basename(p, '.c')}.o`));
  if (objs.every((o) => exists(o))) {
    vStep(`runtime .o  ${objs.length} objects, cache hit ${dir}`);
    return objs;
  }

  // 先编进临时目录再整体 rename：中断或并发都不会留下半个缓存
  const stage = mkdTemp(join(tmpDir(), 'omni-rt-stage-'));
  const staged = srcs.map((p) => join(stage, `${basename(p, '.c')}.o`));
  for (let i = 0; i < srcs.length; i++) {
    const r = spawn(cc, [...flags, '-c', '-o', staged[i], srcs[i]], 'c');
    if (r[0] !== 0) {
      throw new OmniError(`omni runtime failed to compile with ${cc}:\n${r[2]}`);
    }
  }
  // 目标已存在 = 别人先建好了，下面那句会用它（rename 到一个非空目录在两个宿主上都是硬错，
  // 而宿主的错误不是可以 catch 的异常，所以先看一眼）
  if (!exists(dir)) rename(stage, dir);
  vStep(`runtime .o  ${srcs.length} objects compiled with ${cc}`);
  return objs.every((o) => exists(o)) ? objs : staged;
}

/**
 * workDir 给的时候，生成的 .c 就留在那里（名字跟着产物走），不进临时目录 ——
 * `omni bootstrap` 与 `build --work DIR` 要的是"中间产物留在构建目录里"：链断在哪一代
 * 都能直接翻出那份 C 来看，而不是去 /var/folders 里捞一个随机名字的目录。
 */
function buildNative(mod, outPath, workDir) {
  const dir = workDir === undefined ? mkdTemp(join(tmpDir(), 'omni-')) : workDir;
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

function runViaC(mod, argv) {  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : mkdTemp(join(tmpDir(), 'omni-run-'));
  if (wi >= 0) mkdirAll(dir);
  const exe = join(dir, 'a.out');
  buildNative(mod, exe, wi >= 0 ? dir : undefined);
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
  const dir = workDir === undefined ? mkdTemp(join(tmpDir(), 'omni-ll-')) : workDir;
  if (workDir !== undefined) mkdirAll(dir);
  const llPath = join(dir, `${basename(outPath)}.ll`);
  writeText(llPath, ir);
  vStep(`backend llvm  ${ir.length} bytes -> ${llPath}`);
  const cc = findClang();
  const args = [optFlag(), '-w', '-ffp-contract=off', '-I', RUNTIME_DIR, llPath,
    ...runtimeObjects(cc), '-o', outPath, '-lm'];
  const r = spawn(cc, args, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`llvm backend produced IR that ${cc} rejected:\n${r[2]}\n(kept at ${llPath})`);
  }
  vStep(`${cc}  ${args.length} args -> ${outPath}  ${fileSize(outPath)} bytes`);
  return { llPath, cc };
}

function runViaLlvm(mod, argv) {
  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : mkdTemp(join(tmpDir(), 'omni-run-ll-'));
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
  const dir = join(tmpDir(), `omni-jit-${key}`);
  const exe = join(dir, 'omni-jit');
  if (exists(exe)) {
    vStep(`jit host  cache hit ${exe}`);
    return exe;
  }
  // 运行时的 .o 直接链进宿主，JIT 出来的代码靠「进程符号搜索」找到它们（见 omni_jit.c）。
  // -Wl,-export_dynamic 是必须的：默认情况下可执行文件的符号不进动态符号表，
  // ORC 就找不到 omni_print_int 这些。
  const stage = mkdTemp(join(tmpDir(), 'omni-jit-stage-'));
  const staged = join(stage, 'omni-jit');
  const args = ['-O2', '-w', '-I', inc[1].trim(), '-I', RUNTIME_DIR, src, ...objs,
    '-L', libdir[1].trim(), '-lLLVM', '-lm', '-Wl,-export_dynamic', '-o', staged];
  const r = spawn(cc, args, 'o');
  if (r[0] !== 0) throw new OmniError(`the jit host failed to build with ${cc}:\n${r[2]}`);
  if (!exists(exe)) rename(stage, dir);
  vStep(`jit host  built with ${cc} + LLVM ${ver[1].trim()} -> ${exists(exe) ? exe : staged}`);
  return exists(exe) ? exe : staged;
}

function runViaJit(mod, argv) {
  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : mkdTemp(join(tmpDir(), 'omni-run-jit-'));
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
  // 带值的开关（-o NAME / --mode M）的值不能被当成源文件
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-o' || a === '--mode' || a === '--work' || a === '--cache') { i++; continue; }
    if (a.startsWith('-')) continue;
    files.push(a);
  }
  const path = files[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    stdout(USAGE);
    return 0;
  }
  // repl 没有源文件；默认模式是 ADR-0008 第 3 节的 dynamic（沿革见 repl.js 文件头）。
  // `--lang` 选前端：驱动是与语言无关的，omni 走检查器的增量会话，sx/asy 走核心方言的。
  // asy 要语法表与内建绑定表，那是文件 IO，所以由这里注入（repl.js 不碰盘）。
  if (cmd === 'repl') {
    const li = rest.indexOf('--lang');
    return startRepl(modeFor('', rest, 'dynamic'), li >= 0 ? rest[li + 1] : 'omni', { asy: asyFrontEnd });
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
      const { mod } = compile(path, rest);
      // 自己的解释器（ADR-0013）。阶段 1 还没覆盖全部 op，所以要显式要它
      if (rest.includes('--interp')) return runInterp(mod);
      // `run` 的意思是"解析完直接执行"，怎么执行是**这一代宿主的事**：node 上是生成 JS
      // 在本进程里 eval；原生构建里没有 JS 引擎，那条路就是 C 路径。所以先问一句能力，
      // 而不是让 js_eval 报错 —— 用户要的是执行，不是一句"换个命令重试"。
      if (hasJsEngine()) {
        const js = emitJs(mod);
        vStep(`backend js  ${js.length} bytes`);
        evalJs(js);
        vStep('exec in-process (node host, new Function)');
        return 0;
      }
      // 这一代没有 JS 引擎，"直接执行"就是 C 路径
      return runViaC(mod, rest);
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
      return runViaC(mod, rest);
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
      return runViaLlvm(mod, rest);
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
      return runViaJit(mod, rest);
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
      const dir = ci >= 0 ? rest[ci + 1] : join(tmpDir(), 'omni-incr');
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
  const dir = join(tmpDir(), `omni-glr-${hash16(`${TABLE_FORMAT}|${text}`)}`);
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
  const tmp = join(mkdTemp(join(tmpDir(), 'omni-glr-w-')), 'table.txt');
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
  repl      interactive session (no file; defaults to --mode dynamic; --lang omni|sx)
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
  oir       print the OIR as JSON
  mir       print the MIR (ADR-0014 decision 6): SSA values + slots + structured
            control flow, one 8-byte record per instruction (--bytes: sizes and
            per-function content hashes instead of the listing)
  incr      compile function by function through the content-addressed cache
            (ADR-0014 decision 5) and print hit/miss counts
            (--cache DIR, default \$TMPDIR/omni-incr; --list: one line per unit)
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
