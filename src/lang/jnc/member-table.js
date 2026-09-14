// src/lang/jnc/member-table.js —— **取字段**那一层的表 + 位域的读写公式
//
// 从旧降级 `memberOf` / `store` / `bitsRead`（`frontend-jnc/lower.js:11166-11243`）整块读出来。
// 一格 `obj.m` 有六种可能，**次序就是规则**：谁排在谁前面决定了字节序、别名、位域那几步
// 会不会被"普通字段"那一支悄悄接走。

/**
 * **字段表里查不着这个名字时**按这个次序问（lower.js:11170-11200）：
 *   1. **套在匿名 struct 里的 bigendian 成员**（第一百二十六刀）：它在外层那张字段表里查不着
 *      （名字挂在那一组的里层）—— 这一问要排在别名那张表**之前**，排在后面就被 `aliasPath`
 *      当普通字段接走了，**字节序那一步就丢了**；
 *   2. **字段路径的别名**（第一百〇四刀）：`b.m_head` 里 `m_head` 是 `m_list.m_head` 的另一个
 *      名字 —— 叠成一串 `(pfield …)`。查名这一步展开，之后读写与"真写出那一串"完全同一条路；
 *   3. **位域**（第一百一十二刀）：与上面那张表是同一种展开，只是路走到**存储那一格**就停，
 *      剩下的"哪几位"由读/写那两句办；
 *   4. **属性不是一格内存**（第六十九刀）：`b.p++`、`&b.p` 这些"就地改/取地址"的写法落到这儿。
 *      报"没有这个字段"是**认错人** —— 那个成员在，只是它那一格要走取/存两个函数。
 *      **左边得是类**才问这一句：属性只长在类上，结构体那边同名字段不存在时报的仍旧是"没有字段"；
 *   5. 都不是才报"没有字段 'm'" —— 名字要走 `shown()`，内部拼法（`doc$PluginHost`）不能漏进
 *      诊断里，用户不认得那是什么。
 *
 * **查着了**之后还有一格（lower.js:11202-11210）：
 *   6. **bigendian 的字段是一格真字段**（上面那一问找得着它），所以它挂在**最后这个出口**上，
 *      而不是像位域那样挂在"找不着"那一支里 —— 读写各套一次字节序反转；
 *   7. 别的：`(pfield 基 名字)`；结构体与数组是 `agg`，别的是 `ptr`。
 */
export const MEMBER_ORDER = [
  { name: 'be-in-anon', why: '匿名 struct 里的 bigendian 成员 —— 必须排在别名表之前' },
  { name: 'alias-path', why: '字段路径别名 → 叠一串 pfield（之后与真写出来那一串同一条路）' },
  { name: 'bitfield', why: '位域 → 展开到存储那一格就停，哪几位由读/写两句办' },
  { name: 'prop-not-memory', why: '属性不是一格内存（左边得是**类**才问这一句）' },
  { name: 'no-field', why: '报"没有字段"——名字走 shown()，内部拼法别漏进诊断' },
  { name: 'be-field', why: '**查着了**的 bigendian 字段：挂在最后这个出口，读写各套一次反转' },
  { name: 'plain', why: '`(pfield 基 名字)`；结构体与数组是 agg，别的是 ptr' },
];

/** 一格成员是哪种形状（与 `lvalue-table.js` 的三种形状同一套）。 */
export function memberShape(isStruct, isArr) {
  return isStruct === true || isArr === true ? 'agg' : 'ptr';
}

/** 别名那一串路叠出来的地址：`(pfield (pfield 基 a) b)`。 */
export function pathCode(baseCode, path) {
  let code = baseCode;
  for (const s of path) code = `(pfield ${code} ${s})`;
  return code;
}

/**
 * **写**那一句的分派（lower.js:11213-11217）：位域与 bigendian 各有自己的一套，
 * 剩下 `var` 是 `(set …)`、`ptr` 是 `(pstore …)`。
 */
export const STORE_BY_SHAPE = ['bits', 'be', 'var', 'ptr'];

/**
 * **位域读出来那一句**（第一百一十二刀）。照 jancy 的 `extractBitField`
 * （jnc_ct_OperatorMgr_DataRef.cpp:272-314）一步不差：
 *
 *   `(存储 >> off) & ((1 << cnt) - 1)`，声明类型**有符号**时再补符号位。
 *
 * 两处细节要紧：
 *   - 右移要**逻辑**移：存储那一格记成无符号，所以 64 位那一格上挑 `u>>`；窄的那几格里存的值
 *     本来就非负（写那一侧掩过），有符号右移也是同一个数；
 *   - 补符号位用 `(x ^ s) - s`（`s = 1 << (cnt-1)`）—— jancy 那边写成
 *     `value |= ~((signBit & value) - 1)`，两者**逐位相同**；
 *   - `cnt >= bw` 时整格就是它，那一步就是"按声明的符号性读这一格"（走整数转换）。
 */
export function bitsReadCode({
  slotCode, off, cnt, bw, signed, ushr, intConv,
}) {
  const raw = `(pload ${slotCode})`;
  if (cnt >= bw) return intConv(raw);
  const sh = off === 0 ? raw : `(bin ${JSON.stringify(ushr)} ${raw} (int ${off}))`;
  let code = `(bin "&" ${sh} (int ${(1n << BigInt(cnt)) - 1n}))`;
  if (signed === true) {
    const s = 1n << BigInt(cnt - 1);
    code = `(bin "-" (bin "^" ${code} (int ${s})) (int ${s}))`;
  }
  return code;
}
