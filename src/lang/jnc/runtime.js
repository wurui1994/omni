// src/lang/jnc/runtime.js —— **运行期助手**那一族（整格发出来：头 + 体）
//
// 这一族源码里没有体，**体就是规则本身**，所以整格 `(fn …)` 都发得出来 ——
// 前面十几刀发的都只是函数头，这是第一处把体也发了的。现在收两族：
//   - 字符那一族 `jnc$crt$…`：一格名字对一格 ASCII 判据，形参叫 `c`
//   - 通知那一格 `jnc$mc_fire[$签名]`：照单子从头到尾叫一遍
//
// 字符那一族的判据全按 **ASCII** 写死（C 库那几条定义），不去叫宿主的同名函数：那样一来
// 同一份 .jnc 在不同 libc 上答不一样。与 jancy 的 Unicode 版在 ≥128 上的分岔记在
// ADR-0016 第一百七十六刀那一节。
//
// 名字表由**语言**给（jnc 自己说自己），驱动只管"这一格被用到了就发一格壳"。

import { emitType } from './emit-type.js';

/** `lo <= c <= hi`。 */
const range = (lo, hi) => `(bin "&&" (bin ">=" (var c) (int ${lo})) (bin "<=" (var c) (int ${hi})))`;

const DIGIT = range(48, 57);
const UPPER = range(65, 90);
const LOWER = range(97, 122);
const ALPHA = `(bin "||" ${UPPER} ${LOWER})`;
const ALNUM = `(bin "||" ${ALPHA} ${DIGIT})`;
const PRINT = range(32, 126);

/**
 * 一格名字 -> `{ ret, body }`（`ret` 是方言那一侧的存储位置文本，`body` 是 `(ret …)` 里那一格）。
 * 十一格里 `rand` 不在这儿：它不发壳，走的是 `(cabi rand i32 ())` + `(ccall rand)`。
 */
export const CRT_CHAR = new Map([
  ['isdigit', { ret: 'bool', body: DIGIT }],
  ['isupper', { ret: 'bool', body: UPPER }],
  ['islower', { ret: 'bool', body: LOWER }],
  ['isalpha', { ret: 'bool', body: ALPHA }],
  ['isalnum', { ret: 'bool', body: ALNUM }],
  ['isprint', { ret: 'bool', body: PRINT }],
  // 空白那几格照 C 的定义：空格与 \t \n \v \f \r（9..13）。
  ['isspace', { ret: 'bool', body: `(bin "||" (bin "==" (var c) (int 32)) ${range(9, 13)})` }],
  // 标点 = 印得出来、又不是字母数字、又不是空格（C 的定义就是这么写的）。
  ['ispunct', { ret: 'bool', body: `(bin "&&" ${PRINT} (un "!" (bin "||" ${ALNUM} (bin "==" (var c) (int 32)))))` }],
  ['toupper', { ret: 'int', body: `(sel ${LOWER} (bin "-" (var c) (int 32)) (var c))` }],
  ['tolower', { ret: 'int', body: `(sel ${UPPER} (bin "+" (var c) (int 32)) (var c))` }],
]);

/** 这一格名字是字符那一族的助手吗。 */
export function isCrtChar(name) {
  return CRT_CHAR.has(name);
}

/**
 * 整格助手函数（两行：头一行 `(fn …`，第二行 `(ret …))`）。缩进与别处一样：
 * 顶层的东西两格，体四格。名字不在表里答 `null`。
 */
export function crtCharShell(name) {
  const spec = CRT_CHAR.get(name);
  if (spec === undefined) return null;
  return `  (fn jnc$crt$${name} ((c int)) ${spec.ret}\n    (ret ${spec.body}))`;
}

/**
 * 通知那一格的**名字**：`jnc$mc_fire`，带形参的按**签名**分（一种签名一格 —— 模块级的
 * 名字要全局唯一）。签名那几段拿的是形参的**值位置**文本，非字母数字一律换成 `_`
 * （`(ptr S)` → `ptr_S`）—— 与旧降级 lower.js:5283 逐字同一条。
 */
export function mcFireName(mc) {
  const ps = mc === null || mc === undefined ? [] : (mc.params ?? []);
  const sig = ps.map((p) => emitType(p, 'value').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return sig.length === 0 ? 'jnc$mc_fire' : `jnc$mc_fire$${sig.join('$')}`;
}

/**
 * 整格通知助手（五行）。次序与 jancy 一样是**加进来的顺序**（`McSnapshot.call` 从下标 0
 * 往上走，jnc_ct_MulticastClassType.cpp:64-94）。jancy 那边先取一份快照再叫，为的是
 * "叫的过程中有人加/减"不会乱；这一层直接走那格数组，所以每一圈都重问一次 `alen` ——
 * 叫的过程中加进来的会被叫到。这是**可观测的差别**，与旧降级同一条，记成账。
 *
 * `mc` 是 `{ k: 'mc', params }`（`resolveType` 答的那一种）。形参表那一格用**存储位置**、
 * 签名用**值位置** —— 旧降级 `ps` 走 slotText、`sig` 走 tyText，这儿照它。
 */
export function mcFireShell(mc) {
  if (mc === null || mc === undefined || mc.k !== 'mc') return null;
  const ps = mc.params ?? [];
  const name = mcFireName(mc);
  const formals = ps.map((p, i) => ` ($a${i} ${emitType(p, 'slot')})`).join('');
  const args = ps.map((p, i) => ` (var $a${i})`).join('');
  return `  (fn ${name} ((m ${emitType(mc, 'value')})${formals}) void\n`
    + '    (let i int (int 0))\n'
    + '    (while (bin "<" (var i) (alen (var m))) (do\n'
    + `      (expr (callfn (aget (var m) (var i))${args}))\n`
    + '      (set i (bin "+" (var i) (int 1))))))';
}
