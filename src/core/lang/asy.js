// src/core/lang/asy.js —— asy 前端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/wat.js、lang/sx.js 同一条规矩：**不 import cli.js**（那是"能独立编译成一个
// 动态库"的硬条件），要的宿主服务由入参给。asy 那一摊比 wat / sx 大得多（约 350 行：
// 语法表 / 词法 / 内建绑定表、AST 缓存、模块解析、asyText、compileAsy），所以**一片一片搬**，
// 每一片搬完都能跑；这一份先立起来，装的是 AST 缓存的紧凑格式。
//
// 产物缓存那几格（jsCache* / exeCache* / srcStamp）不跟着搬 —— 那是驱动层的策略，
// `.asy` 只是它现在唯一的用户。它与前端之间只有一处交接：前端读过哪些文件（依赖清单），
// 那一格要变成 compile 的返回值，而不是让驱动去读前端的模块级变量。

import { env } from '../host/native.js';
import { OmniError } from '../source/diag.js';

/**
 * 解析树的**紧凑格式**（第七十四刀）。量出来的：asy_builtins 那份树存成 JSON 是 12.0MB，
 * 用我们自己的 JSON 读器读回来 415ms，外加 184ms GC 与 109ms 读文件 —— 一趟 1.9s 里
 * 最大的一块，而且每个例子都得付一遍（树是**库**的，例子只是引它）。
 *
 * 树的形状只有三种（glrParse 出来的就是 S 表达式，见 glr/driver.js:114-130）：
 *   atom:   `{kind:'atom',   value, span:{start,end}}`
 *   string: `{kind:'string', value, raw, span:{start,end}}`
 *   list:   `{kind:'list',   items:[…], span:{start,end}}`
 * 所以不必走通用 JSON —— 前序一遍，长度显式写在前面，读的时候一遍扫过去，不用转义：
 *   `a` start `,` end `,` 值长 `:` 值
 *   `s` start `,` end `,` 值长 `,` 原文长 `:` 值 原文
 *   `l` start `,` end `,` 个数 `;` 子节点…
 * 形状认不出来（以后往节点上加了字段）就回 null，那一份**不进缓存**，行为一字不变。
 */
export function astPack(t, log) {
  const out = [];
  // 存不下来时说清是**哪一种形状**存不下来（`OMNI_ASY_PACKDBG=1`）：这一格一 null，
  // 整个单元的接口索引就不写，而从外面看只是"这个库还是从源码走"，量不出原因。
  const nope = (why, x) => {
    if (env('OMNI_ASY_PACKDBG') === '1') {
      log(`asy 打包不了 ${why} kind=${x === null || typeof x !== 'object' ? String(x) : x.kind} keys=${x === null || typeof x !== 'object' ? '' : Object.keys(x).join(',')}`);
    }
    return false;
  };
  const walk = (x) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return nope('不是节点', x);
    const sp = x.span;
    if (sp === null || sp === undefined || typeof sp !== 'object') return nope('没有 span', x);
    for (const k of Object.keys(sp)) {
      if (k !== 'start' && k !== 'end' && k !== 'file') return nope(`span 多一格 ${k}`, x);
    }
    if (!Number.isInteger(sp.start) || !Number.isInteger(sp.end)) return nope('span 不是整数', x);
    const ks = Object.keys(x);
    if (x.kind === 'atom') {
      if (ks.length !== 3 || typeof x.value !== 'string') return nope('atom 形状不对', x);
      out.push(`a${sp.start},${sp.end},${x.value.length}:${x.value}`);
      return true;
    }
    if (x.kind === 'string') {
      if (ks.length !== 4 || typeof x.value !== 'string' || typeof x.raw !== 'string') return nope('string 形状不对', x);
      out.push(`s${sp.start},${sp.end},${x.value.length},${x.raw.length}:${x.value}${x.raw}`);
      return true;
    }
    if (x.kind === 'list') {
      if (ks.length !== 3 || !Array.isArray(x.items)) return nope('list 形状不对', x);
      out.push(`l${sp.start},${sp.end},${x.items.length};`);
      for (const y of x.items) {
        if (!walk(y)) return false;
      }
      return true;
    }
    return nope('认不出的 kind', x);
  };
  return walk(t) ? out.join('') : null;
}

/** 上面那一份读回来。`file` 直接挂在 span 上，所以不用再走一遍"重新挂 file"。 */
export function astUnpack(s, file) {
  let i = 0;
  const num = (stop) => {
    let n = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === stop) { i++; return n; }
      if (c < 48 || c > 57) throw new OmniError(`ast 缓存坏了：第 ${i} 个字符不是数字`);
      n = n * 10 + (c - 48);
      i++;
    }
    throw new OmniError('ast 缓存坏了：数没读完就到末尾了');
  };
  const node = () => {
    const t = s.charCodeAt(i);
    i++;
    const start = num(44);          // ','
    const end = num(44);
    if (t === 97) {                 // 'a'
      const len = num(58);          // ':'
      const value = s.slice(i, i + len);
      i += len;
      return { kind: 'atom', value: value, span: { start: start, end: end, file: file } };
    }
    if (t === 115) {                // 's'
      const vlen = num(44);
      const rlen = num(58);
      const value = s.slice(i, i + vlen);
      i += vlen;
      const raw = s.slice(i, i + rlen);
      i += rlen;
      return {
        kind: 'string', value: value, raw: raw, span: { start: start, end: end, file: file },
      };
    }
    if (t !== 108) throw new OmniError(`ast 缓存坏了：第 ${i - 1} 个字符不是 a/s/l`);
    const n = num(59);              // ';'
    const items = [];
    for (let k = 0; k < n; k++) items.push(node());
    return { kind: 'list', items: items, span: { start: start, end: end, file: file } };
  };
  const t = node();
  if (i !== s.length) throw new OmniError('ast 缓存坏了：末尾还有多余的东西');
  return t;
}
