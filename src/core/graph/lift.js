// src/core/graph/lift.js —— **lambda 提升**：内层函数提到顶层，捕获当多出来的形参
//
// 为什么单开一份：core 与 c **两条腿要的是同一件事**，而"抄两份就是两套语义"这棵树上
// 吃过好几次（`primFixedType` 那张表原来在两处各一份，其中一份写漏了 `concat`）。
// core 那份从第十几刀起就在用，c 那条腿从前一律当场报"这格 func 捕获了外层的名字"——
// 于是 `chez` 那份 basics（`(define (go i acc) …)` 借 `sumto` 的 `n`）在 core 上过、
// 在 c 上跳。这一份就是把那一份挪出来给两条腿共用。
//
// ## 那一句话
//
// 函数体里 `bind` 出来的那格 `func`（chez 的内层 `define`）提到顶层去，它借的那几格
// 外面的名字变成**多出来的形参**，每处调用补上那几个实参。
//
// **为什么是提升而不是闭包**：这一档的内层函数**只当被调者用**（`(go 1 0)`），没跑出去
// 当值 —— 那时提升与闭包同义，而提升不必碰"环境对象 + 间接调用"那一格（那留给真闭包）。
//
// ## 三处闸门，都报不猜（`gap` 由调用方给 —— 措辞里带着"哪条腿"）
//
//   * 那个名字**跑出调用点**（当实参 / 当返回值）—— 那是真函数值，提升办不到
//   * 里层**改**了借来的那格（`set`）—— 按值传进去改不回外面，语义不同
//   * 借来的那格是外层的形参或局部才算捕获；**模块级那几格不算**（它们各腿都有落处：
//     方言的 `(global …)`、wasm 的 `(global …)`、C 的 `static`）
import { isNode, argList } from './types.js';

/** 一格或一串 —— 统一成数组（`body` 端口既可能是一格也可能是一串）。 */
const asArr = (x) => (Array.isArray(x) ? x : (x === undefined || x === null ? [] : [x]));

/** 走遍一棵树上的每一格节点。 */
function walkAll(x, f) {
  if (Array.isArray(x)) {
    for (const y of x) walkAll(y, f);
    return;
  }
  if (!isNode(x) || x.op === undefined) return;
  f(x);
  for (const k of Object.values(x.ins ?? {})) walkAll(k, f);
}

/** 一棵树重建式地改写：`f(n)` 回替换品（回 undefined 就往孩子里走）。 */
export function mapNodes(x, f) {
  if (Array.isArray(x)) return x.map((y) => mapNodes(y, f));
  if (!isNode(x) || x.op === undefined) return x;
  const rep = f(x);
  if (rep !== undefined) return rep;
  const ins = {};
  for (const k of Object.keys(x.ins ?? {})) ins[k] = mapNodes(x.ins[k], f);
  return { ...x, ins: ins };
}

/** 提升之后每处调用补上捕获那几格实参（顺带把名字换成提上去之后的那个）。 */
export function addCaps(x, from, to, caps) {
  return mapNodes(x, (n) => {
    if (n.op !== 'call') return undefined;
    const f = n.ins.fn;
    if (!(isNode(f) && f.op === 'ref' && f.attrs.name === from)) return undefined;
    const args = argList(n, 'args').map((a) => addCaps(a, from, to, caps));
    const extra = caps.map((c) => ({ op: 'ref', ins: {}, attrs: { name: c }, id: -1 }));
    return {
      ...n,
      ins: { ...n.ins, fn: { ...f, attrs: { ...f.attrs, name: to } }, args: [...args, ...extra] },
    };
  });
}

/** 这一段里借了哪几格外面的名字（排序过 —— 同一张图两遍要一样）。 */
export function capsOf(body, own, known) {
  const bound = new Set(own);
  walkAll(body, (n) => {
    if (n.op === 'bind') bound.add(n.attrs.name);
    if (n.op === 'func') for (const p of n.attrs.params ?? []) bound.add(String(p));
  });
  const out = new Set();
  walkAll(body, (n) => {
    /* **写也算借**：`(set 名 …)` 的名字在 attrs 上，不是一格 `ref` —— 只数 ref 的话
     * "只写不读"的那一格就漏了，落出来是一句引用不存在的名字（当场量到过：内层只
     * `set k` 时提上去的函数里那个 `k` 谁都不认识）。 */
    if (n.op === 'set') {
      const nm0 = n.attrs.name;
      if (!bound.has(nm0) && !known.has(nm0)) out.add(nm0);
      return;
    }
    if (n.op !== 'ref') return;
    const nm = n.attrs.name;
    if (!bound.has(nm) && !known.has(nm)) out.add(nm);
  });
  return [...out].sort();
}

/** 这一段里有没有给这个名字赋值。 */
export function setsNameIn(body, nm) {
  let found = false;
  walkAll(body, (n) => { if (n.op === 'set' && n.attrs.name === nm) found = true; });
  return found;
}

/** 这个名字有没有**跑出调用点**（当实参、当返回值那种）—— 那是真函数值，提升办不到。 */
export function escapes(body, nm, gap) {
  const seek = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) seek(y);
      return;
    }
    if (!isNode(x) || x.op === undefined) return;
    if (x.op === 'ref') {
      if (x.attrs.name === nm) {
        gap(`内层函数 '${nm}' 跑出了调用点（当实参 / 当返回值那种）—— 那是真函数值，`
          + '要"环境对象 + 间接调用"那一格，提升办不到');
      }
      return;
    }
    if (x.op === 'call') {
      const f = x.ins.fn;
      if (!(isNode(f) && f.op === 'ref' && f.attrs.name === nm)) seek(f);
      seek(x.ins.args);
      return;
    }
    for (const k of Object.keys(x.ins ?? {})) seek(x.ins[k]);
  };
  seek(body);
}

/**
 * 提升一层语句序。回 `{ body, lifted }` —— `body` 是这一层剩下的语句、
 * `lifted` 是提上去的那几格 `{ name, params, body }`。
 *
 * @param bodyList 这一层的语句序
 * @param owner 这一层是谁的体（提上去的名字撞了就拿它当前缀）
 * @param known 不算捕获的那些名字（顶层函数名 + 顶层绑定的名字）
 * @param taken 已经占了的顶层名字
 * @param gap 报一格有名有姓的缺口（措辞里带着"哪条腿"）
 */
export function liftBody(bodyList, owner, known, taken, gap) {
  const arr = asArr(bodyList);
  const out = [];
  const lifted = [];
  const fixes = [];
  for (const s of arr) {
    if (!(isNode(s) && s.op === 'bind' && isNode(s.ins.init) && s.ins.init.op === 'func')) {
      out.push(s);
      continue;
    }
    const nm = s.attrs.name;
    const inner = s.ins.init;
    const ps = (inner.attrs.params ?? []).map((p) => String(p));
    /* 里层还套着里层：先把它们提上来（提完的名字也算"已知"）。 */
    const sub = liftBody(inner.ins.body, nm, known, taken, gap);
    const subKnown = new Set([...known, ...sub.lifted.map((g) => g.name)]);
    const caps = capsOf(sub.body, new Set([...ps, nm]), subKnown);
    for (const c of caps) {
      if (setsNameIn(sub.body, c)) {
        gap(`内层函数 '${nm}' 改了它借来的 '${c}' —— 提升是按值传进去的，改不回外面`);
      }
    }
    escapes(arr, nm, gap);
    escapes(sub.body, nm, gap);
    const name = taken.has(nm) ? `${owner}$${nm}` : nm;
    taken.add(name);
    /* 调用点补实参：**自己那一份先应到自己身上**（递归调用），别的等这一趟走完再统一应
     * —— 同一份 fix 应两遍会把实参补两回。 */
    const my = fixes.length;
    fixes.push((x) => addCaps(x, nm, name, caps));
    const mine = { name: name, params: [...ps, ...caps], body: fixes[my](sub.body), my: my };
    for (const g of sub.lifted) lifted.push(g);
    lifted.push(mine);
    /* 这一格 bind 本身没了 —— 函数提到顶层去了。 */
  }
  let body = out;
  for (const fx of fixes) body = body.map(fx);
  for (const g of lifted) {
    for (let i = 0; i < fixes.length; i++) if (i !== g.my) g.body = fixes[i](g.body);
  }
  return { body: body, lifted: lifted };
}
