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
import { workDir } from '../work.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mixedRunner } from '../lib/incr.js';
import { emitJs } from '../../src/core/backend-js/emit.js';
import { emitC } from '../../src/core/backend-c/emit.js';
import { runtimeSources, RUNTIME_DIR } from '../../src/core/runtime/c_runtime.js';
import { listType, dictType } from '../../src/core/hir/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { cache, run: mixedRun } = mixedRunner('oir');
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

// 一条用例可以带 pre：一串前置语句（只求值、不打印），最后那个表达式才是要比的那一行。
// 字节缓冲那类**有状态**的 op 非如此不可 —— 写和读得落在同一格值上，而一个表达式里
// 没有地方存住它。每条用例各套一层 Block，局部名于是不会跨用例撞车（两个后端都按花括号分作用域）。
function moduleOf(items) {
  const body = items.map((it) => {
    const x = it.oir === undefined ? { oir: it } : it;
    return x.pre && x.pre.length
      ? { kind: 'Block', stmts: [...x.pre, printStmt(x.oir)] }
      : printStmt(x.oir);
  });
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
      body: { kind: 'Block', stmts: body },
    }],
    entry: 'omni_main',
  };
}

// ---------------------------------------------------------------- 用例
// 每条给三样东西：名字、OIR 表达式、以及**在 node 里等价的 JS 源码**（参照实现）。
const CASES = [];
const c = (name, oir, jsSrc) => CASES.push({ name, oir, jsSrc });
/** 带前置语句的用例：pre 里的语句先跑，oir 是最后要打印的那个表达式 */
const cp = (name, pre, oir, jsSrc) => CASES.push({ name, pre, oir, jsSrc });
const local = (name, init) => ({ kind: 'Local', name, type: D, init });
const V = (name) => ({ kind: 'VarRef', name, type: D });

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

// 普通对象 / Map / Set。set/add 都返回容器本身，所以能纯表达式地搭出来。
// 数字键那两条是重点：C 侧把键规范化成带标签的字符串，"1" 不能和 1n 撞。
const OBJ = () => js('js_obj_set', [js('js_obj_set', [js('js_obj_new', []), str('a'), real(1)]), str('中'), str('v')]);
const OBJS = 'new Map([["a", 1], ["中", "v"]])';
c('oget', js('js_obj_get', [OBJ(), str('a')]), `${OBJS}.get("a")`);
c('oget/cn', js('js_obj_get', [OBJ(), str('中')]), `${OBJS}.get("中")`);
c('oget/miss', js('js_obj_get', [OBJ(), str('zz')]), `${OBJS}.get("zz")`);
c('ohas', jsBool('js_obj_has', [OBJ(), str('中')]), `${OBJS}.has("中")`);
c('ohas/miss', jsBool('js_obj_has', [OBJ(), str('zz')]), `${OBJS}.has("zz")`);
c('odelete', jsBool('js_obj_delete', [OBJ(), str('a')]), `${OBJS}.delete("a")`);
c('okeys', js('js_arr_join', [js('js_obj_keys', [OBJ()]), str(',')]), `[...${OBJS}.keys()].join(",")`);
c('ovalues', js('js_arr_join', [js('js_obj_values', [OBJ()]), str(',')]), `[...${OBJS}.values()].join(",")`);
c('oentries/len', js('js_arr_len', [js('js_obj_entries', [OBJ()])]), `[...${OBJS}].length`);
c('oentries/k', js('js_arr_get', [js('js_arr_get', [js('js_obj_entries', [OBJ()]), real(1)]), real(0)]), `[...${OBJS}][1][0]`);

const MAP = () => js('js_map_set', [js('js_map_set', [js('js_map_new', []), real(1), str('num')]), str('1'), str('str')]);
const MAPS = 'new Map([[1, "num"], ["1", "str"]])';
c('mget/num', js('js_map_get', [MAP(), real(1)]), `${MAPS}.get(1)`);
c('mget/str', js('js_map_get', [MAP(), str('1')]), `${MAPS}.get("1")`);
c('mget/miss', js('js_map_get', [MAP(), real(2)]), `${MAPS}.get(2)`);
c('msize', js('js_map_size', [MAP()]), `${MAPS}.size`);
c('mhas', jsBool('js_map_has', [MAP(), real(1)]), `${MAPS}.has(1)`);
c('mdelete', jsBool('js_map_delete', [MAP(), str('1')]), `${MAPS}.delete("1")`);
/* keys / values / entries / set 的那几格现在交的是**真迭代器**（ADR-0020：`m.keys().next()`
   与 ES2025 那批 helper 都要接得上），所以 op 一层要先过一遍 js_iter 才是一条 list ——
   参照那一侧写的是 [...m.keys()]，本来就是同一件事。 */
c('mkeys', js('js_arr_join', [js('js_iter', [js('js_map_keys', [MAP()])]), str('|')]), `[...${MAPS}.keys()].join("|")`);
c('mvalues', js('js_arr_join', [js('js_iter', [js('js_map_values', [MAP()])]), str('|')]), `[...${MAPS}.values()].join("|")`);
c('mkeys/tag', js('js_typeof', [js('js_arr_get', [js('js_iter', [js('js_map_keys', [MAP()])]), real(0)])]), `typeof [...${MAPS}.keys()][0]`);

const SET = () => js('js_set_add', [js('js_set_add', [js('js_set_add', [js('js_set_new', []), str('x')]), real(2)]), str('x')]);
const SETS = 'new Set(["x", 2, "x"])';
c('ssize', js('js_set_size', [SET()]), `${SETS}.size`);
c('shas', jsBool('js_set_has', [SET(), real(2)]), `${SETS}.has(2)`);
c('shas/miss', jsBool('js_set_has', [SET(), str('2')]), `${SETS}.has("2")`);
c('sdelete', jsBool('js_set_delete', [SET(), str('x')]), `${SETS}.delete("x")`);
c('sitems', js('js_arr_join', [js('js_iter', [js('js_set_items', [SET()])]), str('|')]), `[...${SETS}].join("|")`);

// 标签分家（普通对象 / Map / Set 三个不同的 DYN 标签）：成员派发要靠标签，但从
// JS 语义看这三样都还是 "object"，而 JSON.stringify 对 Map/Set 一律给 "{}"。
c('tag/map-typeof', js('js_typeof', [MAP()]), `typeof ${MAPS}`);
c('tag/set-typeof', js('js_typeof', [SET()]), `typeof ${SETS}`);
c('tag/obj-typeof', js('js_typeof', [OBJ()]), `typeof ${OBJS}`);
c('tag/map-json', js('js_json_stringify', [MAP(), undef, undef]), `JSON.stringify(${MAPS})`);
c('tag/set-json', js('js_json_stringify', [SET(), undef, undef]), `JSON.stringify(${SETS})`);
c('tag/map-truthy', jsBool('js_truthy', [MAP()]), `${MAPS} ? true : false`);
c('tag/map-ne-obj', jsBool('js_eq', [MAP(), OBJ()], { strict: true }), `${MAPS} === ${OBJS}`);

// 成员派发器（js_p_* / js_m_*，两个后端各自按 js_abi.js 的表生成）。
// 盯的是"同一个成员名落到不同标签上要选对 op"，尤其是 length（list/string）、
// has/delete（Map/Set）、slice 与 indexOf（list 的分支比 string 少吃一个实参）。
const m = (name, args, extra = {}) => js(`js_m_${name}`, args, extra);
const mBool = (name, args) => jsBool(`js_m_${name}`, args);
const p = (name, recv) => js(`js_p_${name}`, [recv]);
const HS = '"héllo"';
const H = () => str('héllo');
c('disp/length-list', p('length', A()), `${AS}.length`);
c('disp/length-str', p('length', H()), `${HS}.length`);
c('disp/size-map', p('size', MAP()), `${MAPS}.size`);
c('disp/size-set', p('size', SET()), `${SETS}.size`);
c('disp/push', m('push', [A(), real(9)]), `${AS}.push(9)`);
c('disp/join', m('join', [A(), str('-')]), `${AS}.join("-")`);
c('disp/slice-list', m('join', [m('slice', [A(), real(1), real(3)]), str(',')]), `${AS}.slice(1, 3).join(",")`);
c('disp/slice-str', m('slice', [H(), real(1), undef]), `${HS}.slice(1)`);
c('disp/indexOf-list', m('indexOf', [A(), real(2), undef]), `${AS}.indexOf(2)`);
c('disp/indexOf-str', m('indexOf', [H(), str('l'), real(4)]), `${HS}.indexOf("l", 4)`);
c('disp/includes-list', mBool('includes', [A(), real(1)]), `${AS}.includes(1)`);
c('disp/includes-str', mBool('includes', [H(), str('é')]), `${HS}.includes("é")`);
c('disp/entries-list', js('js_arr_get', [js('js_arr_get', [js('js_iter', [m('entries', [A()])]), real(1)]), real(1)]), `[...${AS}.entries()][1][1]`);
c('disp/entries-map', js('js_arr_get', [js('js_arr_get', [js('js_iter', [m('entries', [MAP()])]), real(0)]), real(0)]), `[...${MAPS}.entries()][0][0]`);
c('disp/has-map', mBool('has', [MAP(), str('1')]), `${MAPS}.has("1")`);
c('disp/has-set', mBool('has', [SET(), real(2)]), `${SETS}.has(2)`);
c('disp/delete-map', mBool('delete', [MAP(), real(1)]), `${MAPS}.delete(1)`);
c('disp/delete-set', mBool('delete', [SET(), str('x')]), `${SETS}.delete("x")`);
c('disp/get', m('get', [MAP(), real(1)]), `${MAPS}.get(1)`);
c('disp/keys', m('join', [js('js_iter', [m('keys', [MAP()])]), str('|')]), `[...${MAPS}.keys()].join("|")`);
// 大小写只折 ASCII（两个后端同样残缺，见 omni_js_str.c 的注释），所以这条用纯 ASCII
c('disp/upper', m('toUpperCase', [str('hello')]), '"hello".toUpperCase()');
c('disp/trim', m('trim', [str('  x  ')]), '"  x  ".trim()');
c('disp/trimStart', m('trimStart', [str('  x  ')]), '"  x  ".trimStart()');
c('disp/trimEnd', m('trimEnd', [str('  x  ')]), '"  x  ".trimEnd()');
c('disp/startsWith', mBool('startsWith', [H(), str('é'), real(1)]), `${HS}.startsWith("é", 1)`);
c('disp/toString-radix', m('toString', [real(255), real(16)]), '(255).toString(16)');
c('disp/toPrecision', m('toPrecision', [real(1 / 3), real(17)]), '(1/3).toPrecision(17)');
c('disp/charCodeAt', m('charCodeAt', [H(), real(1)]), `${HS}.charCodeAt(1)`);
c('disp/split', m('join', [m('split', [str('a/b/c'), str('/')]), str('|')]), '"a/b/c".split("/").join("|")');

// for-of 的取值面与 o[k]。字符串那条盯的是"按码点不按码元"：😀 是一个码点两个码元。
c('iter/list', m('join', [js('js_iter', [A()]), str('|')]), `[...${AS}].join("|")`);
c('iter/str', p('length', js('js_iter', [str('a😀b')])), '[..."a😀b"].length');
c('iter/str-join', m('join', [js('js_iter', [str('a😀b')]), str('|')]), '[..."a😀b"].join("|")');
c('iter/map', p('length', js('js_iter', [MAP()])), `[...${MAPS}].length`);
c('iter/set', m('join', [js('js_iter', [SET()]), str('|')]), `[...${SETS}].join("|")`);
c('idx/list', js('js_idx_get', [A(), real(1)]), `${AS}[1]`);
c('idx/list-oob', js('js_idx_get', [A(), real(9)]), `${AS}[9]`);
c('idx/str', js('js_idx_get', [H(), real(1)]), `${HS}[1]`);
c('idx/obj', js('js_idx_get', [OBJ(), str('中')]), `${OBJS}.get("中")`);
c('idx/obj-miss', js('js_idx_get', [OBJ(), str('zz')]), `${OBJS}.get("zz")`);
// idx_set 的值是被赋的值（JS 的赋值表达式语义），副作用另外读回来验
c('idxset/value', js('js_idx_set', [A(), real(0), str('x')]), '"x"');
c('idxset/list', js('js_idx_get', [js('js_arr_from', [A()]), real(0)]), `${AS}[0]`);
c('idxset/obj', js('js_idx_get', [OBJ(), str('a')]), `${OBJS}.get("a")`);

// Number / Math。toPrecision(17) 与 toString(8/16) 是自举的关键路径：编译器自己用它们
// 把 double 与字节写进生成的 C，差一个字符两代产出就不一样。
for (const src of ['0', '0.1', '1/3', '-2.5', '1e21', '1e-7', '123456789012345680000', '1.7976931348623157e308']) {
  // eslint-disable-next-line no-eval
  c(`prec17/${src}`, js('js_num_to_precision', [real(eval(src)), real(17)]), `(${src}).toPrecision(17)`);
}
for (const [v, r] of [[0, 16], [255, 16], [8, 8], [0x1f600, 16], [-255, 16], [35, 36], [10, 2]]) {
  c(`radix/${v}/${r}`, js('js_num_to_string', [real(v), real(r)]), `(${v}).toString(${r})`);
}
c('radix/dflt', js('js_num_to_string', [real(2.5), undef]), '(2.5).toString()');
c('isNaN/nan', jsBool('js_num_is_nan', [real(NaN)]), 'Number.isNaN(NaN)');
c('isNaN/str', jsBool('js_num_is_nan', [str('x')]), 'Number.isNaN("x")');
c('isFinite/inf', jsBool('js_num_is_finite', [real(Infinity)]), 'Number.isFinite(Infinity)');
c('isFinite/1', jsBool('js_num_is_finite', [real(1)]), 'Number.isFinite(1)');
c('isInteger/2.5', jsBool('js_num_is_integer', [real(2.5)]), 'Number.isInteger(2.5)');
c('isInteger/2', jsBool('js_num_is_integer', [real(2)]), 'Number.isInteger(2)');
c('isInteger/int', jsBool('js_num_is_integer', [int(2)]), 'Number.isInteger(2n)');
for (const s of ['12', '  12  ', '1.5e3', '', '  ', 'x', '12x', '-7']) {
  c(`Number/${JSON.stringify(s)}`, js('js_num_of', [str(s)]), `Number(${JSON.stringify(s)})`);
}
c('Number/int', js('js_num_of', [int(-5)]), 'Number(-5n)');
c('Number/bool', js('js_num_of', [bool(true)]), 'Number(true)');
c('Number/null', js('js_num_of', [nul]), 'Number(null)');
c('Number/undef', js('js_num_of', [undef]), 'Number(undefined)');
c('BigInt/real', js('js_bigint_of', [real(7)]), 'BigInt(7)');
c('BigInt/str', js('js_bigint_of', [str('-9007199254740993')]), 'BigInt("-9007199254740993")');
c('asIntN', js('js_bigint_as_int_n', [real(64), int(5)]), 'BigInt.asIntN(64, 5n)');
// 窄宽度的 asIntN（枚举成员的编译期回卷用得到：frontend-jnc 的 wrapVal）
const AI = (w, v) => js('js_bigint_as_int_n', [real(w), int(v)]);
const AU = (w, v) => js('js_bigint_as_uint_n', [real(w), int(v)]);
[[8, 255n], [8, 128n], [8, -1n], [8, 127n], [16, 65535n], [16, -32768n],
  [32, 4294967295n], [32, -1n], [64, -1n], [1, 1n], [1, -1n], [0, 7n],
  [63, -1n], [63, 2n ** 62n]].forEach(([w, v]) => {
  c(`asIntN/${w}/${v}`, AI(w, v), `BigInt.asIntN(${w}, ${v}n)`);
});
// asUintN：宽度 64 且原值为负时结果落在 [2^63, 2^64) —— C 侧那一格是 OMNI_DYN_UINT。
// 打印、比较、除、取余、右移、再 asIntN 回来，每一格都要与 node 逐字相同。
[[8, -1n], [8, 255n], [16, -1n], [32, -1n], [63, -1n], [64, -1n], [64, 5n],
  [64, -2n], [64, 2n ** 63n * -1n], [0, 7n], [1, -1n]].forEach(([w, v]) => {
  c(`asUintN/${w}/${v}`, AU(w, v), `BigInt.asUintN(${w}, ${v}n)`);
});
// U(a)/U(b) 与 U(a)%U(b)：interp/builtin.js 的 udiv/umod 就是这一串
c('asUintN/udiv', js('js_bigint_as_int_n',
  [real(64), js('js_arith', [AU(64, -1n), AU(64, 3n)], { op: '/' })]),
  'BigInt.asIntN(64, BigInt.asUintN(64, -1n) / BigInt.asUintN(64, 3n))');
c('asUintN/umod', js('js_bigint_as_int_n',
  [real(64), js('js_arith', [AU(64, -1n), AU(64, 7n)], { op: '%' })]),
  'BigInt.asIntN(64, BigInt.asUintN(64, -1n) % BigInt.asUintN(64, 7n))');
c('asUintN/ucmp', jsBool('js_cmp', [AU(64, 5n), AU(64, -1n)], { op: '<' }),
  'BigInt.asUintN(64, 5n) < BigInt.asUintN(64, -1n)');
c('asUintN/ucmp-rev', jsBool('js_cmp', [AU(64, -1n), AU(64, 5n)], { op: '<' }),
  'BigInt.asUintN(64, -1n) < BigInt.asUintN(64, 5n)');
c('asUintN/ushr', js('js_bitop', [AU(64, -1n), int(60)], { op: '>' }),
  'BigInt.asUintN(64, -1n) >> 60n');
c('asUintN/uand', js('js_bitop', [AU(64, -1n), AU(64, -2n)], { op: '&' }),
  'BigInt.asUintN(64, -1n) & BigInt.asUintN(64, -2n)');
c('asUintN/ueq', jsBool('js_eq', [AU(64, -1n), AU(64, -1n)], { strict: true }),
  'BigInt.asUintN(64, -1n) === BigInt.asUintN(64, -1n)');
c('asUintN/uneq-int', jsBool('js_eq', [AU(64, -1n), int(-1n)], { strict: true }),
  'BigInt.asUintN(64, -1n) === -1n');
c('asUintN/typeof', js('js_typeof', [AU(64, -1n)]), 'typeof BigInt.asUintN(64, -1n)');
// 大 int 之间必须精确比：Number() 在 2^53 以上丢位，从前这两格是错的
c('cmp/int-exact', jsBool('js_cmp', [int(2n ** 62n - 1n), int(2n ** 62n)], { op: '<' }),
  '(2n**62n - 1n) < 2n**62n');
c('cmp/int-exact-eq', jsBool('js_eq', [int(2n ** 62n - 1n), int(2n ** 62n)], { strict: false }),
  '(2n**62n - 1n) == 2n**62n');

// `**`（op 'p'）。int 那一支与 `*` 一样**回卷到 64 位**，所以这里只摆装得下的值：
// 溢出之后与 node 的无界 BigInt 就不同了，那是 ADR-0005 的值语义，对 `*` 也一样。
c('pow/int', js('js_arith', [int(2), int(10)], { op: 'p' }), '2n ** 10n');
c('pow/int-odd', js('js_arith', [int(3), int(5)], { op: 'p' }), '3n ** 5n');
c('pow/int-neg-base', js('js_arith', [int(-2), int(3)], { op: 'p' }), '(-2n) ** 3n');
c('pow/int-zero', js('js_arith', [int(7), int(0)], { op: 'p' }), '7n ** 0n');
c('pow/int-62', js('js_arith', [int(2), int(62)], { op: 'p' }), '2n ** 62n');
c('pow/real', js('js_arith', [real(2), real(0.5)], { op: 'p' }), '2 ** 0.5');
c('pow/real-neg', js('js_arith', [real(2), real(-2)], { op: 'p' }), '2 ** -2');
c('math/max', js('js_math', [real(3), real(7)], { op: 'M' }), 'Math.max(3, 7)');
c('math/max-nan', js('js_math', [real(NaN), real(7)], { op: 'M' }), 'Math.max(NaN, 7)');
c('math/min', js('js_math', [real(3), real(-7)], { op: 'm' }), 'Math.min(3, -7)');
c('math/abs', js('js_math', [real(-3.5), undef], { op: 'a' }), 'Math.abs(-3.5)');
c('math/trunc', js('js_math', [real(-3.9), undef], { op: 't' }), 'Math.trunc(-3.9)');
c('math/floor', js('js_math', [real(-3.1), undef], { op: 'f' }), 'Math.floor(-3.1)');
c('math/ceil', js('js_math', [real(-3.9), undef], { op: 'c' }), 'Math.ceil(-3.9)');

// JSON.stringify。参照那边用普通对象/数组字面量，这边用 js_obj_set 链 —— 两种表示
// 印出来必须一样，这正是要验的那件事。
const J = (v, rep = undef, ind = undef) => js('js_json_stringify', [v, rep, ind]);
for (const s of ['x', 'a"b', 'a\\b', 'tab\there', '中文', 'a\u{1f600}b', '\u0001\u001f', '\ud800',
                 '\udc00', 'a\ud800\ud800\udc00b', '\ud800\udc00\udc00']) {
  c(`json/str/${JSON.stringify(s)}`, J(str(s)), `JSON.stringify(${JSON.stringify(s)})`);
}
c('json/num', J(real(2.5)), 'JSON.stringify(2.5)');
c('json/nan', J(real(NaN)), 'JSON.stringify(NaN)');
c('json/inf', J(real(Infinity)), 'JSON.stringify(Infinity)');
c('json/null', J(nul), 'JSON.stringify(null)');
c('json/bool', J(bool(false)), 'JSON.stringify(false)');
c('json/undef', J(undef), 'String(JSON.stringify(undefined))');
c('json/arr', J(arr(real(1), str('a'), nul)), 'JSON.stringify([1, "a", null])');
c('json/arr-undef', J(arr(real(1), undef)), 'JSON.stringify([1, undefined])');
c('json/arr-empty', J(arr()), 'JSON.stringify([])');
c('json/obj', J(OBJ()), 'JSON.stringify({"a": 1, "中": "v"})');
c('json/obj-empty', J(js('js_obj_new', [])), 'JSON.stringify({})');
c('json/obj-undef', J(js('js_obj_set', [js('js_obj_new', []), str('k'), undef])), 'JSON.stringify({"k": undefined})');
c('json/nested', J(js('js_obj_set', [js('js_obj_new', []), str('xs'), arr(real(1), OBJ())])),
  'JSON.stringify({"xs": [1, {"a": 1, "中": "v"}]})');
// 带缩进的结果有换行，会破掉"一条用例一行"的约定，所以再套一层 stringify 把它引起来
c('json/indent', J(J(js('js_obj_set', [js('js_obj_new', []), str('xs'), arr(real(1), real(2))]), undef, real(2))),
  'JSON.stringify(JSON.stringify({"xs": [1, 2]}, null, 2))');
c('json/indent-nested', J(J(js('js_obj_set', [js('js_obj_new', []), str('o'), OBJ()]), undef, real(2))),
  'JSON.stringify(JSON.stringify({"o": {"a": 1, "中": "v"}}, null, 2))');

// parse：读回来的是这个值域里的值（对象是 dict、数一律是 real），一行放不下，所以再
// stringify 一遍来比 —— 参照侧同样是 JSON.stringify(JSON.parse(t))，来回一趟必须逐字相同。
function jp(t) {
  c(`json/parse/${JSON.stringify(t)}`, J(js('js_json_parse', [str(t)])),
    `JSON.stringify(JSON.parse(${JSON.stringify(t)}))`);
}
['1', '-1', '0', '-0', '2.5', '1e3', '1E3', '-1.5e-3', '1e+2', '0.5', '1e309',
  '123456789012345678901234567890', '0.1', '3.141592653589793'].forEach(jp);
['""', '"a"', '"a\\nb"', '"\\u4e2d"', '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\ud800"', '"中"'].forEach(jp);
['true', 'false', 'null'].forEach(jp);
['[]', '[1]', '[1,2,3]', '[1,"a",null,[2,[3]]]', '[[]]'].forEach(jp);
['{}', '{"a":1}', '{"a":1,"b":[1,2],"中":"v"}', '{"o":{"p":[{"q":true}]}}'].forEach(jp);
// 空白：值前后、逗号与冒号两边都许有。重复的键后来的赢，位置留在第一次出现的地方。
[' \t\r\n1 ', ' { "a" : 1 , "b" : [ 1 , 2 ] } ', '{"a":1,"a":2}', '{"b":1,"a":2,"b":3}'].forEach(jp);
// parse 的实参先按 JS 的口径转字符串：JSON.parse(5) 是 5
c('json/parse/of-real', J(js('js_json_parse', [real(5)])), 'JSON.stringify(JSON.parse(5))');
c('json/parse/of-bool', J(js('js_json_parse', [bool(true)])), 'JSON.stringify(JSON.parse(true))');

// ---------------------------------------------------------------- RegExp
// 模式与 flags 是 JS 域的字符串（正则字面量降下来是个带 source/flags 的对象，
// 那两个字段是运行期取出来的），所以两侧都按内容做编译缓存，不按字面量身份。
// 参照侧统一用 new RegExp(...) 而不是字面量，省掉一层转义。
const P = (v) => JSON.stringify(v);
const RE = (p, f) => `new RegExp(${P(p)}, ${P(f)})`;
function reTest(p, f, s) {
  c(`re/test/${p}${f && `|${f}`}|${P(s)}`, jsBool('js_re_test', [str(p), str(f), str(s)]),
    `${RE(p, f)}.test(${P(s)})`);
}
function reMatch(p, f, s) {
  c(`re/match/${p}|${f}|${P(s)}`, J(js('js_re_match', [str(p), str(f), str(s)])),
    `JSON.stringify(${P(s)}.match(${RE(p, f)}))`);
}
function reSplit(p, f, s, lim) {
  c(`re/split/${p}|${f}|${P(s)}${lim === undefined ? '' : `|${lim}`}`,
    J(js('js_re_split', [str(p), str(f), str(s), lim === undefined ? undef : real(lim)])),
    `JSON.stringify(${P(s)}.split(${RE(p, f)}${lim === undefined ? '' : `, ${lim}`}))`);
}
function reReplace(p, f, s, r) {
  c(`re/replace/${p}|${f}|${P(s)}|${P(r)}`,
    J(js('js_re_replace', [str(p), str(f), str(s), str(r)])),
    `JSON.stringify(${P(s)}.replace(${RE(p, f)}, ${P(r)}))`);
}

reTest('[;}]$', '', 'x;');
reTest('[;}]$', '', 'x');
reTest('^[+-]?[0-9]+$', '', '-123');
reTest('^[+-]?[0-9]+$', '', '12a');
reTest('^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$', '', '.5e-3');
reTest('^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$', '', '1e');
reTest('^[A-Za-z_][A-Za-z0-9_-]*$', '', '_a-b9');
reTest('^\\.\\.?/', '', '../x');
reTest('^[0-9a-fA-F]{2}$', '', '0F');
reTest('^[0-9a-fA-F]{2}$', 'i', '0f');
reTest('^[0-9a-fA-F]{1,6}$', '', 'abcdef');
reTest('://', '', 'http://x');
reTest('^a', 'm', 'b\va');
reTest('^[A-Za-z_$][A-Za-z0-9_$]*$', '', '$x1');
// \b / \B（零宽断言）。REPL 的"像不像表达式"判断就用它 —— 原先 C 侧当场报错，
// 于是自举出来的编译器一进 repl 的回显就挂（\b 在索引 98 那一条）。
reTest('^(if|else|while|return)\\b', '', 'return x');
reTest('^(if|else|while|return)\\b', '', 'returnish');
reTest('\\bcat\\b', '', 'a cat sat');
reTest('\\bcat\\b', '', 'concatenate');
reTest('\\Bcat', '', 'concat');
reTest('\\Bcat', '', 'cat');
reTest('\\bx', '', 'x');
reTest('x\\b', '', 'x');
reTest('\\b_', '', '_a');
reTest('[\\b]', '', 'a\bb');
reMatch('\\b\\w+\\b', 'g', 'one two, three!');
reReplace('\\bfoo\\b', 'g', 'foo food foo', 'X');
reSplit('\\b', '', 'ab cd');

reMatch("'", 'g', "a'b'c");
reMatch("'", 'g', 'abc');
reMatch('[0-9]+', 'g', 'a12b345');
reMatch('x*', 'g', 'axb');

// 正则当值 + exec（ADR-0011 决策 10 的第二半）。结果是一格 list（整体匹配在 0、
// 捕获组依次在后），所以拿 stringify 比；参照侧同样是 new RegExp(...).exec(...)。
// 注意 exec 的结果在 node 那边还挂着 index/input，stringify 不印它们 —— 正是这个值域
// 里取不到的那两个，所以这个判据不会偷偷放过差别。
const REV = (p, f) => js('js_re_new', [str(p), str(f)]);
function reExec(p, f, s) {
  c(`re/exec/${p}|${f}|${P(s)}`, J(js('js_re_exec', [REV(p, f), str(s)])),
    `JSON.stringify(${RE(p, f)}.exec(${P(s)}))`);
}
reExec('[0-9]+', '', 'a12b');
reExec('[0-9]+', '', 'abc');
reExec('[0-9]+', 'g', 'a12b');
reExec('^\\s*\\((fn|cfn|class)\\s+([A-Za-z_$][\\w$]*)', '', '  (fn foo (x)');
reExec('^(?:function|const|let|var)\\s+([A-Za-z_$][\\w$]*)', '', 'const $x1 = 1;');
reExec('(a)|(b)', '', 'b');
reExec('x*', 'g', 'axb');

reSplit('\\s+', '', 'a b  c');
reSplit('\\s+', '', 'a b  c', 2);
reSplit('\\s+', '', '  a b');
reSplit(',', '', 'a,b,,c');
reSplit('(,)', '', 'a,b');
reSplit('x', '', '');
reSplit('', '', 'abc');
reSplit('[;}]', '', 'a;b}c', 0);

reReplace('_', 'g', 'a_b_c', '');
reReplace('0+$', '', '1.2300', '');
reReplace('n$', '', '12n', '');
reReplace('\\.omni$', '', 'x.omni', '');
reReplace('(a)(b)', '', 'zab', '[$2$1]');
reReplace('a', 'g', 'aaa', '$$');
reReplace('b', '', 'abc', '<$&>');
reReplace('b', '', 'abc', '[$`|$\']');
reReplace('x*', 'g', 'abc', '-');
reReplace('^', 'gm', 'a\vb', '> ');
reReplace('(z)?a', '', 'ba', '[$1]');

// -------------------------------------------- 字符串/数组的其余缺口（量出来的四个）
const SPL = (s, sep) => J(js('js_str_split', [str(s), str(sep)]));
c('split/str/slash', SPL('a/b/c', '/'), 'JSON.stringify("a/b/c".split("/"))');
c('split/str/none', SPL('abc', '/'), 'JSON.stringify("abc".split("/"))');
c('split/str/empty-sep', SPL('a中b', ''), 'JSON.stringify("a中b".split(""))');
c('split/str/adjacent', SPL('a,,b', ','), 'JSON.stringify("a,,b".split(","))');
c('split/str/edges', SPL(',a,', ','), 'JSON.stringify(",a,".split(","))');
c('split/str/empty-input', SPL('', ','), 'JSON.stringify("".split(","))');
c('split/str/multi', SPL('a::b', '::'), 'JSON.stringify("a::b".split("::"))');

const BYTES = (s) => J(js('js_utf8_bytes', [str(s)]));
c('utf8/ascii', BYTES('AZ'), 'JSON.stringify([...new TextEncoder().encode("AZ")])');
c('utf8/cjk', BYTES('中'), 'JSON.stringify([...new TextEncoder().encode("中")])');
c('utf8/astral', BYTES('a\u{1f600}'), 'JSON.stringify([...new TextEncoder().encode("a\u{1f600}")])');
c('utf8/lone-surrogate', BYTES('\ud800'), 'JSON.stringify([...new TextEncoder().encode("\\ud800")])');

const PI = (s, r) => js('js_num_parse_int', [str(s), r === undefined ? undef : real(r)]);
c('parseInt/hex', PI('ff', 16), 'parseInt("ff", 16)');
c('parseInt/hex-upper', PI('7F', 16), 'parseInt("7F", 16)');
c('parseInt/dec', PI('42', 10), 'parseInt("42", 10)');
c('parseInt/trailing', PI('12abc', 10), 'parseInt("12abc", 10)');
c('parseInt/none', PI('zz', 10), 'parseInt("zz", 10)');
c('parseInt/sign', PI('-1f', 16), 'parseInt("-1f", 16)');
c('parseInt/space', PI('  7 ', 10), 'parseInt("  7 ", 10)');
c('parseInt/no-radix', PI('0x1f'), 'parseInt("0x1f")');
c('parseInt/no-radix-dec', PI('08'), 'parseInt("08")');
c('parseInt/0x-with-16', PI('0x1f', 16), 'parseInt("0x1f", 16)');
c('parseInt/empty', PI('', 10), 'parseInt("", 10)');

c('arr/entries', J(js('js_iter', [js('js_arr_entries', [arr(str('a'), real(2), nul)])])),
  'JSON.stringify([...["a", 2, null].entries()])');
c('arr/entries-empty', J(js('js_iter', [js('js_arr_entries', [arr()])])), 'JSON.stringify([...[].entries()])');
// new Array(n)：长度 n、每格 undefined（stringify 里印成 null，与宿主的洞数组一致）。
// 实参不是数时就是那一格元素。fill 是现成的 op，串起来才是源码里真正用的那一句。
c('arr/new-n', J(js('js_arr_new_n', [real(3)])), 'JSON.stringify(new Array(3))');
c('arr/new-n-0', J(js('js_arr_new_n', [real(0)])), 'JSON.stringify(new Array(0))');
c('arr/new-n-str', J(js('js_arr_new_n', [str('x')])), 'JSON.stringify(new Array("x"))');
c('arr/new-n-fill', J(js('js_arr_fill', [js('js_arr_new_n', [real(4)]), real(-1)])),
  'JSON.stringify(new Array(4).fill(-1))');
c('arr/new-n-len', js('js_arr_len', [js('js_arr_new_n', [real(5)])]), 'new Array(5).length');

// ------------------------- 字节缓冲（ADR-0011：ArrayBuffer 与它上面的 Uint8Array/DataView）
// 这一格里三者是**同一种值**（一个 {p,len} 视图），所以参照侧写 ArrayBuffer 也好、
// Uint8Array 也好、DataView 也好，在这边都落到同一批 op 上。判据有三样：
//   1) 长度与视图的截法；2) 别名 —— 两个视图落在同一块内存上，改一个另一个看得见；
//   3) 字节序 —— 同一个 int64 写下去，le 与 be 的第 0 个字节必须不同。第 3 条最要紧：
//      两侧都是显式按字节拼的，所以这个结果不能跟着机器变。
const AB = (n) => js('js_buf_new', [real(n)]);
const U8N = (n) => js('js_buf_view', [real(n), undef, undef]);
const VIEW = (b, o, l) => js('js_buf_view', [b,
  o === undefined ? undef : real(o), l === undefined ? undef : real(l)]);
const BLEN = (b) => js('js_buf_len', [b]);
const FILL = (b, v) => js('js_buf_fill', [b, real(v)]);
const G8 = (b, at) => js('js_buf_get_u8', [b, real(at)]);
const S8 = (b, at, v) => stmt(js('js_buf_set_u8', [b, real(at), real(v)]));
const GI = (b, at, le) => js('js_buf_get_i64', [b, real(at), bool(le)]);
const SI = (b, at, v, le) => stmt(js('js_buf_set_i64', [b, real(at), int(v), bool(le)]));
const GF = (b, at, le) => js('js_buf_get_f64', [b, real(at), bool(le)]);
const SF = (b, at, v, le) => stmt(js('js_buf_set_f64', [b, real(at), real(v), bool(le)]));
/** 把一段字节接成字符串（一条用例只有一行，逐字节比才看得出是哪一位错了） */
const BSTR = (b, from, n) => {
  let e = str('');
  for (let i = 0; i < n; i++) e = js('js_add', [e, js('js_buf_get_u8', [b, real(from + i)])]);
  return e;
};
const RBSTR = (d, from, n) => {
  let s = '""';
  for (let i = 0; i < n; i++) s += ` + ${d}.getUint8(${from + i})`;
  return s;
};

c('buf/ab-len', BLEN(AB(8)), 'new ArrayBuffer(8).byteLength');
c('buf/ab-len-0', BLEN(AB(0)), 'new ArrayBuffer(0).byteLength');
c('buf/len-is-number', js('js_typeof', [BLEN(AB(2))]), 'typeof new ArrayBuffer(2).byteLength');
c('buf/typeof', js('js_typeof', [AB(1)]), 'typeof new ArrayBuffer(1)');
c('buf/u8-len', BLEN(U8N(5)), 'new Uint8Array(5).length');
c('buf/u8-len-0', BLEN(U8N(0)), 'new Uint8Array(0).length');
c('buf/view-len', BLEN(VIEW(AB(8), 2)), 'new Uint8Array(new ArrayBuffer(8), 2).length');
c('buf/view-len-3', BLEN(VIEW(AB(8), 2, 3)), 'new Uint8Array(new ArrayBuffer(8), 2, 3).length');
c('buf/view-of-view', BLEN(VIEW(VIEW(AB(8), 2), 1, 2)),
  'new Uint8Array(new Uint8Array(new ArrayBuffer(8), 2).buffer, 3, 2).length');
c('buf/zeroed', BSTR(U8N(4), 0, 4), RBSTR('new DataView(new Uint8Array(4).buffer)', 0, 4));
c('buf/fill', BSTR(FILL(U8N(3), 255), 0, 3), RBSTR('new DataView(new Uint8Array(3).fill(255).buffer)', 0, 3));
c('buf/fill-trunc', G8(FILL(U8N(2), 300), 0), 'new Uint8Array(2).fill(300)[0]');
c('buf/fill-neg', G8(FILL(U8N(2), -1), 0), 'new Uint8Array(2).fill(-1)[0]');
c('buf/fill-frac', G8(FILL(U8N(2), 1.9), 0), 'new Uint8Array(2).fill(1.9)[0]');
c('buf/fill-ret-len', BLEN(FILL(U8N(3), 0)), 'new Uint8Array(3).fill(0).length');
// fill 只碰视图自己那一段：外面那两个字节必须还是 0
cp('buf/fill-view-only', [local('u', AB(4)), stmt(js('js_buf_fill', [VIEW(V('u'), 1, 2), real(7)]))],
  BSTR(V('u'), 0, 4),
  '(() => { const u = new ArrayBuffer(4); new Uint8Array(u, 1, 2).fill(7);'
  + ` const d = new DataView(u); return ${RBSTR('d', 0, 4)}; })()`);

cp('buf/set-get-u8', [local('b', U8N(4)), S8(V('b'), 1, 7)], G8(V('b'), 1),
  '(() => { const d = new DataView(new ArrayBuffer(4)); d.setUint8(1, 7); return d.getUint8(1); })()');
cp('buf/set-u8-trunc', [local('b', U8N(2)), S8(V('b'), 0, 258)], G8(V('b'), 0),
  '(() => { const d = new DataView(new ArrayBuffer(2)); d.setUint8(0, 258); return d.getUint8(0); })()');
cp('buf/set-u8-last', [local('b', U8N(3)), S8(V('b'), 2, 1)], BSTR(V('b'), 0, 3),
  '(() => { const d = new DataView(new ArrayBuffer(3)); d.setUint8(2, 1);'
  + ` return ${RBSTR('d', 0, 3)}; })()`);

// 字节序：同一个值写下去，两种排法的字节必须真的不同
const DV8 = 'const d = new DataView(new ArrayBuffer(8));';
cp('buf/i64-be-bytes', [local('b', AB(8)), SI(V('b'), 0, 0x0102030405060708n, false)], BSTR(V('b'), 0, 8),
  `(() => { ${DV8} d.setBigInt64(0, 0x0102030405060708n, false); return ${RBSTR('d', 0, 8)}; })()`);
cp('buf/i64-le-bytes', [local('b', AB(8)), SI(V('b'), 0, 0x0102030405060708n, true)], BSTR(V('b'), 0, 8),
  `(() => { ${DV8} d.setBigInt64(0, 0x0102030405060708n, true); return ${RBSTR('d', 0, 8)}; })()`);
cp('buf/i64-be-round', [local('b', AB(8)), SI(V('b'), 0, 0x0102030405060708n, false)], GI(V('b'), 0, false),
  `(() => { ${DV8} d.setBigInt64(0, 0x0102030405060708n, false); return d.getBigInt64(0, false); })()`);
cp('buf/i64-le-round', [local('b', AB(8)), SI(V('b'), 0, -1234567890123n, true)], GI(V('b'), 0, true),
  `(() => { ${DV8} d.setBigInt64(0, -1234567890123n, true); return d.getBigInt64(0, true); })()`);
cp('buf/i64-neg-bytes', [local('b', AB(8)), SI(V('b'), 0, -2n, false)], BSTR(V('b'), 0, 8),
  `(() => { ${DV8} d.setBigInt64(0, -2n, false); return ${RBSTR('d', 0, 8)}; })()`);
cp('buf/i64-min', [local('b', AB(8)), SI(V('b'), 0, -(2n ** 63n), false)], GI(V('b'), 0, false),
  `(() => { ${DV8} d.setBigInt64(0, -(2n ** 63n), false); return d.getBigInt64(0, false); })()`);
cp('buf/i64-max', [local('b', AB(8)), SI(V('b'), 0, 2n ** 63n - 1n, true)], GI(V('b'), 0, true),
  `(() => { ${DV8} d.setBigInt64(0, 2n ** 63n - 1n, true); return d.getBigInt64(0, true); })()`);
// 写 be 读 le：结果是字节反过来的那个数，两侧必须都错得一样
cp('buf/i64-cross', [local('b', AB(8)), SI(V('b'), 0, 258n, false)], GI(V('b'), 0, true),
  `(() => { ${DV8} d.setBigInt64(0, 258n, false); return d.getBigInt64(0, true); })()`);
cp('buf/i64-at-8', [local('b', AB(16)), SI(V('b'), 8, 77n, false)], GI(V('b'), 8, false),
  '(() => { const d = new DataView(new ArrayBuffer(16)); d.setBigInt64(8, 77n, false);'
  + ' return d.getBigInt64(8, false); })()');
cp('buf/i64-typeof', [local('b', AB(8)), SI(V('b'), 0, 1n, false)], js('js_typeof', [GI(V('b'), 0, false)]),
  `(() => { ${DV8} d.setBigInt64(0, 1n, false); return typeof d.getBigInt64(0, false); })()`);

cp('buf/f64-le-round', [local('b', AB(8)), SF(V('b'), 0, 0.1, true)], GF(V('b'), 0, true),
  `(() => { ${DV8} d.setFloat64(0, 0.1, true); return d.getFloat64(0, true); })()`);
cp('buf/f64-be-bytes', [local('b', AB(8)), SF(V('b'), 0, 0.1, false)], BSTR(V('b'), 0, 8),
  `(() => { ${DV8} d.setFloat64(0, 0.1, false); return ${RBSTR('d', 0, 8)}; })()`);
cp('buf/f64-le-bytes', [local('b', AB(8)), SF(V('b'), 0, 0.1, true)], BSTR(V('b'), 0, 8),
  `(() => { ${DV8} d.setFloat64(0, 0.1, true); return ${RBSTR('d', 0, 8)}; })()`);
cp('buf/f64-neg-round', [local('b', AB(8)), SF(V('b'), 0, -1.5e308, false)], GF(V('b'), 0, false),
  `(() => { ${DV8} d.setFloat64(0, -1.5e308, false); return d.getFloat64(0, false); })()`);
cp('buf/f64-int-round', [local('b', AB(8)), SF(V('b'), 0, 3, true)], GF(V('b'), 0, true),
  `(() => { ${DV8} d.setFloat64(0, 3, true); return d.getFloat64(0, true); })()`);
cp('buf/f64-typeof', [local('b', AB(8)), SF(V('b'), 0, 1, true)], js('js_typeof', [GF(V('b'), 0, true)]),
  `(() => { ${DV8} d.setFloat64(0, 1, true); return typeof d.getFloat64(0, true); })()`);

// 别名：两个视图落在同一块内存上（interp/builtin.js 的指针 arena 就靠这个）
cp('buf/alias-view-sees-write',
  [local('u', AB(8)), local('v', VIEW(V('u'), 4, 4)), S8(V('u'), 5, 3)], G8(V('v'), 1),
  '(() => { const u = new ArrayBuffer(8); const v = new Uint8Array(u, 4, 4);'
  + ' new DataView(u).setUint8(5, 3); return v[1]; })()');
cp('buf/alias-i64-through-view',
  [local('u', AB(8)), local('v', VIEW(V('u'), 0, 8)), SI(V('v'), 0, 0x0a0b0c0d0e0f1011n, false)],
  BSTR(V('u'), 0, 8),
  '(() => { const u = new ArrayBuffer(8); new DataView(u, 0, 8).setBigInt64(0, 0x0a0b0c0d0e0f1011n, false);'
  + ` const d = new DataView(u); return ${RBSTR('d', 0, 8)}; })()`);
cp('buf/set-copies',
  [local('u', AB(8)), local('a', VIEW(V('u'), 0, 4)), local('b', VIEW(V('u'), 4, 4)),
    stmt(js('js_buf_fill', [V('a'), real(9)])), stmt(js('js_buf_set', [V('b'), V('a')]))],
  BSTR(V('u'), 0, 8),
  '(() => { const u = new ArrayBuffer(8); const a = new Uint8Array(u, 0, 4); const b = new Uint8Array(u, 4, 4);'
  + ` a.fill(9); b.set(a); const d = new DataView(u); return ${RBSTR('d', 0, 8)}; })()`);
// 重叠的 .set：必须像 memmove 一样先读后写，逐字节向前抄会把源自己抹掉
cp('buf/set-overlap',
  [local('u', AB(8)), local('a', VIEW(V('u'), 0, 4)), local('b', VIEW(V('u'), 2, 4)),
    S8(V('u'), 0, 1), S8(V('u'), 1, 2), S8(V('u'), 2, 3), S8(V('u'), 3, 4),
    stmt(js('js_buf_set', [V('b'), V('a')]))],
  BSTR(V('u'), 0, 8),
  '(() => { const u = new ArrayBuffer(8); const a = new Uint8Array(u, 0, 4); const b = new Uint8Array(u, 2, 4);'
  + ` a.set([1, 2, 3, 4]); b.set(a); const d = new DataView(u); return ${RBSTR('d', 0, 8)}; })()`);
cp('buf/set-shorter',
  [local('u', AB(4)), local('a', VIEW(V('u'), 0, 2)), stmt(js('js_buf_fill', [V('a'), real(5)])),
    local('t', U8N(4)), stmt(js('js_buf_set', [V('t'), V('a')]))],
  BSTR(V('t'), 0, 4),
  '(() => { const u = new ArrayBuffer(4); const a = new Uint8Array(u, 0, 2); a.fill(5);'
  + ` const t = new Uint8Array(4); t.set(a); const d = new DataView(t.buffer); return ${RBSTR('d', 0, 4)}; })()`);

// TextEncoder：无状态，但 new TextEncoder().encode(t) 是两步，所以那一格也得有个值
const ENC = (s) => js('js_text_encode', [js('js_text_enc_new', []), str(s)]);
const RENC = (s) => `new TextEncoder().encode(${s})`;
c('text/typeof', js('js_typeof', [js('js_text_enc_new', [])]), 'typeof new TextEncoder()');
c('text/enc-len-ascii', BLEN(ENC('AZ')), `${RENC('"AZ"')}.length`);
c('text/enc-len-empty', BLEN(ENC('')), `${RENC('""')}.length`);
c('text/enc-len-cjk', BLEN(ENC('中a')), `${RENC('"中a"')}.length`);
c('text/enc-len-astral', BLEN(ENC('a\u{1f600}')), `${RENC('"a\u{1f600}"')}.length`);
c('text/enc-bytes-cjk', BSTR(ENC('中'), 0, 3), RBSTR(`new DataView(${RENC('"中"')}.buffer)`, 0, 3));
c('text/enc-bytes-astral', BSTR(ENC('\u{1f600}'), 0, 4),
  RBSTR(`new DataView(${RENC('"\u{1f600}"')}.buffer)`, 0, 4));
// 孤立代理：宿主换成 U+FFFD，我们这边也必须是同一个三字节
c('text/enc-lone-surrogate', BSTR(ENC('\ud800'), 0, 3),
  RBSTR(`new DataView(${RENC('"\\ud800"')}.buffer)`, 0, 3));
c('text/enc-then-view', BLEN(VIEW(ENC('中a'), 1, 2)),
  `new Uint8Array(${RENC('"中a"')}.buffer, 1, 2).length`);

// ---------------------------------------------------------------- node 宿主面
// 三个进程（ref.mjs / out.mjs / a.out）是**顺序**跑的，cwd 都是仓库根，所以
// "同一个固定路径先写后读"这种跨用例的状态是各自独立且一致的。
const TMP = js('js_os_tmpdir', []);
const PATH1 = js('js_add', [TMP, str('/omni-oir-host-1.txt')]);
const PATH2 = js('js_add', [TMP, str('/omni-oir-host-2.txt')]);
const JTMP = 'require("node:os").tmpdir()';
const REF_OS = 'process.getBuiltinModule("node:os").tmpdir()';
const REF_FS = 'process.getBuiltinModule("node:fs")';
const P1 = `(${REF_OS} + "/omni-oir-host-1.txt")`;
const P2 = `(${REF_OS} + "/omni-oir-host-2.txt")`;
void JTMP;

c('host/write', js('js_fs_write_text', [PATH1, str('hi中\n')]),
  `(${REF_FS}.writeFileSync(${P1}, "hi中\\n"), undefined)`);
c('host/read', J(js('js_fs_read_text', [PATH1])),
  `JSON.stringify(${REF_FS}.readFileSync(${P1}, "utf8"))`);
c('host/size', js('js_fs_size', [PATH1]), `${REF_FS}.statSync(${P1}).size`);
c('host/exists', jsBool('js_fs_exists', [PATH1]), `${REF_FS}.existsSync(${P1})`);
c('host/exists-not', jsBool('js_fs_exists', [js('js_add', [PATH1, str('.nope')])]),
  `${REF_FS}.existsSync(${P1} + ".nope")`);
c('host/mtime-type', js('js_typeof', [js('js_fs_mtime_ms', [PATH1])]),
  `typeof ${REF_FS}.statSync(${P1}).mtimeMs`);
c('host/rename', js('js_fs_rename', [PATH1, PATH2]),
  `(${REF_FS}.renameSync(${P1}, ${P2}), undefined)`);
c('host/renamed-gone', jsBool('js_fs_exists', [PATH1]), `${REF_FS}.existsSync(${P1})`);
c('host/renamed-read', J(js('js_fs_read_text', [PATH2])),
  `JSON.stringify(${REF_FS}.readFileSync(${P2}, "utf8"))`);

// 读一个满是中文注释的真文件：码元口径的长度对上，说明 UTF-8 -> UTF-16 两侧一致
c('host/read-len', js('js_str_len', [js('js_fs_read_text', [str('src/runtime/omni.h')])]),
  `${REF_FS}.readFileSync("src/runtime/omni.h", "utf8").length`);
c('host/readdir', J(js('js_arr_sort', [js('js_fs_readdir', [str('src/runtime')]), undef])),
  `JSON.stringify(${REF_FS}.readdirSync("src/runtime").sort())`);
c('host/realpath', js('js_fs_realpath', [str('src/runtime')]),
  `${REF_FS}.realpathSync("src/runtime")`);
// mkdtemp 的结果是随机的，能对照的是长度（前缀相同 + 六个随机字符）
c('host/mkdtemp-len', js('js_str_len', [js('js_fs_mkdtemp', [js('js_add', [TMP, str('/omni-oir-')])])]),
  `${REF_FS}.mkdtempSync(${REF_OS} + "/omni-oir-").length`);

c('host/cwd', js('js_proc_cwd', []), 'process.cwd()');
c('host/tmpdir', TMP, REF_OS);
c('host/args', J(js('js_proc_args', [])), 'JSON.stringify(process.argv.slice(2))');
c('host/env', js('js_typeof', [js('js_proc_env', [str('PATH')])]), 'typeof process.env.PATH');
c('host/env-missing', js('js_typeof', [js('js_proc_env', [str('OMNI_NO_SUCH_VAR')])]),
  'typeof process.env.OMNI_NO_SUCH_VAR');
c('host/exit-code-0', js('js_proc_exit_code', [real(0)]), '(process.exitCode = 0, undefined)');
c('host/stdin-tty', jsBool('js_proc_stdin_is_tty', []), 'process.stdin.isTTY === true');
c('host/read-line-eof', js('js_typeof', [js('js_proc_read_line', [])]), '"undefined"');
// 写一段不带换行的东西，再由 println 补上行尾：一条用例还是一行
c('host/stdout-write', js('js_proc_stdout_write', [str('sw')]),
  '(process.stdout.write("sw"), undefined)');
c('host/install-dir', js('js_install_dir', []),
  '(() => { const p = process.argv[1]; const i = p.lastIndexOf("/"); return i < 0 ? "." : (i === 0 ? "/" : p.slice(0, i)); })()');

const SPAWN = (cmd, args, mode) =>
  J(js('js_proc_spawn', [str(cmd), box({ kind: 'ListLit', type: listType(D), items: args.map(str) }), str(mode)]));
c('host/spawn-echo', SPAWN('echo', ['hi'], 'c'),
  'JSON.stringify((() => { const r = process.getBuiltinModule("node:child_process")'
  + '.spawnSync("echo", ["hi"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });'
  + ' return [r.status, r.stdout, r.stderr]; })())');
c('host/spawn-false', SPAWN('false', [], 'c'),
  'JSON.stringify((() => { const r = process.getBuiltinModule("node:child_process")'
  + '.spawnSync("false", [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });'
  + ' return [r.status, r.stdout, r.stderr]; })())');


// ---------------------------------------------- throw / try（ADR-0007 决定 1）
// 这一层只有"待处理错误"的槽本身：throw 放、pending 查、take 取出并清空。
// 跳转形状（try/catch/finally 降成普通控制流）是 lower.js 的事，在 js-roundtrip 轴上验。
// 三个进程都是从"没有待处理错误"开始，用例之间的状态变化是有序的。
c('throw/pending-clean', jsBool('js_pending', []), 'false');
c('throw/set', js('js_throw', [str('boom')]), '"undefined"');
c('throw/pending-after', jsBool('js_pending', []), 'true');
c('throw/take', js('js_take_pending', []), '"boom"');
c('throw/pending-cleared', jsBool('js_pending', []), 'false');
c('throw/take-empty', js('js_typeof', [js('js_take_pending', [])]), '"undefined"');
c('throw/non-string', js('js_typeof', [js('js_throw', [arr(real(1))])]), '"undefined"');
c('throw/take-obj', J(js('js_take_pending', [])), 'JSON.stringify([1])');


/* node 那几次走 RunCache（只记依赖、不缓存，ADR-0023 的 S7）：这条轴要的是"这一趟到底装了
   哪些模块"，轴级指纹按它算才精确 —— 不然改任何一门语言的前端都会把这条轴带着重跑。
   别的命令（`echo` / `false` 那两格探针）照旧原样跑。 */
function run(cmd, args, opts = {}) {
  const r = mixedRun(cmd, args, { cwd: root, ...opts });
  return { out: r.out, err: r.err, code: r.status === null ? -1 : r.status };
}

const cases = CASES.filter((x) => !filters.length || filters.some((f) => x.name.includes(f)));
const dir = workDir('oir');

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
  const n = ref.out === '' ? 0 : ref.out.replace(/\n$/, '').split('\n').length;
  if (n !== cases.length) {
    process.stdout.write(`  FAIL 参照输出 ${n} 行，用例 ${cases.length} 条 —— 有用例的值里带换行\n`);
    process.exit(1);
  }
}

const mod = moduleOf(cases);
const jsPath = join(dir, 'out.mjs');
writeFileSync(jsPath, emitJs(mod));
const viaJs = run(process.execPath, [jsPath]);

const cPath = join(dir, 'out.c');
writeFileSync(cPath, emitC(mod));
const exe = join(dir, 'a.out');
const cc = ['clang', 'cc', 'gcc'].find((x) => run('which', [x]).code === 0);
const build = run(cc, ['-std=c99', '-O1', '-pthread', `-I${RUNTIME_DIR}`, cPath, ...runtimeSources(), '-o', exe, '-lm']);
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

// 未捕获的错误：不是"一行输出"能表达的（要看 stderr 与退出码），所以单独编一个模块。
// 宿主里未捕获的异常会打栈回溯，C 侧打不出同样的东西 —— 两侧一律只打这一行，
// 这条用例就是钉住这个约定的。
if (!filters.length || filters.some((f) => 'uncaught'.includes(f))) {
  const um = moduleOf([]);
  um.funcs[0].body.stmts = [
    printStmt(str('before')),
    stmt(js('js_throw', [str('nobody catches me')])),
  ];
  const uJs = join(dir, 'uncaught.mjs');
  writeFileSync(uJs, emitJs(um));
  const uc = join(dir, 'uncaught.c');
  writeFileSync(uc, emitC(um));
  const uExe = join(dir, 'uncaught.out');
  const ub = run(cc, ['-std=c99', '-O1', '-pthread', `-I${RUNTIME_DIR}`, uc, ...runtimeSources(), '-o', uExe, '-lm']);
  const rJs = run(process.execPath, [uJs]);
  const rC = ub.code === 0 ? run(uExe, []) : { out: '', err: ub.err, code: ub.code };
  const want = { out: 'before\n', err: 'omni: uncaught: nobody catches me\n', code: 70 };
  const same = (r) => r.out === want.out && r.err === want.err && r.code === want.code;
  if (same(rJs) && same(rC)) {
    pass++;
    process.stdout.write('  ok   uncaught/exit-70-and-one-line\n');
  } else {
    fail++;
    failures.push('uncaught/exit-70-and-one-line\n'
      + `    want    ${JSON.stringify(want)}\n`
      + `    omni-js ${JSON.stringify({ out: rJs.out, err: rJs.err, code: rJs.code })}\n`
      + `    omni-c  ${JSON.stringify({ out: rC.out, err: rC.err, code: rC.code })}`);
    process.stdout.write('  FAIL uncaught/exit-70-and-one-line\n');
  }
}

const rep = cache.report();
process.stdout.write(`\n${pass} passed, ${fail} failed${rep === '' ? '' : `  （${rep}）`}\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
