// ext/python/adapter/libsig.js —— 公共库的**签名接口**（`py_rt*.d.sx`）怎么读回来
//
// `units` 那条路把公共库（`ext/python/lib/*.py` 的实例 + ucase 表）切成 `py_rt_*`
// 一份；接口（`<名字>.d.sx`，`build/modules.js` 的 `declWrite` 写的）里是它每格实例
// 的**头一行签名**，形状就是方言印出来的那行：
//
//   (fn _str_upper ((s string) (w int)) string (do
//
// 这一份只做**读**：一行签名 → 名字、形参（名字 + 类型）、返回类型。登记成 frozen
// 实例、调用点怎么解析，在 `adapter/index.js` 那一侧（要用它那张 `tyKey` 表）。
//
// **解析不动就回 null**：接口是另一趟写下来的，读不懂说明版本走了样 —— 调用方
// 整体放弃 frozen、退回整份重推的老路。宁可慢，不可错。

import { INT, REAL, STR, BOOL, DYN, arrOf, dictOf } from '../../../src/core/lower/ty-of.js';

const VOID = { kind: 'void' };

/** 方言的类型文本 → adapter 的类型。认不得的回 null。 */
function typeFromSx(text) {
  if (text.startsWith('(')) {
    const inner = text.slice(1, -1);
    const sp = inner.indexOf(' ');
    const head = sp < 0 ? inner : inner.slice(0, sp);
    const rest = sp < 0 ? '' : inner.slice(sp + 1);
    if (head === 'arr') {
      if (rest === '') return null;
      const e = typeFromSx(rest);
      return e === null ? null : arrOf(e);
    }
    if (head === 'map') {
      /* `dictOf(value, key)` —— 那格函数的参数次序是"值在前"（注意）。 */
      const parts = splitTop(rest);
      if (parts.length !== 2) return null;
      const k = typeFromSx(parts[1].slice(1, -1));
      const v = typeFromSx(parts[0].slice(1, -1));
      return k === null || v === null ? null : dictOf(v, k);
    }
    return null;
  }
  switch (text) {
    case 'int': return INT;
    case 'real': return REAL;
    case 'string': return STR;
    case 'bool': return BOOL;
    case 'dyn': return DYN;
    case 'void': return VOID;
    default: return null;
  }
}

/** 按顶层括号组切开：`((a int) (b real))` → ['(a int)', '(b real)']。 */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

/** 跳过一格平衡的括号组（`i` 指在 `(` 上，回它配对的 `)` 的下一位）。 */
function skipGroup(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * 一行签名 → `{ mangled, params, ret }`；读不懂回 null。
 *
 * 形参是 `(名字 类型)` 的一组组；返回类型是一个类型文本；行尾的 `(do …` 不看 ——
 * `formsOf` 收的就是头一行（收不齐的括号它自己补齐了），体从来不在这行里。
 */
export function parseSig(line) {
  const s = line.trim();
  if (!s.startsWith('(fn ')) return null;
  const sp = s.indexOf(' ', 4);
  if (sp < 0) return null;
  const mangled = s.slice(4, sp);
  let i = sp + 1;
  if (s[i] !== '(') return null;
  const pe = skipGroup(s, i);
  if (pe < 0) return null;
  const paramsText = s.slice(i + 1, pe - 1);
  i = pe;
  while (s[i] === ' ') i += 1;
  let retText;
  if (s[i] === '(') {
    const re = skipGroup(s, i);
    if (re < 0) return null;
    retText = s.slice(i, re);
    i = re;
  } else {
    let k = i;
    while (k < s.length && s[k] !== ' ') k += 1;
    retText = s.slice(i, k);
    i = k;
  }
  const params = [];
  for (const one of splitTop(paramsText)) {
    const t = one.slice(1, -1);
    const psp = t.indexOf(' ');
    if (psp < 0) return null;
    const ty = typeFromSx(t.slice(psp + 1).trim());
    if (ty === null) return null;
    params.push({ name: t.slice(0, psp), type: ty });
  }
  const ret = typeFromSx(retText);
  if (ret === null) return null;
  return { mangled, params, ret };
}
