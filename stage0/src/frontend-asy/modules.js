// Omni stage0 — asy 前端的**模块**这一族（import / access / unravel / from-access）
//
// 从 lower.js 搬出来的第六摊，拆法同 calls.js：第一个形参 `L` 就是那个降级器。
//
// asy 的模块语义是量出来的，不是照 C 的头文件想的：一个模块**跑一遍**（它的顶层语句是
// 有副作用的），名字按 `import` 那一句的位置往当前文件里合（asyModMerge），
// `access` 只给个限定名不合名字，`unravel` 才把名字摊开。
//
// 这一摊唯一往回指的边是 `L.declPass(…)`（加载一个模块要先给它跑一遍声明遍）——
// 那是 decls.js 里的函数，而 decls.js 又要 import 这里的三个，所以那一条走 lower.js
// 上的转接方法，不然就是环，而自举那条路的加载器禁止环。

import { isList, isAtom, head } from '../sexpr/read.js';
import { asyUserCall } from './calls.js';

/* -------------------------------------------------------------- 模块 */

/** `(idpair NAME)` -> {src, dst}；`(idpair SRC as DST)` -> 改了名的那份；别的回 null */
export function asyIdPair(L, n) {
  if (!isList(n) || head(n) !== 'idpair') return null;
  const a = isAtom(n.items[1]) ? n.items[1].value : null;
  if (a === null) return null;
  if (n.items.length === 2) return { src: a, dst: a };
  if (n.items.length !== 4) return null;
  const as = isAtom(n.items[2]) ? n.items[2].value : null;
  const b = isAtom(n.items[3]) ? n.items[3].value : null;
  if (as !== 'as' || b === null) return null;
  return { src: a, dst: b };
}

/**
 * 模块 `name` 的单元。同一个模块只加载一次（量过：`import m; import m;` 体只跑一遍），
 * 加载 = 解析（`opts.load`，文件 IO 与语法表都在 cli.js）+ 立刻走一遍**声明遍** ——
 * 声明遍走完这个单元的导出表就是全的，import 它的人才有东西可并。
 */
export function asyModLoad(L, node, name) {
  const had = L.byKey.get(name);
  if (had !== undefined) return had;
  if (L.opts === null || L.opts.load === undefined || L.opts.load === null) {
    L.nope(node, `模块 '${name}'（这条路上没有模块加载器）`);
    return null;
  }
  for (const k of L.loading) {
    if (k === name) { L.nope(node, `循环 import（'${name}' 正在加载）`); return null; }
  }
  const tree = L.opts.load(name);
  if (tree === null || tree === undefined) {
    L.nope(node, `模块 '${name}' 找不到 —— 当前目录下没有 ${name}.asy`
      + '（asy 的模块是按 CWD 找的，量过；标准库那些 plain/graph/… 这一刀还没有）');
    return null;
  }
  const u = L.unitNew(tree, name);
  L.byKey.set(name, u);
  L.loading.push(name);
  const prev = L.unitIn(u);
  L.declPass(u);
  L.unitOut(prev);
  L.loading.pop();
  return u;
}

/** 候选换一个"可见位置"：import 进来的名字，可见位置是那条 import 语句的下标 */
export function asyCandAt(L, c, at) {
  return {
    ret: c.ret, params: c.params, ps: c.ps, node: c.node, sym: c.sym, base: c.base,
    pfx: c.pfx, unit: c.unit, dat: c.dat === undefined ? c.at : c.dat, at: at,
    mat: c.mat, rec: c.rec, ctor: c.ctor,
  };
}

/**
 * 把模块 `u` 的导出并进当前单元，可见位置是 `at`（那条 import 语句的下标）。
 * 三条量过的语义因此都是白捡的：
 *   - **顺序解析**：import 写在后面时前面那几行看不见那些名字；
 *   - **本地的声明遮住 import 进来的**（同名的候选表里本地那份在后面，at 更大）；
 *   - **传递性**：并的是模块**自己的**表，而那张表里已经含着它 import 进来的东西
 *     （量过 `import mid;` 之后 mid import 的名字也裸着可见）。
 * `only` 不是 null 时只并那几个名字（`from m access f, g;`）。
 */
export function asyModMerge(L, node, u, at, only) {
  for (const [nm, list] of u.funcs) {
    // `记录名.方法名` 不并：方法跟着 struct 走（见 visibleMethods）
    if (nm.indexOf('.') >= 0) continue;
    const key = only === null ? nm : only.get(nm);
    if (key === undefined) continue;
    const dst = L.funcs.has(key) ? L.funcs.get(key) : [];
    for (const c of list) {
      let dup = false;
      for (const d of dst) if (d.sym === c.sym) dup = true;
      if (dup) continue;   // 同一个模块引两遍：名字还是那一份
      dst.push(asyCandAt(L, c, at));
    }
    L.funcs.set(key, dst);
  }
  for (const [nm, list] of u.globals) {
    const key = only === null ? nm : only.get(nm);
    if (key === undefined) continue;
    const dst = L.globals.has(key) ? L.globals.get(key) : [];
    for (const g of list) {
      let dup = false;
      for (const d of dst) if (d.sym === g.sym) dup = true;
      if (dup) continue;
      // 同一块存储：模块里改它、这边也改它（量过两边都看得见对方的改动）
      dst.push({ sym: g.sym, type: g.type, at: at, ok: g.ok });
    }
    L.globals.set(key, dst);
  }
  for (const [nm, e] of u.recVis) {
    const key = only === null ? nm : only.get(nm);
    if (key === undefined) continue;
    if (key !== nm) { L.nope(node, `给 import 进来的 struct '${nm}' 改名`); continue; }
    if (!L.recVis.has(key)) L.recVis.set(key, { rec: e.rec, at: at });
  }
  // typedef 的别名跟着 import 一起进来（asy 那边也是：`import graph;` 之后
  // `splinetype` 就是个类型名了）。改名那种写法（`from m access X as Y;`）不收 ——
  // 与上面 struct 那一条同一个理由：别名的名字在这一刀不参与重命名。
  for (const [nm, e] of u.tyAlias) {
    const key = only === null ? nm : only.get(nm);
    if (key === undefined) continue;
    if (key !== nm) { L.nope(node, `给 import 进来的 typedef '${nm}' 改名`); continue; }
    // 位置一律按 import 那一行算（与 recVis 同一条），所以只带**模块里最后那一份**
    if (!L.tyAlias.has(key)) L.tyAlias.set(key, [{ t: e[e.length - 1].t, at: at }]);
  }
  // 用户定义的转换（第二十七刀）：`import m;` 把它们一起带进来 —— 它们不挂在某个名字上，
  // 所以 `only`（`from m access f, g;` 的那张改名表）管不到它们，那种写法这边就不并。
  if (only !== null) return;
  for (const [to, list] of u.casts) {
    const dst = L.casts.has(to) ? L.casts.get(to) : [];
    for (const c of list) {
      let dup = false;
      for (const d of dst) if (d.sym === c.sym) dup = true;
      if (dup) continue;
      dst.push({
        ret: c.ret, params: c.params, ps: c.ps, node: c.node, sym: c.sym, pfx: c.pfx,
        unit: c.unit, dat: c.dat, at: at, to: c.to, src: c.src, ec: c.ec,
      });
    }
    L.casts.set(to, dst);
  }
}

/**
 * `import m;` / `access m;` / `access m as mm;` / `from m access f, g;`（第二十五刀）。
 * 量过的四条（`asy -noV`）：
 *   - **模块体在那一行跑**，而且只跑一次（`import m; import m;` 只印一遍）；
 *   - `access` 也跑体，但只给限定名（`access m; write(mv);` 报 "no matching variable"）；
 *   - `import` 之后裸名字与 `m.x` 是**同一块存储**，两边都能改；
 *   - 别名（`access m as mm;`）与 `from m access f;` 都通。
 * 门外的：`unravel`、`include`、参数化模块（`from c.map(K=int) access …`）、通配的
 * `from m access *`。
 */
export function asyModStmt(L, n, at) {
  const h = head(n);
  if (h === 'import' || h === 'access') {
    const list = h === 'import' ? [n.items[1]] : L.flat(n.items[1], 'idpairs');
    for (const p of list) {
      const pr = asyIdPair(L, p);
      if (pr === null) { L.nope(p, `${h} 的这种写法`); continue; }
      const u = asyModLoad(L, p, pr.src);
      if (u === null) continue;
      L.mods.set(pr.dst, { unit: u.id, at: at });
      if (h === 'import') asyModMerge(L, p, u, at, null);
      asyModCallAt(L, at, u);
    }
    return null;
  }
  if (h === 'from-access') {
    if (n.items.length !== 3) return L.nope(n, '参数化的 `from … access`（模板模块）');
    const src = isAtom(n.items[1]) ? n.items[1].value : null;
    if (src === null) return L.nope(n, '`from … access` 的这种模块名');
    const names = n.items[2];
    if (isList(names) && head(names) === 'wildcard') return L.nope(n, '`from … access *`');
    const only = new Map();
    for (const p of L.flat(names, 'idpairs')) {
      const pr = asyIdPair(L, p);
      if (pr === null) { L.nope(p, '`from … access` 里的这种写法'); continue; }
      only.set(pr.src, pr.dst);
    }
    const u = asyModLoad(L, n, src);
    if (u === null) return null;
    asyModMerge(L, n, u, at, only);
    asyModCallAt(L, at, u);
    return null;
  }
  return L.nope(n, `模块声明 '${h}'`);
}

/** 这条 import 语句要在**它自己的位置**上调一次模块的初始化函数（体在那一行跑） */
export function asyModCallAt(L, at, u) {
  const list = L.unit.callAt.has(at) ? L.unit.callAt.get(at) : [];
  list.push(u.init);
  L.unit.callAt.set(at, list);
}

/** `(qualified (name M) NAME)` 且 M 是此处可见的模块别名时回 {unit, name}，否则 null */
export function asyModAlias(L, node) {
  if (!isList(node) || head(node) !== 'qualified') return null;
  const nm = isAtom(node.items[2]) ? node.items[2].value : null;
  if (nm === null) return null;
  const base = L.plainName(node.items[1]);
  if (base === null || !L.mods.has(base)) return null;
  const m = L.mods.get(base);
  // 顺序解析：那条 import/access 写在后面时，这里还没有这个模块
  if (m.at > L.at) return null;
  return { unit: m.unit, name: nm, mod: base };
}

/** `m.x`：模块里的文件级变量。存储是同一块（量过两边都能改） */
export function asyModVar(L, n, mq) {
  const list = L.units[mq.unit].globals.get(mq.name);
  if (list === undefined) {
    return L.nope(n, `模块限定的名字 '${mq.mod}.${mq.name}'（这一刀的 \`m.名字\` 只有`
      + '模块里的文件级变量与函数）');
  }
  const g = list[list.length - 1];
  if (!g.ok) {
    return L.nope(n, `模块限定的文件级变量 '${mq.mod}.${mq.name}'（这一刀的模块级变量`
      + '只收 int/real/bool/string）');
  }
  return { code: `(var ${g.sym})`, type: g.type };
}

/** `m.f(…)`：模块里的函数。候选表是那个模块的（限定名不受这边顺序解析的影响） */
export function asyModCall(L, n, mq) {
  const list = L.units[mq.unit].funcs.get(mq.name);
  if (list === undefined || list.length === 0) {
    return L.err(n, `模块 '${mq.mod}' 里没有函数 '${mq.name}'`);
  }
  return asyUserCall(L, n, mq.name, list);
}
