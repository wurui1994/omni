// Omni stage0 — 链接时的**按模块改名**（ADR-0011 第 6e 步的后一半）
//
// 为什么要这一份：`link.js` 把整棵 import 树拼成**一个** Program，于是所有模块级名字共用
// 一个作用域。撞名原来是硬错（"rename one"），而量出来那一堆在 `ext/*/tograph.js` 上
// **拦不住**：`toNode` / `nameOf` / `many` / `OPS` / `MAPS` 在每一门里都是最自然的名字，
// 一次普通的功能改动就能撞一格（cpp 那门加 map 时 98 -> 99，量到的）。
//
// 于是这一层学会改名。三条纪律（都在这一份里落地）：
//   1. **留头一个**：按依赖序（`order`）先来的那个模块保住原名，后来的改成 `名字$模块短名`。
//      于是诊断与栈里看见的名字仍然认得出是谁。
//   2. **只动声明与引用，靠真作用域判**：形参 / 局部 / catch / 类名 / for 头 都会遮住模块级
//      那一格。所以是一趟带作用域栈的遍历，而不是文本替换 —— `frontend-js/lower.js` 的 `op`
//      那一格就是文本替换必错的样本（158 处字段名 `op:` 与约 90 处形参同名）。
//   3. **属性名不是名字**：`x.op` 的 `op`、`{ op: 1 }` 的键、`case` 标签、`break lbl` 的标号
//      都不许动。对象字面量的简写（`{ op }`）**展开**成 `{ op: op$2 }` —— 键留原样、值改名。
//
// 走法是**通用遍历**（按结构走所有子节点），不是 52 种节点一条条列：一条条列的那份会在
// 加语法（比如 `export *`）的那天漏掉一格，而漏掉的表现是**静默读错名字**。
// 例外只有上面第 3 条那几处，它们写成一张小表（`SKIP`）。

/** 这两格属性不是子节点（位置信息）。别的格子按结构走 —— 字符串与数自然被 `isNode` 挡住。 */
const NOT_NODE = new Set(['span', 'loc']);

/** 一个节点上**不许当引用走**的那几格（按节点类型分） */
const SKIP = {
  Member: (n) => (n.computed ? [] : ['property']),
  Labeled: () => ['label'],
  Break: () => ['label'],
  Continue: () => ['label'],
};

/** 是不是一格 AST 节点（有 type 的对象） */
const isNode = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && typeof x.type === 'string';

/** 一格绑定模式绑了哪些名字（与 link.js 的 `bindingNames` 同一条规矩） */
function patNames(pat, out) {
  if (!pat || typeof pat !== 'object') return out;
  switch (pat.type) {
    case 'Ident': out.push(pat.name); break;
    case 'AssignPattern': patNames(pat.left, out); break;
    case 'ArrayPattern':
      for (const el of pat.elements ?? []) patNames(el, out);
      patNames(pat.rest, out);
      break;
    case 'ObjectPattern':
      for (const p of pat.props ?? []) patNames(p.value, out);
      patNames(pat.rest, out);
      break;
    default: break;
  }
  return out;
}

/** `var` 是函数作用域的：整个函数体里的 `var` 都要在函数那一层挡住（不进嵌套函数） */
function varNames(x, out) {
  if (Array.isArray(x)) { for (const y of x) varNames(y, out); return out; }
  if (!isNode(x)) return out;
  if (x.type === 'FuncDecl' || x.type === 'FuncExpr' || x.type === 'Arrow') return out;
  if (x.type === 'VarDecl' && x.kind === 'var') for (const d of x.decls) patNames(d.id, out);
  if (x.type === 'FuncDecl') out.push(x.id);
  for (const k of Object.keys(x)) {
    if (k === 'span' || k === 'loc') continue;
    varNames(x[k], out);
  }
  return out;
}

/** 一个块里**直接**声明的那些名字（`let` / `const` / `class` / 函数声明） */
function blockNames(stmts, out) {
  for (const s of stmts ?? []) {
    if (!isNode(s)) continue;
    if (s.type === 'FuncDecl' || s.type === 'ClassDecl') out.push(s.id);
    else if (s.type === 'VarDecl') for (const d of s.decls) patNames(d.id, out);
  }
  return out;
}

/** 函数那一层挡住的名字：形参 + 自己的名字 + 函数体里所有 `var` 与函数声明 */
function funcNames(n, out) {
  for (const p of n.params ?? []) patNames(p, out);
  patNames(n.rest, out);
  if (n.type === 'FuncExpr' && typeof n.id === 'string') out.push(n.id);
  if (isNode(n.body)) varNames(n.body.type === 'Block' ? n.body.body : n.body, out);
  else varNames(n.body, out);
  return out;
}

/** 一格节点自己开不开新作用域、开的话挡住哪些名字（回 null = 不开） */
function shadowed(n) {
  switch (n.type) {
    case 'FuncDecl': case 'FuncExpr': case 'Arrow': return funcNames(n, []);
    case 'Block': return blockNames(n.body, []);
    // `for (const x of xs)` / `for (let i = 0; …)`：头上那格声明只在循环里算
    case 'For': {
      const out = [];
      if (isNode(n.init) && n.init.type === 'VarDecl') for (const d of n.init.decls) patNames(d.id, out);
      return out;
    }
    case 'ForIn': case 'ForOf':
      // `left` 是模式（`declKind` 给的是 let/const/var；没有 declKind 就是给现成的名字赋值）
      return n.declKind ? patNames(n.left, []) : [];
    // 类的名字在自己的体里也看得见（`class A { f() { return A; } }`）
    case 'ClassDecl': case 'ClassExpr': return typeof n.id === 'string' ? [n.id] : [];
    default: return null;
  }
}

/**
 * 一趟改名：`ren` 是"旧名 -> 新名"，只改**解析到模块级那一格**的引用与声明。
 *
 * `masked` 是"这一层往里被遮住的名字"——遮住了就一个字都不动。`catch (e)` 那一格
 * 单独处理（它的形参只在 handler 里算）。
 */
function walk(x, ren, masked) {
  if (Array.isArray(x)) { for (const y of x) walk(y, ren, masked); return; }
  if (x === null || typeof x !== 'object') return;
  /* **没有 `type` 的那些小对象也要走**：`VarDecl.decls` 的每一格是 `{ id, init }`、
   * 类成员是 `{ kind, key, computed, value, … }` —— 头一版只认"有 type 的节点"，
   * 于是 `const MAPS = …` 那种模块级常量一个都没改到（量出来的：函数声明改了、常量没改）。
   * 键那一格照旧只在 `computed` 时当引用走。 */
  if (!isNode(x)) {
    for (const k of Object.keys(x)) {
      if (NOT_NODE.has(k)) continue;
      if (k === 'key' && x.computed !== true) continue;
      walk(x[k], ren, masked);
    }
    return;
  }

  if (x.type === 'Ident') {
    const to = ren.get(x.name);
    if (to !== undefined && !masked.has(x.name)) x.name = to;
    return;
  }

  /* 简写要展开：`{ op }` -> `{ op: op$2 }`（键留原样、值改名）。键在这一层不当引用走。 */
  if (x.type === 'Object') {
    for (const p of x.props ?? []) {
      if (p.computed) walk(p.key, ren, masked);
      if (p.shorthand === true && isNode(p.value) && p.value.type === 'Ident'
        && ren.has(p.value.name) && !masked.has(p.value.name)) {
        p.shorthand = false;
      }
      for (const k of Object.keys(p)) {
        if (NOT_NODE.has(k) || k === 'key') continue;
        walk(p[k], ren, masked);
      }
    }
    return;
  }

  /* `try { } catch (e) { }`：catch 的形参（`param`）只遮住 `handler` 那一段。 */
  if (x.type === 'Try') {
    walk(x.block, ren, masked);
    if (x.handler !== null && x.handler !== undefined) {
      const inner = new Set(masked);
      for (const nm of patNames(x.param, [])) inner.add(nm);
      walk(x.handler, ren, inner);
    }
    walk(x.finalizer, ren, masked);
    return;
  }

  const own = shadowed(x);
  const inner = own === null || own.length === 0 ? masked : new Set([...masked, ...own]);
  /* **声明的名字是字符串，不是 Ident 节点**（`function f(){}` 的 `id`、`class A {}` 的 `id`）——
   * 量出来的：头一版只改 Ident 节点，于是模块级的函数声明一个都没改到，撞名照旧。
   * 改它要用**外层**那份遮蔽（自己的形参遮不住自己的名字）。 */
  if ((x.type === 'FuncDecl' || x.type === 'ClassDecl') && typeof x.id === 'string') {
    const to = ren.get(x.id);
    if (to !== undefined && !masked.has(x.id)) x.id = to;
  }
  const skip = SKIP[x.type] === undefined ? [] : SKIP[x.type](x);
  for (const k of Object.keys(x)) {
    if (NOT_NODE.has(k) || skip.includes(k)) continue;
    if (k === 'id' && typeof x.id === 'string') continue;
    /* 类与对象里的成员键（`{ key, computed, value }` 那种形状）由 Object 那一支管；
       类体这儿走通用路，键靠 `computed` 分。 */
    if (k === 'key' && x.computed !== true) continue;
    walk(x[k], ren, inner);
  }
}

/** 模块短名：拿路径末两段拼一格能读的后缀（`ext/cpp/tograph.js` -> `cpp_tograph`） */
function tagOf(path) {
  const parts = String(path).split('/').filter((p) => p !== '');
  const file = (parts[parts.length - 1] ?? 'mod').replace(/\.[^.]*$/, '');
  const dir = parts.length > 1 ? parts[parts.length - 2] : '';
  return `${dir === '' ? '' : `${dir}_`}${file}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * **谁改名、改成什么**（按依赖序：先来的保住原名）。
 *
 * @param {any[]} order 模块，依赖排在前面（`link.js` 的 `order`）
 * @param {(s:any)=>string[]} declNamesOf 一条声明绑了哪些模块级名字
 * @returns {Map<string, Map<string,string>>} 模块路径 -> （旧名 -> 新名）
 */
export function planRenames(order, declNamesOf) {
  /* 先把所有模块级名字收一遍：新名字不许撞上**任何**一个已有名字（不然改完又撞）。 */
  const taken = new Set();
  for (const m of order) for (const s of m.body) for (const n of declNamesOf(s)) taken.add(n);

  const owner = new Map();
  const plan = new Map();
  for (const m of order) {
    for (const s of m.body) {
      for (const n of declNamesOf(s)) {
        const prev = owner.get(n);
        if (prev === undefined || prev === m.path) { owner.set(n, m.path); continue; }
        let ren = plan.get(m.path);
        if (ren === undefined) { ren = new Map(); plan.set(m.path, ren); }
        if (ren.has(n)) continue;              // 同一个模块里同名两次：第一次就定了
        let cand = `${n}$${tagOf(m.path)}`;
        let k = 2;
        while (taken.has(cand)) { cand = `${n}$${tagOf(m.path)}_${k}`; k += 1; }
        taken.add(cand);
        ren.set(n, cand);
        owner.set(cand, m.path);
      }
    }
  }
  return plan;
}

/**
 * 把一个模块里那些名字改掉：body 走一趟（带作用域），导出表与改名导出跟着改。
 *
 * 导出表记的是"导出名 -> 本地名"，引用方按**导出名**找过来 —— 所以导出名不动、
 * 本地名跟着改，跨模块那一头就自动连上了。
 */
export function applyRenames(m, ren) {
  if (ren === undefined || ren.size === 0) return;
  walk(m.body, ren, new Set());
  for (const [exported, local] of [...m.exports]) {
    const to = ren.get(local);
    if (to !== undefined) m.exports.set(exported, to);
  }
  for (const a of m.aliases) {
    const to = ren.get(a.from);
    if (to !== undefined) a.from = to;
  }
}

/**
 * **导入这一侧也得跟着改**：提供方的本地名改了（或者本来就与导入名不同），
 * 那么这个模块里对它的引用要指到**真正那个名字**上。
 *
 * 这比原来那招（摊一句 `const 本地名 = 提供方名;`）更对两件事：
 *   * 不用再占一格模块级名字 —— 那一格正是撞名的来源之一；
 *   * **活绑定**：引用直接指过去，提供方后来改了值这边看得见（`let` 那种）。
 *
 * 回"这个模块里被改写过的本地名"，好让 `link.js` 那边**别再摊那句绑定**。
 *
 * @param {any} m 模块
 * @param {Map<string, any>} mods 路径 -> 模块
 * @returns {Set<string>} 已经靠改写解决掉的本地名
 */
export function renameImports(m, mods) {
  const ren = new Map();
  const done = new Set();
  for (const imp of m.imports) {
    const target = mods.get(imp.path);
    if (target === undefined) continue;
    for (const sp of imp.specs) {
      if (sp.kind !== 'named') continue;
      const provider = target.exports.get(sp.imported);
      if (provider === undefined || provider === sp.local) continue;
      ren.set(sp.local, provider);
      done.add(sp.local);
    }
  }
  if (ren.size > 0) walk(m.body, ren, new Set());
  return done;
}
