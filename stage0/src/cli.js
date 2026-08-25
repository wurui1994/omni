#!/usr/bin/env node
// Omni stage0 — 命令行入口
//
//   omni run     f.omni      解析 -> OIR -> JS -> 进程内执行（这就是「直接解析执行」在 JS 宿主上的形态）
//   omni run-c   f.omni      解析 -> OIR -> C -> cc -> 执行
//   omni emit-js f.omni      打印生成的 JS
//   omni emit-c  f.omni      打印生成的 C
//   omni build   f.omni -o a 生成原生可执行文件
//   omni ast/oir f.omni      打印中间结果（调试用）

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SourceFile, Diagnostics, OmniError } from './source/diag.js';
import { parse } from './parse/parser.js';
import { check } from './hir/check.js';
import { emitJs } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';
import { startRepl } from './repl.js';

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/**
 * 标准库暂时没有模块系统（ADR-0006 落地顺序第 6 项），先按"提到就整体拼入"的粗粒度规则处理。
 * 这是显式的临时方案：有了 import / access 之后删掉。
 * `dynamic` 也触发 json 库，因为 `print(dynamic)` 会降级成对 `dynToText` 的调用（ADR-0008 第 5 节）；
 * 纯动态模式下一切缺省注解都是 dynamic，所以无条件拼入。
 */
function libsFor(text, mode) {
  const libs = [];
  // `Json` 不加词边界：公开入口叫 parseJson / stringifyJson，`\bJson\b` 在 "parseJson" 里匹配不上，
  // 于是 `j = parseJson(s)` 会莫名其妙地报 "undefined function 'parseJson'"。
  if (mode === 'dynamic' || /\bjson\b|Json|\bdynamic\b/.test(text)) libs.push('json.omni');
  return libs;
}

/** 文件后缀决定默认的类型模式（ADR-0008 第 1 节）；`--mode` 可覆盖，REPL 用它 */
const MODE_BY_EXT = { '.omni': 'mixed', '.omnid': 'dynamic', '.omnis': 'static' };

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
  return compileText(path, readFileSync(path, 'utf8'), modeFor(path, argv));
}

/** 从内存里的源文本编译。REPL 走这条（它没有文件），`compile` 只是它加一次读盘。 */
export function compileText(path, text, mode) {
  const file = new SourceFile(path, text);
  const diags = new Diagnostics();
  const decls = [];
  for (const lib of libsFor(file.text, mode)) {
    const libPath = join(LIB_DIR, lib);
    const libFile = new SourceFile(libPath, readFileSync(libPath, 'utf8'));
    decls.push(...parse(libFile, diags).decls);
  }
  const ast = parse(file, diags);
  decls.push(...ast.decls);
  diags.throwIfErrors();
  // 模式目前是整程序的（lib 与用户代码并成一个 program），按文件的模式等模块系统
  const mod = check({ kind: 'Program', decls }, diags, mode);
  diags.throwIfErrors();
  return { file, ast, mod, diags };
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

function buildNative(mod, outPath) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-'));
  const cPath = join(dir, 'out.c');
  writeFileSync(cPath, emitC(mod));
  const cc = findCC();
  const args = cc === 'tcc'
    ? [cPath, '-o', outPath, '-lm']
    : [cPath, '-o', outPath, '-O2', '-std=c99', '-lm', '-w'];
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
      process.stdout.write(emitC(mod));
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
  repl      interactive session (no file; defaults to --mode dynamic)
  run       compile to JS and execute in-process
  run-c     compile to C, build with cc, execute
  build     compile to a native executable  (-o NAME)
  emit-js   print generated JavaScript
  emit-c    print generated C
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
