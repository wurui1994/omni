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
  args as procArgs, env, stdout, stderr, setExitCode, spawn, tmpDir, evalJs, hasJsEngine,
  cwd, installDir,
} from './host/native.js';
import { join, basename } from './host/path.js';
import { hash16 } from './host/hash.js';
import { linkJs } from './frontend-js/link.js';
import { lowerJs } from './frontend-js/lower.js';
import { Diagnostics, OmniError } from './source/diag.js';
import { check } from './hir/check.js';
import { emitJs } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';
import { RUNTIME_DIR, runtimeSources } from './runtime/c_runtime.js';
import { loadProgram, MODE_BY_EXT } from './module/load.js';
import { startRepl } from './repl.js';
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

/**
 * `.js` 入口走 JS 语法前端：链接整棵 import 树，再降级成 OIR（ADR-0011 第 6 步）。
 * 自举就是这一条路 —— 编译器自己的源码是 JS，喂给它自己就得到下一代。
 * 这里没有 check()：OIR 是降级器直接造的，类型早已确定（全是 dynamic）。
 */
function compileJs(path) {
  const diags = new Diagnostics();
  const ast = linkJs(path, (p) => (exists(p) ? readText(p) : null), diags);
  diags.throwIfErrors();
  const mod = lowerJs(ast, diags);
  diags.throwIfErrors();
  return { ast, mod, diags };
}

function compile(path, argv = []) {
  if (path.endsWith('.js')) return compileJs(path);
  return compileProgram(path, undefined, modeFor(path, argv));
}

/** 从内存里的源文本编译。REPL 走这条（它没有文件），`compile` 只是把 text 交给加载器去读盘。 */
export function compileText(path, text, mode) {
  return compileProgram(path, text, mode);
}

/**
 * 入口 -> 模块图 -> 检查 -> OIR。
 * 依赖不再靠"提到 json 就整体拼进来"的猜测（旧的 libsFor），而是靠源码里写下的 import（ADR-0009）。
 * `--mode` 只覆盖入口文件的模式；被导入模块的模式由它自己的后缀决定。
 */
function compileProgram(path, text, mode) {
  const diags = new Diagnostics();
  const { decls, imports } = loadProgram({ path, text, mode, diags });
  diags.throwIfErrors();
  const program = { kind: 'Program', decls, imports };
  const mod = check(program, diags, mode);
  diags.throwIfErrors();
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

/** tcc 要的是极速编译，clang/gcc 要 -O2；运行时和生成的代码用同一份 flags */
function ccFlags(cc) {
  return cc === 'tcc' ? ['-I', RUNTIME_DIR] : ['-O2', '-std=c99', '-w', '-I', RUNTIME_DIR];
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
  if (objs.every((o) => exists(o))) return objs;

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
  writeText(cPath, emitC(mod));
  const cc = findCC();
  // 运行时是 stage0/runtime/ 下真正的 C 文件，预编成 .o 缓存起来；热的叶子函数是
  // omni.h 里的 static inline，所以不靠 LTO 也能内联（tcc 没有 -flto）
  const cargs = [...ccFlags(cc), cPath, ...runtimeObjects(cc), '-o', outPath, '-lm'];
  const r = spawn(cc, cargs, 'o');
  if (r[0] !== 0) {
    throw new OmniError(`C backend produced code that ${cc} rejected:\n${r[2]}\n(kept at ${cPath})`);
  }
  return { cPath, cc };
}

/**
 * C 路径上的"直接执行"：编出一个可执行文件再跑掉，退出码原样传回。
 * `run-c` 就是它；原生构建上的 `run` 也是它（那一代没有 JS 引擎）。
 * `--work DIR` 会把可执行文件和生成的 C 都留在 DIR 里，方便事后看。
 */
function runViaC(mod, argv) {
  const wi = argv.indexOf('--work');
  const dir = wi >= 0 ? argv[wi + 1] : mkdTemp(join(tmpDir(), 'omni-run-'));
  if (wi >= 0) mkdirAll(dir);
  const exe = join(dir, 'a.out');
  buildNative(mod, exe, wi >= 0 ? dir : undefined);
  return spawn(exe, [], 'i')[0];
}

function main(argv) {
  const [cmd, ...rest] = argv;
  // 带值的开关（-o NAME / --mode M）的值不能被当成源文件
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-o' || a === '--mode' || a === '--work') { i++; continue; }
    if (a.startsWith('-')) continue;
    files.push(a);
  }
  const path = files[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    stdout(USAGE);
    return 0;
  }
  // repl 没有源文件；默认模式是 ADR-0008 第 3 节的 dynamic（沿革见 repl.js 文件头）
  if (cmd === 'repl') return startRepl(compileText, modeFor('', rest, 'dynamic'));
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
      // `run` 的意思是"解析完直接执行"，怎么执行是**这一代宿主的事**：node 上是生成 JS
      // 在本进程里 eval；原生构建里没有 JS 引擎，那条路就是 C 路径。所以先问一句能力，
      // 而不是让 js_eval 报错 —— 用户要的是执行，不是一句"换个命令重试"。
      if (hasJsEngine()) {
        evalJs(emitJs(mod));
        return 0;
      }
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
    default:
      throw new OmniError(`unknown command '${cmd}'\n${USAGE}`);
  }
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
  repl      interactive session (no file; defaults to --mode dynamic)
  run       parse and execute (node host: in-process JS; native build: via the C path)
  run-c     compile to C, build with cc, execute
  build     compile to a native executable  (-o NAME; --work DIR keeps the generated C there)
  emit-js   print generated JavaScript
  emit-c    print generated C  (--amalgamate: inline the whole runtime into one file)
  ast       print the AST as JSON
  oir       print the OIR as JSON
  bootstrap build the whole chain into a tree and check the four fixpoints
            (no file = the compiler itself; -o DIR, default ./dist; -q skips the C path)

type modes (ADR-0008) — chosen by extension, overridable with --mode:
  .omni     mixed   omitted type is inferred from the initializer, else dynamic
  .omnid    dynamic omitted type is always dynamic
  .omnis    static  omitted type is inferred; implicit dynamic is an error

a .js entry goes through the JS front end instead (ADR-0011): the import tree is
linked into one program and lowered to OIR. That is how omni compiles itself.

env:
  OMNI_CC   C compiler to use (default: first of tcc, clang, gcc, cc)
`;

try {
  setExitCode(main(procArgs()));
} catch (e) {
  if (e instanceof OmniError) {
    stderr(e.message + '\n');
    setExitCode(1);
  } else throw e;
}
