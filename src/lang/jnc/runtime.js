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

/* ─── `variant_t` 那一族（第一百一十三刀）─────────────────────────────────────
   一格 variant 在方言里是**四格的结构体**：标签 + 三格载荷（整数/实数/字符串）。
   装箱与拆箱做成**函数**而不是就地几句 —— 表达式那一层回的是一格值，没有能挂语句的
   地方（`(call jnc$var$i x)` 就地成立）。标签的数是 jancy 那边的次序：
   0 空、1 整数、2 实数、3 布尔、4 字符串。 */

/** 那格结构体自己（第一次用到才发）。 */
export const VARIANT = 'jnc$variant';

/**
 * 那四格字段（**名字与类型**）—— 与下面那行 `(struct …)` 是同一份数据：
 * 发结构体与"按值抄一份"（`copyValLines` 要一张字段表）读的都是它。抄两份就会漂，
 * 而漂的后果是：抄的时候少搬一格，于是拷贝出来的 variant 里有一格是别人的旧值。
 */
export const VARIANT_FIELDS = [
  { name: '$t', type: { k: 'int', w: 32, u: false } },
  { name: '$n', type: { k: 'int', w: 64, u: false } },
  { name: '$r', type: { k: 'real' } },
  { name: '$s', type: { k: 'string' } },
];

export function variantStruct() {
  const fs = VARIANT_FIELDS
    .map((f) => `(${f.name} ${emitType(f.type, 'field')})`).join(' ');
  return `  (struct ${VARIANT} ${fs})`;
}

/** 装箱：种 -> `{ tag, fld, ty }`。`fld === null` 的那一格（空）不带实参。 */
export const VAR_BOX = new Map([
  ['0', { tag: 0, fld: null, ty: null }],
  ['i', { tag: 1, fld: '$n', ty: 'int' }],
  ['r', { tag: 2, fld: '$r', ty: 'real' }],
  ['b', { tag: 3, fld: '$n', ty: 'int' }],
  ['s', { tag: 4, fld: '$s', ty: 'string' }],
]);

/** 拆箱：种 -> `{ tag, fld, ty, what }`（`what` 进那句失败的话）。 */
export const VAR_UNBOX = new Map([
  ['i', { tag: 1, fld: '$n', ty: 'int', what: '一格整数' }],
  ['r', { tag: 2, fld: '$r', ty: 'real', what: '一个实数' }],
  ['b', { tag: 3, fld: '$n', ty: 'int', what: '一格布尔' }],
  ['s', { tag: 4, fld: '$s', ty: 'string', what: '一格字符串' }],
]);

/** 整格装箱助手（`jnc$var$<种>`）。种不在表里答 `null`。 */
export function varBoxShell(kind) {
  const spec = VAR_BOX.get(kind);
  if (spec === undefined) return null;
  const vt = `(ptr ${VARIANT})`;
  const set = spec.fld === null ? '' : `\n    (pstore (pfield (var v) ${spec.fld}) (var x))`;
  return `  (fn jnc$var$${kind} (${spec.fld === null ? '' : `(x ${spec.ty})`}) ${vt}\n`
    + `    (let v ${vt} (pnew ${vt} (int 1)))\n`
    + `    (pstore (pfield (var v) $t) (int ${spec.tag}))${set}\n`
    + '    (ret (var v)))';
}

/**
 * 整格拆箱助手（`jnc$var$to$<种>`）。标签对不上就 `(fail …)` —— 与 assert 落到同一格。
 * jancy 那边拆箱失败也是**运行期**的事（`CastOp_Variant`），所以这一层不在编译期拒：
 * 拒了就把"转手一格 variant"这个压倒性的用法一起拒掉了。
 */
export function varUnboxShell(kind) {
  const spec = VAR_UNBOX.get(kind);
  if (spec === undefined) return null;
  const vt = `(ptr ${VARIANT})`;
  return `  (fn jnc$var$to$${kind} ((v ${vt})) ${spec.ty}\n`
    + `    (if (bin "!=" (pload (pfield (var v) $t)) (int ${spec.tag})) (do\n`
    + `      (fail (str ${JSON.stringify(`variant_t 里装的不是${spec.what}`)}))))\n`
    + `    (ret (pload (pfield (var v) ${spec.fld}))))`;
}

/* ─── 表达式里的赋值（第一百一十四 / 一百一十五刀）───────────────────────────
   `a = b` 在 jancy 里是**一格表达式**（值是存进去的那个值），而方言的 `(pstore …)`
   是一句。所以包一格助手：`(call jnc$asgn$<类型> 地址 值)` 就地成立，表达式那一层
   不必能挂语句。给属性赋值同一个办法，只是包的是存值器（它回 void）。 */

/** 赋值助手的名字：类型的方言文本，非字母数字换成 `_`（`(ptr C)` → `ptr_C`）。 */
export function asgnName(tyText) {
  return `jnc$asgn$${String(tyText).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

/**
 * 整格赋值助手（三行）。`tyText` 是那一格的**方言类型文本**（`int` 那一格四种位宽共用 ——
 * 存进去的位一样）。整条表达式的值是**存进去的那个值**。
 */
export function asgnShell(tyText) {
  if (tyText === null || tyText === undefined || tyText === '') return null;
  return `  (fn ${asgnName(tyText)} ((p (ptr ${tyText})) (x ${tyText})) ${tyText}\n`
    + '    (pstore (var p) (var x))\n'
    + '    (ret (var x)))';
}

/** 属性赋值助手的名字：属性的全名，非字母数字换成 `_`（`C$m_val` → `C_m_val`）。 */
export function psetName(prop) {
  return `jnc$pset$${String(prop).replace(/[^A-Za-z0-9]+/g, '_')}`;
}

/**
 * 整格属性赋值助手（三行）。`prop` 是属性的全名（`C$m_val` / `g_p`），`ty` 是值那一格的
 * **存储位置**文本，`self` 是 `$this` 那一格的存储位置文本（顶层的属性没有，给 `null`）。
 *
 * "整条表达式的值是存进去的那个值"这一条要紧：取值器可以有副作用，回头再读一次就是错答案。
 */
export function psetShell(prop, ty, self = null) {
  if (prop === null || prop === undefined || ty === null || ty === undefined) return null;
  const ps = self === null ? `(x ${ty})` : `($s ${self}) (x ${ty})`;
  const as = self === null ? ' (var x)' : ' (var $s) (var x)';
  return `  (fn ${psetName(prop)} (${ps}) ${ty}\n`
    + `    (expr (call ${prop}$set${as}))\n`
    + '    (ret (var x)))';
}
