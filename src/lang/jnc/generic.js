// src/lang/jnc/generic.js —— 泛型 = **单态化**（一格用点造一格实例）
//
// jancy 的泛型在这一层落成"每一组实参各造一份"（110-generic.jnc 的真输出就是六个结构体：
// `Box$int` / `Pair$int$char` / `Box$char` / `Pair$char$int` / `Holder$int` / `Holder$char`），
// 方法跟着叫 `Box$int$get_v`。做法与旧降级同一条（lower.js:4395-4484 的 tinstOne）：
//
//   1. 泛型声明处记成一格**模板**：`struct Box<T> {…}` → { base:'Box', params:['T'], agg 的树 }；
//   2. 一格**用点**（`Box<int>`、字段 `Box<K> m_bk`、`new Box<int>`）解出实参那几格
//      **type-spec**，名字拼成 `模板名$实参键$…`；
//   3. 把模板的树按 `参数名 -> 实参那格 type-spec` **整棵替换**一遍（替换只在 type-spec 这一层
//      —— ADR-0025 那条），名字那一格换成实例名，于是它就是一格普通 `agg`，读法照旧
//      （`readAgg` / `readDeclType` / `resolveType` 一个字都不用改）；
//   4. 队列跑到**不动点**：实例体里还带用点（`Box<K> m_bk` 替出来的 `Box<int>`）就接着造。
//
// 这一份只管"造出哪几格实例、每一格的树长什么样"。带 `*` / 带修饰符的实参（`Box<int const*>`）
// 与默认实参先照实答不出来（记账，不猜）—— 旧降级那边它们要先合成一条 typedef。

import { headOf, named } from './adapt.js';
import { nameText, allInChain } from './declare.js';
import { readSpecs } from './specs.js';

/** 实例化套多深就算停不下来（旧降级的 TMPL_DEPTH 同一条闸门）。 */
const MAX_DEPTH = 8;

/** 一格 `agg` 是泛型吗：名字那一格是 `tinst` 就是（`struct Box<T>`）。 */
export function templateOf(aggNode) {
  const nm = named(aggNode);
  if (nm === null || nm.kind !== 'agg') return null;
  if (headOf(nm.name) !== 'tinst') return null;
  const tn = named(nm.name);
  if (tn === null) return null;
  const base = nameText(tn.name);
  if (base === null) return null;
  const params = [];
  for (const t of allInChain(tn.targs, 'targs-add', 'targs')) {
    const p = paramName(t);
    if (p === null) return null;                                     // 认不出的参数表：整格不收
    params.push(p);
  }
  return params.length === 0 ? null : { base, params, node: aggNode };
}

/** 声明处一格 `targ` 里的参数名（`(targ (type-name (specs (name T) …) (ptrs)))`）。 */
function paramName(targ) {
  const sp = specOf(targ);
  return sp === null ? null : (headOf(sp) === 'name' ? nameText(sp) : null);
}

/** 一格 `targ` 里那格 **type-spec**（替换与拼名字都只看它 —— ADR-0025）。 */
function specOf(targ) {
  if (headOf(targ) !== 'targ') return null;
  const t = named(targ);
  const tn = t === null ? null : t.type;
  if (headOf(tn) !== 'type-name') return null;
  const nm = named(tn);
  if (nm === null) return null;
  /* 带 `*` 的实参这一层不收（旧降级要先合成一条 typedef）—— 照实答 null。 */
  if (ptrCount(nm.ptrs) > 0) return null;
  const sp = named(nm.specs);
  if (sp === null || sp.type === undefined) return null;
  /* **带修饰符**的实参同上（`Box<char const>` 与 `Box<char>` 不是同一格类型，名字也不一样
     —— 113-genericmod.jnc 的真输出是 `Box$char_const`）。修饰符丢掉会造出一格**名字撞车**
     的实例，那是静默的错答案，所以照实答 null。 */
  const words = readSpecs(nm.specs);
  if (words === null || words.words.length > 0) return null;
  return sp.type;
}

function ptrCount(ptrs) {
  let n = 0;
  let cur = ptrs;
  while (headOf(cur) === 'ptrs-add') {
    n += 1;
    cur = named(cur)?.list;
  }
  return n;
}

/** 一格 type-spec 的**实参键**（`int` / `Foo`；里层实例名里的 `$` 换成 `_`，与旧降级同）。 */
function keyOf(spec) {
  if (spec === null || spec === undefined) return null;
  if (!Array.isArray(spec.items)) return spec.value === undefined ? null : String(spec.value);
  const h = headOf(spec);
  if (h === 'name') return nameText(spec);
  return null;                                                       // 里层实例那一支在 instOne 里接
}

/** 整棵替换：`(name T)` 换成实参那格 type-spec（与旧降级 tmplSubst 一字不差）。 */
export function substitute(n, map) {
  if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return n;
  if (headOf(n) === 'name') {
    const t = nameText(n);
    if (t !== null && map.has(t)) return map.get(t);
  }
  const items = n.items.map((x) => substitute(x, map));
  if (items.every((x, i) => x === n.items[i])) return n;
  return { ...n, items };
}

/** 一格名字节点（替换用：把 `(name T)` 换成 `(name Node$int)`）。 */
function nameNode(text, like) {
  return {
    kind: 'list',
    span: like?.span,
    items: [
      { kind: 'atom', value: 'name', span: like?.span },
      { kind: 'atom', value: text, span: like?.span },
    ],
  };
}

/**
 * 把一棵树里的泛型**全部实例化**，答 `{ insts, fails }`：
 *   - `insts`：`实例名 -> 替换好的 agg 节点`（次序 = 造出来的次序）；
 *   - `fails`：解不出来的那几笔账（`名字 -> 次数`）。
 * `templates` 是这份文件里的模板表（`base -> templateOf(...)`）。
 */
export function expandTemplates(tree, templates) {
  const insts = new Map();
  const fails = new Map();
  const note = (w) => fails.set(w, (fails.get(w) ?? 0) + 1);
  /* **没绑上的类型参数**（`struct Box<T>` 自己那个名字、体外成员 `T Box<T>.fetch()` 里的
     `Box<T>`）不是一格用点 —— 那儿的 `T` 还是个参数。所有模板的参数名先收成一张表，
     实参撞上它就不是用点（旧降级那边这两处压根走不到 tinstOne）。 */
  const paramNames = new Set();
  for (const tm of templates.values()) for (const p of tm.params) paramNames.add(p);
  /** 一格用点：答实例名，造不出来答 null。 */
  const instOne = (tinstNode, depth) => {
    const tn = named(tinstNode);
    if (tn === null) return null;
    const base = nameText(tn.name);
    const tm = base === null ? undefined : templates.get(base);
    if (tm === undefined) return null;                               // 不是这份文件里的泛型
    if (depth > MAX_DEPTH) { note('泛型套得太深'); return null; }
    const specs = [];
    const keys = [];
    for (const targ of allInChain(tn.targs, 'targs-add', 'targs')) {
      let sp = specOf(targ);
      if (sp === null) { note('实参带 `*` 或修饰符（要先合成一条 typedef）'); return null; }
      let key;
      if (headOf(sp) === 'tinst') {                                  // 实参本身是一格实例化
        const inner = instOne(sp, depth + 1);
        if (inner === null) return null;
        key = inner.replace(/\$/g, '_');
        sp = nameNode(inner, sp);
      } else {
        key = keyOf(sp);
        if (key === null) { note('认不出实参那一格'); return null; }
        if (paramNames.has(key)) return null;                        // 没绑上的参数：不是用点
      }
      specs.push(sp);
      keys.push(key);
    }
    if (specs.length !== tm.params.length) {
      note('实参个数与参数表不一样（默认实参那一族）');
      return null;
    }
    const inst = `${tm.base}$${keys.join('$')}`;
    if (insts.has(inst)) return inst;
    insts.set(inst, null);                                           // 先占位（防自套死循环）
    const map = new Map();
    tm.params.forEach((p, i) => map.set(p, specs[i]));
    const ag = substitute(tm.node, map);
    /* 名字那一格换成实例名（`(tinst …)` → `(name Box$int)`）。 */
    const nm = named(ag);
    const items = [...ag.items];
    items[ag.items.indexOf(nm.name)] = nameNode(inst, nm.name);
    const done = { ...ag, items };
    insts.set(inst, done);
    walk(done, depth + 1);                                           // 实例体里还带用点就接着造
    return inst;
  };
  const walk = (n, depth) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'tinst') {
      instOne(n, depth);
      return;                                                        // 里头那几格由 instOne 自己走
    }
    for (const it of n.items) walk(it, depth);
  };
  walk(tree, 0);
  return { insts, fails };
}

/** 这份文件里的模板表（`base -> {base, params, node}`）。 */
export function templateTable(tree) {
  const out = new Map();
  const walk = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'agg') {
      const tm = templateOf(n);
      if (tm !== null && !out.has(tm.base)) out.set(tm.base, tm);
    }
    for (const it of n.items) walk(it);
  };
  walk(tree);
  return out;
}
