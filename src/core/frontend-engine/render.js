// src/core/frontend-engine/render.js —— 写回源码。**读的是同一张 `syn`**，所以永远与解析器认的东西一致
//
// 例子生成器造出 AST，`render` 把它写成源码；解析器再读回来。两个方向共用一份表，于是
// "生成器造得出来但解析器不认"这种自摆的乌龙在结构上不可能发生（jancy 那边正是因为
// 期望表与实现两份手写，才有 38 条措辞对不上，见 ADR-0029 10.14）。
//
// 排版故意松：记号之间一律留空格（除了 `,` `)` `]` 前与 `(` `[` 后）。松排版顺手躲开一个坑：
// `- -x` 挤成 `--x` 就变成注释了。

import { firstKeyOf } from './syntax.js';

const NO_SP_BEFORE = new Set([',', ')', ']', ';']);
const NO_SP_AFTER = new Set(['(', '[']);

function glue(toks) {
  let s = '';
  for (const t of toks) {
    if (t === '' || t === undefined) continue;
    if (s === '') { s = t; continue; }
    const last = s[s.length - 1];
    const sp = !(NO_SP_BEFORE.has(t) || NO_SP_AFTER.has(last) || last === '\n' || t.startsWith('\n'));
    s += (sp ? ' ' : '') + t;
  }
  return s;
}

const pad = (text) => (text === '' ? '' : text.split('\n').map((x) => `  ${x}`).join('\n'));

/* 组里第一个"带值的洞"的名字 —— 与解析器共用那一份（算过就缓存）。 */
const firstKey = firstKeyOf;

const has = (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

function slot(node, name, repIdx) {
  const v = node[name];
  return repIdx === null ? v : (v ?? [])[repIdx];
}

/**
 * 字符串写回去要用 **Lua 的**转义。先前借了 `JSON.stringify`，它把非 ASCII 写成 `\uXXXX`
 * —— Lua 5.1 不认这个转义，于是"自己写出来的自己不认"（`dynasm.lua`、`dump.lua` 那 3 个文件）。
 * Lua 的转义只有 `\\ \" \n \r \t` 与 `\ddd`（三位十进制），照它写。
 */
export function luaStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 32 || c > 126) {
      for (const b of new TextEncoder().encode(ch)) out += `\\${b}`;
    } else out += ch;
  }
  return `${out}"`;
}

/**
 * 名字怎么写回去也是**语言**的事：Lua 直接写，gsl-shell 的公式里带空格的名字要写成 `[…]`
 * （出处 `expr-print.lua:11` 的 `is_ident_simple`）。默认原样写。
 */
const ident = (s, lang) => (lang.ident === undefined ? String(s) : lang.ident(String(s)));

function emit(items, node, repIdx, lang) {
  const out = [];
  const sub = (x) => render(x, lang);
  for (const it of items) {
    if (typeof it === 'string') { out.push(it); continue; }
    if (it.opt !== undefined) {
      if (has(slot(node, firstKey(it.opt), repIdx))) out.push(...emit(it.opt, node, repIdx, lang));
      continue;
    }
    if (it.rep !== undefined) {
      const n = (node[firstKey(it.rep)] ?? []).length;
      for (let i = 0; i < n; i += 1) out.push(...emit(it.rep, node, i, lang));
      continue;
    }
    if (it.t !== undefined) {
      const v = node[it.as];
      // 字符串怎么写回去是**语言**的事：Lua 用双引号加转义，gsl-shell 的公式用单引号。
      if (it.t === 'string') out.push((lang.str ?? luaStr)(v));
      else if (it.t === 'name') out.push(ident(v, lang));
      else out.push(String(v));
      continue;
    }
    if (it.o !== undefined) { out.push(node[it.o]); continue; }
    if (it.w !== undefined) { out.push(ident(node[it.w], lang)); continue; }
    if (it.n !== undefined) { out.push((node[it.n] ?? []).join(it.sep === '.' ? '.' : ', ')); continue; }
    if (it.b !== undefined) { out.push(pad((node[it.b] ?? []).map(sub).join('\n'))); continue; }
    if (it.l !== undefined) {
      out.push((slot(node, it.l, repIdx) ?? []).map(sub).join(`${it.sep === '.' ? '.' : ', '}`));
      continue;
    }
    if (it.h !== undefined) {
      const text = sub(slot(node, it.h, repIdx));
      out.push(it.cls === 'block' ? `\n${text}\n` : text);
      continue;
    }
    throw new Error(`syn 里不认得的项：${JSON.stringify(it)}`);
  }
  return out;
}

/** 把 AST 写成源码。括号不会自己长出来 —— `paren` 是个真节点，该有的时候生成器会放。 */
export function render(node, lang) {
  if (node === undefined || node === null) throw new Error('render：空节点');
  const n = lang.NODE.get(node.kind);
  if (n === undefined) throw new Error(`render：${lang.name} 里没有节点 ${node.kind}`);
  const syn = node.dot === true && n.synDot !== undefined ? n.synDot : n.syn;
  return glue(emit(syn, node, null, lang));
}
