// src/core/graph/mapping.js —— `.mapping` 文件的解释器
//
// 读 `.mapping`，建出一张查找表：CST 标签 → 构造函数。
// `toNode(x)` 先查这张表；查到了走声明式规则，查不到走 native（tograph.js 的 case）。
//
// ## 不做什么
//
// 这一份**只管模式规则**（`(map …)` 和 `(builtin …)`）。
// `(native …)` 留在 tograph.js 里 —— 那是逃逸口，不是这台机器的事。
// 判据在 `tests/lib/mapping-check.js`。

import { node, lit } from './graph.js';
import {
  tag, kids, leaf, part, partKids,
  binOf, retOf, branchOf, loopExit, sliceOf, deferNow,
  recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet,
  mapNew, mapGet, mapSet, isList,
} from './fromtree.js';

/* ---- 极简 s-expr 读入器（与 mapping-check.js 里那份相同的逻辑）---- */
function readForms(text) {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
      break;
    }
  };
  const one = () => {
    skip();
    if (i >= text.length) return undefined;
    if (text[i] === '(') {
      i++;
      const items = [];
      for (;;) {
        skip();
        if (i >= text.length || text[i] === ')') { i++; break; }
        const v = one();
        if (v === undefined) break;
        items.push(v);
      }
      return items;
    }
    if (text[i] === ')') { i++; return undefined; }
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; s += text[i++]; }
      i++;
      return { str: s };
    }
    let a = '';
    while (i < text.length && !/[\s()]/.test(text[i])) a += text[i++];
    return a;
  };
  const out = [];
  for (;;) { skip(); if (i >= text.length) break; const v = one(); if (v === undefined) break; out.push(v); }
  return out;
}

const isL = (x) => Array.isArray(x);
const hd = (x) => (isL(x) && typeof x[0] === 'string') ? x[0] : null;

/**
 * 加载一份 `.mapping` 文件，返回 { rules, builtins }。
 *
 * rules: Map<string, { pattern, construct }>   CST 标签 → 规则
 * builtins: Map<string, construct>              内建名字 → 展开
 */
export function loadMapping(text) {
  const forms = readForms(text);
  const top = forms.find((f) => hd(f) === 'mapping');
  if (!top) throw new Error(`mapping: ${path} 没有 (mapping <lang> …)`);

  const rules = new Map();
  const builtins = new Map();

  for (const form of top.slice(2)) {
    if (!isL(form)) continue;
    const h = hd(form);
    if (h === 'map') {
      const pat = form[1];
      const construct = form[2];
      if (!isL(pat) && typeof pat === 'string') {
        // `(map tagName construct)` — 单标签
        rules.set(pat, { pattern: [pat], construct });
        continue;
      }
      if (isL(pat)) {
        const ph = hd(pat);
        if (ph === 'or' || (isL(pat[0]) && hd(pat[0]) === 'or')) {
          // `(map ((or a b c) …) construct)` — 多标签同一条规则
          const orList = hd(pat) === 'or' ? pat : pat[0];
          for (const t of orList.slice(1)) {
            if (typeof t === 'string') rules.set(t, { pattern: pat, construct });
          }
        } else if (ph !== null) {
          rules.set(ph, { pattern: pat, construct });
        }
      }
    } else if (h === 'builtin') {
      const name = form[1];
      const construct = form[2];
      if (typeof name === 'string') builtins.set(name, construct);
    }
  }
  return { rules, builtins };
}

/**
 * 用 mapping 规则翻译一格 CST 节点。
 *
 * @param {object} x  CST 节点
 * @param {Map} rules  loadMapping 返回的 rules
 * @param {function} toNode  递归翻译函数（native 的 case 也走它）
 * @param {object} ctx  { OPS, STRUCTS, ... } 分析层的查询上下文
 * @returns {object|null}  图节点，或 null（没匹配到，交给 native）
 */
export function applyRule(x, rules, toNode, ctx) {
  const t = tag(x);
  if (!rules.has(t)) return null;  // 交给 native
  const { pattern, construct } = rules.get(t);
  const ch = kids(x);

  // 绑定模式变量
  const bindings = {};
  for (let i = 1; i < pattern.length; i++) {
    const slot = pattern[i];
    if (typeof slot === 'string') {
      if (slot === '_') continue;
      if (slot.startsWith('$*')) {
        bindings[slot] = ch.slice(i - 1);
      } else if (slot.startsWith('$?')) {
        bindings[slot] = ch[i - 1]; // 可能是 undefined
      } else if (slot.startsWith('$')) {
        bindings[slot] = ch[i - 1];
      }
    }
  }

  return evalConstruct(construct, bindings, toNode, ctx);
}

/**
 * 求值一格构造表达式，产出图节点。
 */
function evalConstruct(c, bindings, toNode, ctx) {
  if (c === undefined || c === null) return [];
  if (typeof c === 'string') {
    // $1, $2, ... → 翻译子节点
    if (c.startsWith('$*')) {
      const nodes = bindings[c];
      if (!nodes) return [];
      return nodes.filter(n => n !== undefined).map(n => toNode(n));
    }
    if (c.startsWith('$?')) {
      const n = bindings[c];
      return n !== undefined ? toNode(n) : undefined;
    }
    if (c.startsWith('$')) {
      const n = bindings[c];
      if (n === undefined) return lit(null);
      return toNode(n);
    }
    return c;
  }
  if (c.str !== undefined) return c.str; // 字符串字面量

  if (!isL(c)) return c;
  const h = hd(c);

  // (nil) → 空
  if (h === 'nil') return [];

  // (const (@ value ...)) → 图的 const 节点
  if (h === 'const') {
    const val = evalAttr(c[1], bindings, toNode, ctx);
    return node('const', {}, { value: val });
  }

  // (ref (@ name ...)) → 图的 ref 节点
  if (h === 'ref') {
    const val = evalAttr(c[1], bindings, toNode, ctx);
    return node('ref', {}, { name: val });
  }

  // (branch :cond C :then T :else E) → branchOf
  if (h === 'branch') {
    const ports = parsePorts(c, bindings, toNode, ctx);
    return branchOf(ports.cond, ports.then, ports.else);
  }

  // (region :body ...) → region 节点
  if (h === 'region') {
    const ports = parsePorts(c, bindings, toNode, ctx);
    const body = Array.isArray(ports.body) ? ports.body : [ports.body];
    return node('region', { body: body.flat() });
  }

  // (loop :init I :cond C :post P :body B)
  if (h === 'loop') {
    const ports = parsePorts(c, bindings, toNode, ctx);
    // 用现有的 threePart 或直接造 loop
    return node('loop', {
      init: ports.init ?? [],
      cond: ports.cond,
      post: ports.post ?? [],
      body: ports.body ?? [],
    });
  }

  // (ret :value V) → retOf
  if (h === 'ret') {
    const ports = parsePorts(c, bindings, toNode, ctx);
    return retOf(ports.value);
  }

  // (set (@ name N) :value V) → set 节点
  if (h === 'set') {
    const attrs = {};
    const ins = {};
    for (let i = 1; i < c.length; i++) {
      if (isL(c[i]) && hd(c[i]) === '@') {
        attrs[c[i][1]] = evalConstruct(c[i][2], bindings, toNode, ctx);
      } else if (typeof c[i] === 'string' && c[i].startsWith(':')) {
        ins[c[i].slice(1)] = evalConstruct(c[i + 1], bindings, toNode, ctx);
        i++;
      }
    }
    return node('set', ins, attrs);
  }

  // (loop-exit (@ kind K)) → loopExit
  if (h === 'loop-exit') {
    const kind = evalAttr(c[1], bindings, toNode, ctx);
    return loopExit(kind);
  }

  // (scope-exit :body B) → deferNow
  if (h === 'scope-exit') {
    const ports = parsePorts(c, bindings, toNode, ctx);
    return deferNow(ports.body);
  }

  // (slice :list L :from F :to T)
  if (h === 'slice') {
    const ports = parsePorts(c, bindings, toNode, ctx);
    return sliceOf(ports.list, ports.from, ports.to);
  }

  // (binop op a b) → binOf
  if (h === 'binop') {
    const op = evalConstruct(c[1], bindings, toNode, ctx);
    const a = evalConstruct(c[2], bindings, toNode, ctx);
    const b = evalConstruct(c[3], bindings, toNode, ctx);
    return binOf(op, a, b, ctx.OPS ?? new Map(), { lang: 'go' });
  }

  // (unop op a) → un
  if (h === 'unop') {
    const op = evalConstruct(c[1], bindings, toNode, ctx);
    const a = evalConstruct(c[2], bindings, toNode, ctx);
    return unNode(op, a);
  }

  // (! name args...) → prim
  if (h === '!') {
    const name = c[1];
    const args = c.slice(2).map(a => evalConstruct(a, bindings, toNode, ctx));
    return node('prim', { args }, { name });
  }

  // (rt name args...) → call __goXxx
  if (h === 'rt') {
    const name = c[1];
    const args = c.slice(2).map(a => evalConstruct(a, bindings, toNode, ctx));
    return node('call', { fn: node('ref', {}, { name }), args });
  }

  // (@ name expr) → 属性求值
  if (h === '@') return evalAttr(c, bindings, toNode, ctx);

  // (number x) → Number(leaf(x))  取 CST 叶子的原始值再转数字
  if (h === 'number') {
    const raw = c[1];
    if (typeof raw === 'string' && raw.startsWith('$')) {
      const n = bindings[raw];
      return n !== undefined ? Number(leaf(n)) : 0;
    }
    const v = evalConstruct(c[1], bindings, toNode, ctx);
    return typeof v === 'string' ? Number(v) : Number(v ?? 0);
  }

  // (rune-code x) → 码点数字，取 CST 叶子的原始值再解析转义
  if (h === 'rune-code') {
    const raw = c[1];
    let s;
    if (typeof raw === 'string' && raw.startsWith('$')) {
      const n = bindings[raw];
      s = n !== undefined ? leaf(n) : '';
    } else {
      s = String(evalConstruct(c[1], bindings, toNode, ctx));
    }
    if (!s || s.length === 0) return 0;
    if (s.length === 1) return s.charCodeAt(0);
    if (s === '\\n') return 10; if (s === '\\t') return 9; if (s === '\\r') return 13;
    if (s === '\\\\') return 92; if (s === "\\'") return 39; if (s === '\\0') return 0;
    if (s === '\\a') return 7; if (s === '\\b') return 8; if (s === '\\f') return 12; if (s === '\\v') return 11;
    if (/^\\u[0-9a-fA-F]{4}$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^\\U[0-9a-fA-F]{8}$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^\\x[0-9a-fA-F]{2}$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^\\[0-7]{3}$/.test(s)) return parseInt(s.slice(1), 8);
    return s.charCodeAt(0);
  }

  // (name-of x) → nameOf(x)
  if (h === 'name-of') {
    const v = evalConstruct(c[1], bindings, toNode, ctx);
    if (typeof v === 'object' && v !== null && v.attrs && v.attrs.name) return v.attrs.name;
    return v;
  }

  // 兜底：当成透传引用
  return null;
}

function evalAttr(form, bindings, toNode, ctx) {
  if (!isL(form) || hd(form) !== '@') return form;
  const name = form[1];
  const val = form[2];
  // attrs 的值通常是原始值（数字/字符串/布尔），不是图节点。
  // 如果 val 是 $N（引用 CST 子节点），取 leaf 值而不是递归翻译。
  if (typeof val === 'string' && val.startsWith('$') && !val.startsWith('$*')) {
    const n = bindings[val];
    if (n === undefined) return null;
    // 特殊值
    const lv = leaf(n);
    if (lv === 'true') return true;
    if (lv === 'false') return false;
    if (lv === 'nil') return null;
    return lv;
  }
  // 构造表达式（如 (number $1), (rune-code $1)）
  return evalConstruct(val, bindings, toNode, ctx);
}

function parsePorts(c, bindings, toNode, ctx) {
  const ports = {};
  for (let i = 1; i < c.length; i++) {
    if (typeof c[i] === 'string' && c[i].startsWith(':')) {
      const key = c[i].slice(1);
      const val = c[i + 1];
      ports[key] = evalConstruct(val, bindings, toNode, ctx);
      i++;
    }
  }
  return ports;
}
