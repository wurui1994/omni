// src/lang/jnc/runtime-crt.js —— jancy 全局 CRT 里**字符那一族**的助手函数（整格发出来）
//
// 这是新降级第一处**连体一起发**的东西：前面那几刀发的都是函数头，这一族没有源码里的体，
// 体就是规则本身 —— 一格名字对一格判据，形参叫 `c`。所以整格 `(fn … (ret …))` 都能发。
//
// 判据全按 **ASCII** 写死（C 库那几条定义），不去叫宿主的同名函数：那样一来同一份 .jnc
// 在不同 libc 上答不一样。与 jancy 的 Unicode 版在 ≥128 上的分岔记在
// ADR-0016 第一百七十六刀那一节。
//
// 名字表由**语言**给（jnc 自己说自己），驱动只管"这一格名字被调了就发一格壳"。

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
