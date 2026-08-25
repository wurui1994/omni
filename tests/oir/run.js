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
import { listType, dictType } from '../../stage0/src/hir/types.js';

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
const bool = (v) => box({ kind: 'Const', type: B, value: v });
const undef = { kind: 'Builtin', name: 'js_undef', args: [], type: D };
const nul = { kind: 'DynNull', type: D };

const js = (name, args, extra = {}) => ({ kind: 'Builtin', name, args, type: D, ...extra });
const jsBool = (name, args, extra = {}) => ({ kind: 'Builtin', name, args, type: B, ...extra });

// JS 的字符串是 UTF-16（ADR-0011 第 8 节），所以字面量要过一次 js_s16：
// 源码里是 UTF-8 的 Omni string，进 JS 域之前转成码元序列。
const str = (v) => js('js_s16', [{ kind: 'Const', type: S, value: v }]);

/** 打印：一律走 js_println —— 它内部做 js_str + 转回 UTF-8，是唯一的输出边界 */
function printStmt(e) {
  const v = e.type === B ? box(e) : e;
  return stmt({ kind: 'Builtin', name: 'js_println', args: [v], type: VOID });
}
const stmt = (e) => ({ kind: 'ExprStmt', expr: e });

function moduleOf(exprs) {
  return {
    structs: [],
    classes: [],
    // 这三个实例化是 OMNI_DYN_BRIDGE 与 OMNI_JS_ARR 的发射条件（见 backend-c 的 dynBridge）。
    // list<string> 是被 dict 的 _keys 拖进来的 —— 真实程序里检查器会替我们登记。
    containers: [listType(S), listType(D), dictType(S, D)],
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
  c(`typeof/${label}`, js('js_typeof', [v]), `typeof ${src}`);
  c(`str/${label}`, js('js_str', [v]), `String(${src})`);
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
  c(`num/${src}`, js('js_str', [real(eval(src))]), `String(${src})`);
}

// String 方法。含中文与 emoji 的用例是这一组的重点：UTF-16 码元口径下 "中" 是 1，
// UTF-8 字节口径下是 3 —— 如果 C 侧偷懒复用了 omni_str，这里立刻分叉（ADR-0011 第 8 节）。
const CN = '中文abc';
const EMO = 'a\u{1f600}b';
// 空白用 \v 而不是 \n：值里带换行会让"一条用例一行"的约定破掉
const strs = { ascii: 'hello', cn: CN, emo: EMO, empty: '', ws: '  x\t\v' };
const q = (s) => JSON.stringify(s);
for (const [k, s] of Object.entries(strs)) {
  c(`slen/${k}`, js('js_str_len', [str(s)]), `${q(s)}.length`);
  c(`slower/${k}`, js('js_str_lower', [str(s)]), `${q(s)}.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))`);
  c(`strim/${k}`, js('js_str_trim', [str(s)], { side: 'b' }), `${q(s)}.trim()`);
  c(`strimL/${k}`, js('js_str_trim', [str(s)], { side: 'l' }), `${q(s)}.trimStart()`);
  c(`strimR/${k}`, js('js_str_trim', [str(s)], { side: 'r' }), `${q(s)}.trimEnd()`);
}
for (const i of [-1, 0, 1, 2, 3, 6, 99]) {
  c(`sidx/cn/${i}`, js('js_str_index', [str(CN), real(i)]), `${q(CN)}[${i}]`);
  c(`sat/cn/${i}`, js('js_str_at', [str(CN), real(i)]), `${q(CN)}.at(${i})`);
  c(`scc/cn/${i}`, js('js_str_char_code_at', [str(CN), real(i)]), `${q(CN)}.charCodeAt(${i})`);
  c(`scp/emo/${i}`, js('js_str_code_point_at', [str(EMO), real(i)]), `${q(EMO)}.codePointAt(${i})`);
}
for (const [a, b] of [[0, 2], [1, 99], [-2, 99], [2, 1], [-99, -1], [0, -1]]) {
  c(`sslice/cn/${a},${b}`, js('js_str_slice', [str(CN), real(a), real(b)]), `${q(CN)}.slice(${a}, ${b})`);
  c(`sslice/emo/${a},${b}`, js('js_str_slice', [str(EMO), real(a), real(b)]), `${q(EMO)}.slice(${a}, ${b})`);
}
c('sslice/open', js('js_str_slice', [str(CN), real(2), undef]), `${q(CN)}.slice(2)`);
c('srepeat', js('js_str_repeat', [str(CN), real(3)]), `${q(CN)}.repeat(3)`);
c('srepeat/0', js('js_str_repeat', [str(CN), real(0)]), `${q(CN)}.repeat(0)`);
c('spad', js('js_str_pad_start', [str('7'), real(3), str('0')]), '"7".padStart(3, "0")');
c('spad/dflt', js('js_str_pad_start', [str('7'), real(4), undef]), '"7".padStart(4)');
c('spad/short', js('js_str_pad_start', [str('abc'), real(2), str('0')]), '"abc".padStart(2, "0")');
c('spad/multi', js('js_str_pad_start', [str('x'), real(6), str('ab')]), '"x".padStart(6, "ab")');
c('sindexOf', js('js_str_index_of', [str(CN), str('文'), undef]), `${q(CN)}.indexOf("文")`);
c('sindexOf/from', js('js_str_index_of', [str('aXaX'), str('X'), real(2)]), '"aXaX".indexOf("X", 2)');
c('sindexOf/miss', js('js_str_index_of', [str(CN), str('z'), undef]), `${q(CN)}.indexOf("z")`);
c('slastIndexOf', js('js_str_last_index_of', [str('aXaX'), str('X')]), '"aXaX".lastIndexOf("X")');
c('sincludes', jsBool('js_str_includes', [str(CN), str('文a')]), `${q(CN)}.includes("文a")`);
c('sstarts', jsBool('js_str_starts_with', [str(CN), str('中'), undef]), `${q(CN)}.startsWith("中")`);
c('sstarts/at', jsBool('js_str_starts_with', [str(CN), str('文'), real(1)]), `${q(CN)}.startsWith("文", 1)`);
c('sstarts/at-miss', jsBool('js_str_starts_with', [str(CN), str('中'), real(1)]), `${q(CN)}.startsWith("中", 1)`);
c('sstarts/at-end', jsBool('js_str_starts_with', [str(CN), str(''), real(99)]), `${q(CN)}.startsWith("", 99)`);
c('sends', jsBool('js_str_ends_with', [str(CN), str('bc')]), `${q(CN)}.endsWith("bc")`);
c('scmp/lt', jsBool('js_cmp', [str('abc'), str('abd')], { op: '<' }), '"abc" < "abd"');
c('scmp/cn', jsBool('js_cmp', [str('中'), str('文')], { op: '<' }), '"中" < "文"');
c('seq/cn', jsBool('js_eq', [str(CN), str('中文abc')], { strict: true }), `${q(CN)} === "中文abc"`);
c('sfromCharCode', js('js_str_of_char_code', [real(0x4e2d)]), 'String.fromCharCode(0x4e2d)');
c('sfromCodePoint', js('js_str_of_code_point', [real(0x1f600)]), 'String.fromCodePoint(0x1f600)');

// Array。手搭 OIR 造不出闭包，所以这一轮先验不带回调的那些；带回调的（map/filter/sort）
// 等 lower.js 能产出闭包之后一起验。
const arr = (...items) => box({ kind: 'ListLit', type: listType(D), items });
const A = () => arr(real(3), real(1), real(2));
const AS = '[3, 1, 2]';
c('alen', js('js_arr_len', [A()]), `${AS}.length`);
c('alen/empty', js('js_arr_len', [arr()]), '[].length');
for (const i of [-1, 0, 2, 3]) {
  c(`aget/${i}`, js('js_arr_get', [A(), real(i)]), `${AS}[${i}]`);
}
c('apop', js('js_arr_pop', [A()]), `${AS}.pop()`);
c('apop/empty', js('js_arr_pop', [arr()]), '[].pop()');
c('apush', js('js_arr_push', [A(), real(9)]), `${AS}.push(9)`);
c('ajoin', js('js_arr_join', [A(), str('-')]), `${AS}.join("-")`);
c('ajoin/dflt', js('js_arr_join', [A(), undef]), `${AS}.join()`);
c('ajoin/holes', js('js_arr_join', [arr(real(1), nul, undef, str('x')), str(',')]), '[1, null, undefined, "x"].join(",")');
c('ajoin/empty', js('js_arr_join', [arr(), str('-')]), '[].join("-")');
c('aslice', js('js_arr_join', [js('js_arr_slice', [A(), real(1), real(3)]), str(',')]), `${AS}.slice(1, 3).join(",")`);
c('aslice/neg', js('js_arr_join', [js('js_arr_slice', [A(), real(-2), undef]), str(',')]), `${AS}.slice(-2).join(",")`);
c('aconcat', js('js_arr_join', [js('js_arr_concat', [A(), arr(real(7))]), str(',')]), `${AS}.concat([7]).join(",")`);
c('areverse', js('js_arr_join', [js('js_arr_reverse', [A()]), str(',')]), `${AS}.reverse().join(",")`);
c('afill', js('js_arr_join', [js('js_arr_fill', [A(), real(0)]), str(',')]), `${AS}.fill(0).join(",")`);
c('afrom', js('js_arr_join', [js('js_arr_from', [A()]), str(',')]), `Array.from(${AS}).join(",")`);
c('aisArray', jsBool('js_arr_is_array', [A()]), `Array.isArray(${AS})`);
c('aisArray/no', jsBool('js_arr_is_array', [real(1)]), 'Array.isArray(1)');
c('aindexOf', js('js_arr_index_of', [A(), real(2)]), `${AS}.indexOf(2)`);
c('aindexOf/miss', js('js_arr_index_of', [A(), real(8)]), `${AS}.indexOf(8)`);
c('alastIndexOf', js('js_arr_last_index_of', [arr(real(1), real(2), real(1)), real(1)]), '[1, 2, 1].lastIndexOf(1)');
c('aincludes', jsBool('js_arr_includes', [A(), real(1)]), `${AS}.includes(1)`);
c('aincludes/nan', jsBool('js_arr_includes', [arr(real(NaN)), real(NaN)]), '[NaN].includes(NaN)');
c('aindexOf/nan', js('js_arr_index_of', [arr(real(NaN)), real(NaN)]), '[NaN].indexOf(NaN)');


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

// 一条用例一行，否则名字和结果就错位了 —— 三方仍然是逐行比的，比较本身有效，
// 但报出来的名字对不上，失败就没法归因。所以在这里直接卡住。
{
  const n = ref.out.replace(/\n$/, '').split('\n').length;
  if (n !== cases.length) {
    process.stdout.write(`  FAIL 参照输出 ${n} 行，用例 ${cases.length} 条 —— 有用例的值里带换行\n`);
    process.exit(1);
  }
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
