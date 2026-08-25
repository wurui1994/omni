#!/usr/bin/env node
// Omni stage0 — 命令行入口
//
//   omni run     f.omni      解析 -> OIR -> JS -> 进程内执行（这就是「直接解析执行」在 JS 宿主上的形态）
//   omni run-c   f.omni      解析 -> OIR -> C -> cc -> 执行
//   omni emit-js f.omni      打印生成的 JS
//   omni emit-c  f.omni      打印生成的 C
//   omni build   f.omni -o a 生成原生可执行文件
//   omni ast/oir f.omni      打印中间结果（调试用）

import { writeFileSync, mkdtempSync, existsSync, statSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from './host/path.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Diagnostics, OmniError } from './source/diag.js';
import { check } from './hir/check.js';
import { emitJs } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';
import { RUNTIME_DIR, runtimeSources } from './runtime/c_runtime.js';
import { loadProgram, MODE_BY_EXT } from './module/load.js';
import { startRepl } from './repl.js';

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

function compile(path, argv = []) {
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
  const explicit = process.env.OMNI_CC;
  if (explicit) return explicit;
  for (const cc of ['tcc', 'clang', 'gcc', 'cc']) {
    const r = spawnSync('which', [cc], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return cc;
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
  const deps = readdirSync(RUNTIME_DIR).filter((f) => /\.[ch]$/.test(f)).sort()
    .map((f) => {
      const s = statSync(join(RUNTIME_DIR, f));
      return `${f}:${s.mtimeMs}:${s.size}`;
    });
  const key = createHash('sha256').update([cc, ...flags, ...deps].join('|')).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `omni-rt-${key}`);
  const objs = srcs.map((p) => join(dir, `${basename(p, '.c')}.o`));
  if (objs.every((o) => existsSync(o))) return objs;

  // 先编进临时目录再整体 rename：中断或并发都不会留下半个缓存
  const stage = mkdtempSync(join(tmpdir(), 'omni-rt-stage-'));
  const staged = srcs.map((p) => join(stage, `${basename(p, '.c')}.o`));
  for (let i = 0; i < srcs.length; i++) {
    const r = spawnSync(cc, [...flags, '-c', '-o', staged[i], srcs[i]], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new OmniError(`omni runtime failed to compile with ${cc}:\n${r.stderr}`);
    }
  }
  try {
    renameSync(stage, dir);
  } catch {
    /* 目标已存在 = 别人先建好了，下面那句会用它 */
  }
  return objs.every((o) => existsSync(o)) ? objs : staged;
}

function buildNative(mod, outPath) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-'));
  const cPath = join(dir, 'out.c');
  writeFileSync(cPath, emitC(mod));
  const cc = findCC();
  // 运行时是 stage0/runtime/ 下真正的 C 文件，预编成 .o 缓存起来；热的叶子函数是
  // omni.h 里的 static inline，所以不靠 LTO 也能内联（tcc 没有 -flto）
  const args = [...ccFlags(cc), cPath, ...runtimeObjects(cc), '-o', outPath, '-lm'];
  const r = spawnSync(cc, args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
  if (r.status !== 0) {
    throw new OmniError(`C backend produced code that ${cc} rejected:\n${r.stderr}\n(kept at ${cPath})`);
  }
  return { cPath, cc };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  // 带值的开关（-o NAME / --mode M）的值不能被当成源文件
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-o' || a === '--mode') { i++; continue; }
    if (a.startsWith('-')) continue;
    files.push(a);
  }
  const path = files[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  // repl 没有源文件；默认模式见 repl.js 的文件头（不是 ADR-0008 说的 dynamic，有原因）
  if (cmd === 'repl') return startRepl(compileText, modeFor('', rest, 'mixed'));
  if (!path) throw new OmniError(`command '${cmd}' needs a source file`);
  if (!existsSync(path)) throw new OmniError(`no such file: ${path}`);

  switch (cmd) {
    case 'run': {
      const { mod } = compile(path, rest);
      // eslint-disable-next-line no-new-func
      new Function(emitJs(mod))();
      return 0;
    }
    case 'emit-js': {
      const { mod } = compile(path, rest);
      process.stdout.write(emitJs(mod));
      return 0;
    }
    case 'emit-c': {
      const { mod } = compile(path, rest);
      process.stdout.write(emitC(mod, { amalgamate: rest.includes('--amalgamate') }));
      return 0;
    }
    case 'build': {
      const { mod } = compile(path, rest);
      const oi = rest.indexOf('-o');
      const out = oi >= 0 ? rest[oi + 1] : basename(path).replace(/\.omni$/, '');
      const { cc } = buildNative(mod, out);
      process.stderr.write(`omni: built ${out} via ${cc}\n`);
      return 0;
    }
    case 'run-c': {
      const { mod } = compile(path, rest);
      const dir = mkdtempSync(join(tmpdir(), 'omni-run-'));
      const exe = join(dir, 'a.out');
      buildNative(mod, exe);
      const r = spawnSync(exe, [], { stdio: 'inherit' });
      return r.status ?? 1;
    }
    case 'ast': {
      const { ast } = compile(path, rest);
      process.stdout.write(JSON.stringify(ast, replacer, 2) + '\n');
      return 0;
    }
    case 'oir': {
      const { mod } = compile(path, rest);
      process.stdout.write(JSON.stringify(mod, replacer, 2) + '\n');
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
  repl      interactive session (no file; defaults to --mode mixed, see repl.js)
  run       compile to JS and execute in-process
  run-c     compile to C, build with cc, execute
  build     compile to a native executable  (-o NAME)
  emit-js   print generated JavaScript
  emit-c    print generated C  (--amalgamate: inline the whole runtime into one file)
  ast       print the AST as JSON
  oir       print the OIR as JSON

type modes (ADR-0008) — chosen by extension, overridable with --mode:
  .omni     mixed   omitted type is inferred from the initializer, else dynamic
  .omnid    dynamic omitted type is always dynamic
  .omnis    static  omitted type is inferred; implicit dynamic is an error

env:
  OMNI_CC   C compiler to use (default: first of tcc, clang, gcc, cc)
`;

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof OmniError) {
    process.stderr.write(e.message + '\n');
    process.exitCode = 1;
  } else throw e;
}
