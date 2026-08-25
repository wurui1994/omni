#!/usr/bin/env node
// Omni — OIR 层的运算语义对照测试（第四条轴）
//
// 为什么需要它：`js_*` 这批 op（ADR-0011）**没有 Omni 语法能表达** —— truthiness、
// `+` 的双重含义、`undefined` 都不属于 Omni 语言，它们只由 frontend-js/lower.js 产生。
// 所以在降级器写出来之前，验证它们的唯一办法是**手搭 OIR**，两个后端各跑一遍，
// 再和 node 里同一个表达式的结果对照。
//
// 三方必须逐字节相同：node（参照）== omni-js == omni-c。
//
//   node tests/oir/run.js
//   node tests/oir/run.js add     只跑名字含 add 的用例

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emitJs } from '../../stage0/src/backend-js/emit.js';
import { emitC } from '../../stage0/src/backend-c/emit.js';
import { runtimeSources, RUNTIME_DIR } from '../../stage0/src/runtime/c_runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

// ---------------------------------------------------------------- OIR 构造助手
const D = { k: 'dynamic' };
const I = { k: 'int' };
const R = { k: 'real' };
const S = { k: 'string' };
const B = { k: 'bool' };
const VOID = { k: 'void' };

const box = (e) => ({ kind: 'Box', type: D, from: e.type, expr: e });
const int = (v) => box({ kind: 'Const', type: I, value: BigInt(v) });
const real = (v) => box({ kind: 'Const', type: R, value: v });
const str = (v) => box({ kind: 'Const', type: S, value: v });
const bool = (v) => box({ kind: 'Const', type: B, value: v });
const undef = { kind: 'Builtin', name: 'js_undef', args: [], type: D };
const nul = { kind: 'DynNull', type: D };

const js = (name, args, extra = {}) => ({ kind: 'Builtin', name, args, type: D, ...extra });
const jsBool = (name, args, extra = {}) => ({ kind: 'Builtin', name, args, type: B, ...extra });
const jsStr = (name, args) => ({ kind: 'Builtin', name, args, type: S });

/** 把一个表达式变成"打印它的文本"的语句；bool / string / dynamic 各有各的路子 */
function printStmt(e) {
  if (e.type === B) {
    return stmt({ kind: 'Builtin', name: 'print', args: [{ kind: 'Builtin', name: 'to_string', args: [e], type: S, argType: B }], type: VOID, recvType: S, argType: S });
  }
  if (e.type === S) {
    return stmt({ kind: 'Builtin', name: 'print', args: [e], type: VOID, recvType: S, argType: S });
  }
  return stmt({ kind: 'Builtin', name: 'print', args: [jsStr('js_str', [e])], type: VOID, recvType: S, argType: S });
}
const stmt = (e) => ({ kind: 'ExprStmt', expr: e });

function moduleOf(exprs) {
  return {
    structs: [],
    classes: [],
    containers: [],
    closures: [],
    fnTypes: [],
    funcs: [{
      name: 'main', mangled: 'omni_main', ret: VOID, params: [],
      body: { kind: 'Block', stmts: exprs.map(printStmt) },
    }],
    entry: 'omni_main',
  };
}

// ---------------------------------------------------------------- 用例
// 每条给三样东西：名字、OIR 表达式、以及**在 node 里等价的 JS 源码**（参照实现）。
const CASES = [];
const c = (name, oir, jsSrc) => CASES.push({ name, oir, jsSrc });

c('add/int', js('js_add', [int(2), int(3)]), '2n + 3n');
c('add/int-wrap', js('js_add', [int(2n ** 62n), int(2n ** 62n)]), 'BigInt.asIntN(64, 2n**62n + 2n**62n)');
c('add/real', js('js_add', [real(0.1), real(0.2)]), '0.1 + 0.2');
c('add/str', js('js_add', [str('a'), str('b')]), '"a" + "b"');
c('add/str-int', js('js_add', [str('n='), int(7)]), '"n=" + 7n');
c('add/int-str', js('js_add', [int(-7), str('!')]), '-7n + "!"');
c('add/str-real', js('js_add', [str('x'), real(1.5)]), '"x" + 1.5');
c('add/str-bool', js('js_add', [str('b:'), bool(true)]), '"b:" + true');
c('add/str-null', js('js_add', [str('v='), nul]), '"v=" + null');
c('add/str-undef', js('js_add', [str('v='), undef]), '"v=" + undefined');

c('arith/sub-int', js('js_arith', [int(5), int(9)], { op: '-' }), '5n - 9n');
c('arith/mul-int', js('js_arith', [int(-3), int(7)], { op: '*' }), '-3n * 7n');
c('arith/div-int', js('js_arith', [int(7), int(2)], { op: '/' }), '7n / 2n');
c('arith/div-int-neg', js('js_arith', [int(-7), int(2)], { op: '/' }), '-7n / 2n');
c('arith/mod-int', js('js_arith', [int(-7), int(3)], { op: '%' }), '-7n % 3n');
c('arith/sub-real', js('js_arith', [real(1), real(1e-3)], { op: '-' }), '1 - 1e-3');
c('arith/div-real', js('js_arith', [real(1), real(3)], { op: '/' }), '1 / 3');
c('arith/div-zero-real', js('js_arith', [real(1), real(0)], { op: '/' }), '1 / 0');
c('arith/mod-real', js('js_arith', [real(5.5), real(2)], { op: '%' }), '5.5 % 2');
c('neg/int', js('js_neg', [int(5)]), '-5n');
c('neg/real', js('js_neg', [real(2.5)]), '-2.5');

c('bit/and', js('js_bitop', [int(0xf0), int(0x3c)], { op: '&' }), '0xf0n & 0x3cn');
c('bit/or', js('js_bitop', [int(0xf0), int(0x0f)], { op: '|' }), '0xf0n | 0x0fn');
c('bit/xor', js('js_bitop', [int(0xff), int(0x0f)], { op: '^' }), '0xffn ^ 0x0fn');
c('bit/shl', js('js_bitop', [int(1), int(62)], { op: '<' }), 'BigInt.asIntN(64, 1n << 62n)');
c('bit/shr', js('js_bitop', [int(-8), int(2)], { op: '>' }), '-8n >> 2n');
c('bit/not', js('js_bitnot', [int(0x0f)]), '~0x0fn');
c('bit/not-neg', js('js_bitnot', [int(-1)]), '~-1n');

c('cmp/lt-int', jsBool('js_cmp', [int(1), int(2)], { op: '<' }), '1n < 2n');
c('cmp/gt-real', jsBool('js_cmp', [real(2.5), real(2.5)], { op: '>' }), '2.5 > 2.5');
c('cmp/le-int', jsBool('js_cmp', [int(2), int(2)], { op: 'l' }), '2n <= 2n');
c('cmp/ge-mixed', jsBool('js_cmp', [int(3), real(2.5)], { op: 'g' }), 'Number(3n) >= 2.5');
c('cmp/nan', jsBool('js_cmp', [real(NaN), real(1)], { op: '<' }), 'NaN < 1');
c('cmp/str', jsBool('js_cmp', [str('abc'), str('abd')], { op: '<' }), '"abc" < "abd"');
c('cmp/str-prefix', jsBool('js_cmp', [str('ab'), str('abc')], { op: '<' }), '"ab" < "abc"');

c('eq/strict-int', jsBool('js_eq', [int(1), int(1)], { strict: true }), '1n === 1n');
c('eq/strict-int-real', jsBool('js_eq', [int(1), real(1)], { strict: true }), '1n === 1');
c('eq/loose-int-real', jsBool('js_eq', [int(1), real(1)], { strict: false }), '1n == 1');
c('eq/strict-null-undef', jsBool('js_eq', [nul, undef], { strict: true }), 'null === undefined');
c('eq/loose-null-undef', jsBool('js_eq', [nul, undef], { strict: false }), 'null == undefined');
c('eq/loose-null-zero', jsBool('js_eq', [nul, int(0)], { strict: false }), 'null == 0n');
c('eq/str', jsBool('js_eq', [str('x'), str('x')], { strict: true }), '"x" === "x"');
c('eq/nan', jsBool('js_eq', [real(NaN), real(NaN)], { strict: true }), 'NaN === NaN');
c('eq/zeroes', jsBool('js_eq', [real(0), real(-0)], { strict: true }), '0 === -0');
c('eq/bool', jsBool('js_eq', [bool(true), bool(false)], { strict: true }), 'true === false');

for (const [label, v, src] of [
  ['undef', undef, 'undefined'], ['null', nul, 'null'],
  ['true', bool(true), 'true'], ['false', bool(false), 'false'],
  ['zero-int', int(0), '0n'], ['one-int', int(1), '1n'],
  ['zero-real', real(0), '0'], ['nan', real(NaN), 'NaN'], ['one-real', real(2.5), '2.5'],
  ['empty-str', str(''), '""'], ['str', str('x'), '"x"'],
]) {
  c(`truthy/${label}`, jsBool('js_truthy', [v]), `Boolean(${src})`);
  c(`typeof/${label}`, jsStr('js_typeof', [v]), `typeof ${src}`);
  c(`str/${label}`, jsStr('js_str', [v]), `String(${src})`);
}

// Number -> String 的排布规则（ECMA-262 Number::toString）。这一组是自举收敛的关键：
// 少一位、多一个 ".0"、指数写成 "e-07" 而不是 "e-7"，第二代和第三代就不一样。
for (const src of [
  '-0', '1', '-2.5', '100', '0.1', '1/3', '1234.5678',
  '1e-5', '1e-6', '1e-7', '1e-10', '5e-324',
  '1e15', '1e20', '1e21', '1e22', '123456789012345680000',
  '1.7976931348623157e308', '-1e-7', '-1e21',
]) {
  // eslint-disable-next-line no-eval
  c(`num/${src}`, jsStr('js_str', [real(eval(src))]), `String(${src})`);
}

// ---------------------------------------------------------------- 跑
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

const cases = CASES.filter((x) => !filters.length || filters.some((f) => x.name.includes(f)));
const dir = mkdtempSync(join(tmpdir(), 'omni-oir-'));

// 参照：在 node 里把每条 jsSrc 求值，按 JS 的 String() 打印
const refSrc = cases.map((x) => `console.log(String(${x.jsSrc}));`).join('\n');
const refPath = join(dir, 'ref.mjs');
writeFileSync(refPath, `${refSrc}\n`);
const ref = run(process.execPath, [refPath]);
if (ref.code !== 0) {
  process.stdout.write(`  FAIL reference program\n${ref.err}\n`);
  process.exit(1);
}

const mod = moduleOf(cases.map((x) => x.oir));
const jsPath = join(dir, 'out.mjs');
writeFileSync(jsPath, emitJs(mod));
const viaJs = run(process.execPath, [jsPath]);

const cPath = join(dir, 'out.c');
writeFileSync(cPath, emitC(mod));
const exe = join(dir, 'a.out');
const cc = ['clang', 'cc', 'gcc'].find((x) => run('which', [x]).code === 0);
const build = run(cc, ['-std=c99', '-O1', `-I${RUNTIME_DIR}`, cPath, ...runtimeSources(), '-o', exe, '-lm']);
const viaC = build.code === 0 ? run(exe, []) : { out: '', err: build.err, code: build.code };

const lines = (s) => s.replace(/\n+$/, '').split('\n');
const refLines = lines(ref.out);
const jsLines = lines(viaJs.out);
const cLines = lines(viaC.out);

let pass = 0;
let fail = 0;
const failures = [];

if (viaJs.code !== 0 || viaC.code !== 0) {
  const why = [
    viaJs.code !== 0 ? `omni-js exited ${viaJs.code}\n${viaJs.err}` : '',
    viaC.code !== 0 ? `omni-c exited ${viaC.code}\n${viaC.err}` : '',
  ].filter(Boolean).join('\n');
  process.stdout.write(`  FAIL whole program\n${why}\n  (kept in ${dir})\n`);
  process.exit(1);
}

cases.forEach((x, i) => {
  const want = refLines[i];
  const gotJs = jsLines[i];
  const gotC = cLines[i];
  if (want === gotJs && want === gotC) {
    pass++;
    process.stdout.write(`  ok   ${x.name} = ${JSON.stringify(want)}\n`);
    return;
  }
  fail++;
  failures.push(`${x.name}  (${x.jsSrc})\n    node   ${JSON.stringify(want)}`
    + `\n    omni-js ${JSON.stringify(gotJs)}\n    omni-c  ${JSON.stringify(gotC)}`);
  process.stdout.write(`  FAIL ${x.name}\n`);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
