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
/**
 * 模块路径的文本。`strid`（ID 或 STRING）是裸原子，而 `templatename` 走的是 `name`
 * 那条规则，于是 `collections.map` 是 `(qualified (name collections) map)` —— 带点的
 * 模块路径要在这里拼回去（文件是 `collections/map.asy`，那一步在 cli.js 的 loader 里）。
 */
export function asyModPath(L, node) {
  if (isAtom(node)) return node.value;
  if (!isList(node)) return null;
  const h = head(node);
  if (h === 'name') return isAtom(node.items[1]) ? node.items[1].value : null;
  if (h !== 'qualified') return null;
  const base = asyModPath(L, node.items[1]);
  const last = isAtom(node.items[2]) ? node.items[2].value : null;
  return base === null || last === null ? null : `${base}.${last}`;
}

export function asyModLoad(L, node, name) {
  return asyModLoadAs(L, node, name, name, null);
}

/**
 * 上面那条的一般形：`key` 是缓存键，`tpl` 是模板实参表（普通模块是 null）。
 * 缓存键带上实参是量出来的：`from m(T=int) access …` 写两遍，模块体只跑**一遍**，
 * 而 `T=string` 那一份是**另一个**实例（体再跑一遍、文件级变量是另一块存储）——
 * 见 ADR 里那段 `hits_int()` 是 2、`hits_str()` 是 1 的量法。
 */
export function asyModLoadAs(L, node, name, key, tpl) {
  const had = L.byKey.get(key);
  if (had !== undefined) return had;
  if (L.opts === null || L.opts.load === undefined || L.opts.load === null) {
    L.nope(node, `模块 '${name}'（这条路上没有模块加载器）`);
    return null;
  }
  for (const k of L.loading) {
    if (k === key) { L.nope(node, `循环 import（'${name}' 正在加载）`); return null; }
  }
  const tree = L.opts.load(name);
  if (tree === null || tree === undefined) {
    L.nope(node, `模块 '${name}' 找不到 —— 当前目录下没有 ${name}.asy`
      + '（asy 的模块是按 CWD 找的，量过；标准库那些 plain/graph/… 这一刀还没有）');
    return null;
  }
  const u = L.unitNew(tree, key);
  u.tpl = tpl;
  L.byKey.set(key, u);
  L.loading.push(key);
  const prev = L.unitIn(u);
  // 模板实参先坐进别名表：模块体里 `T` 就是一个 typedef，位置 -1 让它在第 0 项之前就可见。
  // 类型在这一层就是字符串，所以"替换类型参数"这件事一条别名就够了。
  if (tpl !== null) for (const [pn, pt] of tpl) L.tyAlias.set(pn, [{ t: pt, at: -1 }]);
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
    // `记录名.方法名` 不并：方法跟着 struct 走（见 visibleMethods）。
    // `operator ..` 名字里也有点，它可不是方法 —— 所以这一条只看**不是算符**的名字。
    if (nm.indexOf('.') >= 0 && !nm.startsWith('operator ')) continue;
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
    // 改名是收的（量过：`from m access A as B; B b = new B;` asy 通）。能收是因为
    // 「这里叫什么」（recVis 的键）与「那个类型是什么」（rec.name）在第三十一刀分开了 ——
    // 模板模块的实例非得这么分不可，普通模块跟着白捡。
    // **后来的盖住先来的**（第三十八刀）：两个模块里都有 `struct Dup`，两条 import 都写上，
    // asy 那边这个名字指的是**后**一条那份（量过 `d.y=5; write(d.y)` 印 5）。以前这里
    // 「有了就不覆盖」，于是指的是前一条那份 —— 那时它撞在"两个模块里都有 struct"那条
    // 诊断上，问题看不见；真名会打散之后就看得见了。
    const had = L.recVis.get(key);
    // **同一份类型再进来一次，位置不后移**（第四十四刀）：`import plain;` 里一个
    // `access`/`import` 会把内建面那些 struct（pen/path/frame/file/transform）
    // 顺着模块的表再带一遍，按上面那条"后来的盖住先来的"就会把它们的可见位置推到
    // 那条 import 那一行 —— 于是前面几百行里用 pen 的地方全报"声明在后面"（量到 231 条，
    // 一处毛病）。同一个 rec 对象就是同一个类型，遮不遮的问题根本不存在。
    if (had !== undefined && had.rec === e.rec) continue;
    if (had === undefined || had.at <= at) L.recVis.set(key, { rec: e.rec, at: at });
  }
  // typedef 的别名跟着 import 一起进来（asy 那边也是：`import graph;` 之后
  // `splinetype` 就是个类型名了）。改名那种写法（`from m access X as Y;`）也收 ——
  // 别名的右边是**类型文本**，跟它叫什么名字无关（量过 asy 通）。
  for (const [nm, e] of u.tyAlias) {
    const key = only === null ? nm : only.get(nm);
    if (key === undefined) continue;
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
    const src = asyModPath(L, n.items[1]);
    if (src === null) return L.nope(n, '`from … access` 的这种模块名');
    const names = n.items[2];
    if (isList(names) && head(names) === 'wildcard') return L.nope(n, '`from … access *`');
    // 第三格是模板实参（`from m(T=int) access …`）；没有第三格就是普通的 from-access
    let tpl = null;
    let key = src;
    if (n.items.length !== 3) {
      tpl = asyTplArgs(L, n.items[3]);
      if (tpl === null) return null;
      let sig = '';
      for (const [pn, pt] of tpl) sig = sig === '' ? `${pn}=${pt}` : `${sig},${pn}=${pt}`;
      key = `${src}(${sig})`;
    }
    const only = new Map();
    for (const p of L.flat(names, 'idpairs')) {
      const pr = asyIdPair(L, p);
      if (pr === null) { L.nope(p, '`from … access` 里的这种写法'); continue; }
      only.set(pr.src, pr.dst);
    }
    const u = asyModLoadAs(L, n, src, key, tpl);
    if (u === null) return null;
    asyModMerge(L, n, u, at, only);
    asyModCallAt(L, at, u);
    return null;
  }
  // `typedef import(K, V);` —— 模板模块的头一句。它自己不产生任何东西：实参在
  // asyModLoadAs 里已经坐进别名表了，这里只核对"写的那几个名字正是给了实参的那几个"。
  if (h === 'receive-typedef') {
    if (L.unit.tpl === null) {
      return L.err(n, '`typedef import(…)` 只能写在模板模块里 —— 这个文件不是被 '
        + '`from m(T=…) access …` 实例化进来的（asy 那边报 "templated module access '
        + 'requires template parameters"）');
    }
    for (const p of L.flat(n.items[1], 'typeparams')) {
      const nm = isList(p) && isAtom(p.items[1]) ? p.items[1].value : null;
      if (nm === null) { L.nope(p, '`typedef import(…)` 里的这种写法'); continue; }
      if (!L.unit.tpl.has(nm)) {
        L.err(n, `模板参数 '${nm}' 没给实参 —— 实例化那一句里没有 \`${nm}=…\``);
      }
    }
    return null;
  }
  return L.nope(n, `模块声明 '${h}'`);
}

/** `(formals (formal 类型 (decidstart 名字)) …)` -> Map(名字 -> 类型文本)；有一格不成就回 null */
export function asyTplArgs(L, node) {
  const out = new Map();
  for (const f of L.flat(node, 'formals')) {
    if (!isList(f) || head(f) !== 'formal' || f.items.length !== 3) {
      L.nope(f, '模板实参的这种写法（要 `名字=类型`）');
      return null;
    }
    const d = f.items[2];
    const nm = isList(d) && head(d) === 'decidstart' && isAtom(d.items[1]) ? d.items[1].value : null;
    if (nm === null) { L.nope(f, '模板实参的这种写法（要 `名字=类型`）'); return null; }
    const t = L.type(f.items[1], '模板实参');
    if (t === null) return null;
    if (out.has(nm)) { L.err(f, `模板参数 '${nm}' 给了两遍`); return null; }
    out.set(nm, t);
  }
  if (out.size === 0) { L.nope(node, '空的模板实参表'); return null; }
  return out;
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
