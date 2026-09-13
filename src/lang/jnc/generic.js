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
    const p = paramOf(t);
    if (p === null) return null;                                     // 认不出的参数表：整格不收
    params.push(p);
  }
  return params.length === 0 ? null : { base, params, node: aggNode };
}

/**
 * 声明处一格 `targ`：`{ name, deflt }`。`deflt` 是**默认实参**那格 type-name
 * （`struct Slot<T, Base = int>` 的 `int`，114-genericdef.jnc；节点表 :106 的 `deflt` 洞）。
 */
function paramOf(targ) {
  if (headOf(targ) !== 'targ') return null;
  const t = named(targ);
  if (t === null) return null;
  const a = argOfTypeName(t.type);
  if (a === null || a.mods.length > 0 || a.ptrs > 0) return null;
  const nm = headOf(a.spec) === 'name' ? nameText(a.spec) : null;
  return nm === null ? null : { name: nm, deflt: t.deflt ?? null };
}

/**
 * 一格实参（`targ` 里的 type-name，或默认实参那格 type-name）读成三样：
 * `{ spec, mods, ptrs }` —— 替换只看 `spec`（ADR-0025），`mods` / `ptrs` 要**记进名字**
 * （`Box<int const*>` 与 `Box<int*>` 不是同一格类型）。
 */
function argOfTypeName(tn) {
  if (headOf(tn) !== 'type-name') return null;
  const nm = named(tn);
  if (nm === null) return null;
  const sp = named(nm.specs);
  if (sp === null || sp.type === undefined) return null;
  const words = readSpecs(nm.specs);
  return {
    spec: sp.type,
    mods: words === null ? [] : words.words,
    ptrs: ptrCount(nm.ptrs),
    specs: nm.specs,
  };
}

/** 一格 `targ` 里的实参。 */
function argOf(targ) {
  if (headOf(targ) !== 'targ') return null;
  const t = named(targ);
  return t === null ? null : argOfTypeName(t.type);
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
  for (const tm of templates.values()) for (const p of tm.params) paramNames.add(p.name);
  /* 带 `*` / 带修饰符的实参：替换只在 type-spec 那一层，所以给它**起个名字**（合成一条
     typedef，与旧降级 lower.js:4522-4534 同一条），名字里把修饰符与 `*` 都记上
     （`Box<int const*>` → `int_const_p`）。这张表答给调用方，进 env 就能解出来。 */
  const typedefs = new Map();
  /* 泛型 typedef 实例化出来的那几条（`Pair$int` → 一条 typedef 的树）。 */
  const tdefs = new Map();
  /** 一格实参 → `{ spec, key }`（`spec` 是替进去的那格 type-spec）。 */
  const argSpec = (a, depth) => {
    let sp = a.spec;
    let key;
    if (headOf(sp) === 'tinst') {                                    // 实参本身是一格实例化
      const inner = instOne(sp, depth + 1);
      if (inner === null) return null;
      key = inner.replace(/\$/g, '_');
      sp = nameNode(inner, sp);
    } else {
      key = keyOf(sp);
      if (key === null) { note('认不出实参那一格'); return null; }
      if (a.mods.length === 0 && a.ptrs === 0 && paramNames.has(key)) return null;
    }
    if (a.mods.length === 0 && a.ptrs === 0) return { spec: sp, key };
    const full = [key, ...a.mods, ...Array(a.ptrs).fill('p')].join('_');
    const syn = `jnc$tp$${full}`;
    typedefs.set(syn, { base: sp, mods: a.mods, ptrs: a.ptrs, specs: a.specs });
    return { spec: nameNode(syn, sp), key: full };
  };
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
      const a = argOf(targ);
      if (a === null) { note('认不出实参那一格'); return null; }
      const r = argSpec(a, depth);
      if (r === null) return null;
      specs.push(r.spec);
      keys.push(r.key);
    }
    /* **默认实参**（`struct Slot<T, Base = int>`，114-genericdef.jnc）：给的不够就拿声明处那几格
       补上，补的时候要用**已经绑好的**那几格替一遍（默认值本身可能引前面的参数）。 */
    if (specs.length < tm.params.length) {
      const bound = new Map();
      tm.params.forEach((p, i) => { if (i < specs.length) bound.set(p.name, specs[i]); });
      for (let i = specs.length; i < tm.params.length; i += 1) {
        const d = tm.params[i].deflt;
        if (d === null || d === undefined) { note('实参给少了、又没有默认实参'); return null; }
        const a = argOfTypeName(substitute(d, bound));
        if (a === null) { note('认不出默认实参那一格'); return null; }
        const r = argSpec(a, depth);
        if (r === null) return null;
        specs.push(r.spec);
        keys.push(r.key);
        bound.set(tm.params[i].name, r.spec);
      }
    }
    if (specs.length !== tm.params.length) {
      note('实参比参数表还多');
      return null;
    }
    const inst = `${tm.base}$${keys.join('$')}`;
    if (insts.has(inst) || tdefs.has(inst)) return inst;
    const map = new Map();
    tm.params.forEach((p, i) => map.set(p.name, specs[i]));
    /* **泛型 typedef**：合成出来的是一条 typedef（没有体、不进结构体那张表），它指的那格
       `Impl<int,int>` 由队列接着造（115-generictdef.jnc）。 */
    if (tm.kind === 'typedef') {
      tdefs.set(inst, null);                                         // 先占位（防自套）
      const td = renameDeclTinst(substitute(tm.node, map), tm.base, inst);
      tdefs.set(inst, td);
      walk(td, depth + 1);
      return inst;
    }
    insts.set(inst, null);                                           // 先占位（防自套死循环）
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
  return { insts, typedefs, tdefs, fails };
}

/** 这份文件里的模板表（`base -> {base, params, node}`）。 */
export function templateTable(tree) {
  const out = new Map();
  const walk = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    if (h === 'agg') {
      const tm = templateOf(n);
      if (tm !== null && !out.has(tm.base)) out.set(tm.base, tm);
    } else if (h === 'typedef') {
      const tm = typedefTemplateOf(n);
      if (tm !== null && !out.has(tm.base)) out.set(tm.base, tm);
    }
    for (const it of n.items) walk(it);
  };
  walk(tree);
  return out;
}

/**
 * **泛型 typedef**（`typedef Impl<T, T> Pair<T>;`，第一百二十三刀）：声明的那个名字是
 * `tinst`。实例化出来的是**一条 typedef**（没有体），而它指的那格 `Impl<int,int>` 由队列
 * 接着造 —— 所以 115-generictdef.jnc 里旧降级发的结构体是 `Impl$int$int` 那几格，
 * `Pair$int` 自己只是个别名。
 */
export function typedefTemplateOf(node) {
  if (headOf(node) !== 'typedef') return null;
  const nm = named(node);
  if (nm === null) return null;
  for (const d of allInChain(nm.dcls, 'dcls-add', 'dcls')) {
    const dc = named(d);
    if (dc === null || headOf(dc.name) !== 'tinst') continue;
    const tn = named(dc.name);
    if (tn === null) continue;
    const base = nameText(tn.name);
    if (base === null) continue;
    const params = [];
    let ok = true;
    for (const t of allInChain(tn.targs, 'targs-add', 'targs')) {
      const p = paramOf(t);
      if (p === null) { ok = false; break; }
      params.push(p);
    }
    if (!ok || params.length === 0) continue;
    return { base, params, node, kind: 'typedef' };
  }
  return null;
}

/** 把树里**声明那一格** `tinst`（名字是 `base` 的那一个）换成实例名。 */
function renameDeclTinst(n, base, inst) {
  if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return n;
  if (headOf(n) === 'tinst') {
    const tn = named(n);
    if (tn !== null && nameText(tn.name) === base) return nameNode(inst, n);
    return n;
  }
  const items = n.items.map((x) => renameDeclTinst(x, base, inst));
  if (items.every((x, i) => x === n.items[i])) return n;
  return { ...n, items };
}
