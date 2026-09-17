// ext/awk/tograph.js —— **awk 的树 -> 节点图**（第六个前端，形状差得最远的一门）
//
// 这一份要处理一件前五门都没有的事：**awk 没有声明**。`acc = 0` 既是赋值也是"第一次
// 出现"，而且函数里除了形参没有局部量（`ext/awk/SPEC.md` §四第 1 条：region 那一栏
// 可以是空的）。图上 `set` 要求名字已经绑过 —— 所以映射得**自己把名字先绑出来**：
// 扫一遍这一段里被赋值的名字，在它所在的 region 顶上补一串 `bind`。
//
// 这不是给 awk 开特例，是"**一门语言的形状与节点清单的差**由它自己的映射补上"——
// 与 go 补一格 `call main`、lua 把 `for` 拆成 region+loop+set 同一条道理。
//
// 这一批**不接 record-loop**（隐式主循环）：`ext/awk/SPEC.md` §3.2 已经把它定成
// "只有 awk 一家的节点，放在 ext/awk 底下"，而它要的输入源与字段视图都还没有。
// 所以这一份只收 `BEGIN { … }` 与 `function`；别的 pattern-action 当场报，不猜。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, threePart, elseOf, ops, binOf, retOf, branchOf, loopExit,
  mapNew, mapGet, mapSet, mapHas, truthyLit,
} from '../../src/core/graph/fromtree.js';


const OPS = ops();

const many = (xs) => xs.map(toNode).flat();
const nameOf = (x) => (tag(x) === 'name' ? leaf(kids(x)[0]) : leaf(x));

/** 扫一段树里所有"被赋值的名字" —— 那就是这一段要补的 `bind`（awk 没有声明）。 */
function assignedNames(x, out = new Set()) {
  if (!isList(x)) return out;
  if (tag(x) === 'assign' || tag(x) === 'postinc' || tag(x) === 'preinc'
    || tag(x) === 'postdec' || tag(x) === 'predec') {
    const t = kids(x).find((y) => tag(y) === 'name');
    if (t !== undefined) out.add(nameOf(t));
  }
  for (const k of kids(x)) assignedNames(k, out);
  return out;
}

/** 一段体（函数体 / BEGIN 块）：先补 bind，再放语句。 */
function bodyOf(blk, params = []) {
  const stmts = blk === undefined ? [] : many(kids(blk));
  // **awk 的数组就是 map**（关联数组）—— 带下标用过的名字补的是 `map-new` 那一格，
  // 不是 `null`。这一格不用回问类型：awk 里所有下标都是 map，没有第二种可能。
  const arrays = blk === undefined ? new Set() : arrayNames(blk);
  const names = [...assignedNames(blk)]
    .filter((n) => n !== null && !params.includes(n) && !arrays.has(n));
  return [
    ...[...arrays].filter((n) => !params.includes(n))
      .map((n) => node('bind', { init: mapNew() }, { name: n })),
    ...names.map((n) => node('bind', { init: lit(null) }, { name: n })),
    ...stmts,
  ];
}

/** 带下标用过的名字（`m["a"]` / `"a" in m`）—— awk 里那就是一格关联数组。 */
function arrayNames(x, out = new Set()) {
  if (!isList(x)) return out;
  if (tag(x) === 'index') out.add(nameOf(kids(x)[0]));
  if (tag(x) === 'in') out.add(nameOf(kids(x)[1]));
  for (const k of kids(x)) arrayNames(k, out);
  return out;
}

/** `(subscript e)` -> 那一格键。多维下标（`m[i,j]`）这一批不接 —— 明说，不猜。 */
function keyOf(sub) {
  const ks = tag(sub) === 'subscript' ? kids(sub) : [sub];
  if (ks.length !== 1) throw new Error('awk->graph: 多维下标（m[i,j]）还没接');
  return toNode(ks[0]);
}

function toNode(x) {
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: leaf(kids(x)[0]) });
    case 'name': return node('ref', {}, { name: leaf(kids(x)[0]) });
    case 'paren': return toNode(kids(x)[0]);
    case 'expr': return toNode(kids(x)[0]);
    case 'block': return node('region', { body: many(kids(x)) });
    // `m["a"]` -> map-get，`"a" in m` -> map-has。**awk 的数组就是 map** ——
    // 所以这一格不像 go / V 那样要先分清"数组还是字典"，awk 里没有第二种可能。
    case 'index': return mapGet(
      node('ref', {}, { name: nameOf(kids(x)[0]) }),
      keyOf(kids(x)[1]),
    );
    case 'in': return mapHas(
      node('ref', {}, { name: nameOf(kids(x)[1]) }),
      toNode(kids(x)[0]),
    );

    case 'bin': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'awk' });
    }
    case 'cat': return node('prim', { args: many(kids(x)) }, { name: 'concat' });
    // 一元那两格：awk 的语法也给它们各自一条产生式（`(neg …)` / `(not …)`）。
    // 与 lua 那一份同一个错：原来写的 `case 'un'` 是**死代码**（deadcase.js 量出来的）。
    case 'neg': return un('-', toNode(kids(x)[0]));
    case 'not': return un('not', toNode(kids(x)[0]));
    case 'assign': {
      const [op, target, value] = kids(x);
      // 左边带下标 ⇒ map-set（awk 的数组就是关联数组）。`+=` 一族的左值也可以带下标，
      // 那时读一格再写回去 —— 与名字那一侧同一条"不给复合赋值开节点"
      if (tag(target) === 'index') {
        const obj = node('ref', {}, { name: nameOf(kids(target)[0]) });
        const key = keyOf(kids(target)[1]);
        if (leaf(op) === '=') return mapSet(obj, key, toNode(value));
        const o2 = OPS.get(String(leaf(op)).slice(0, -1));
        if (o2 === undefined) throw new Error(`awk->graph: 这个复合赋值还没接：${leaf(op)}`);
        return mapSet(obj, key, bin(o2, mapGet(obj, key), toNode(value)));
      }
      const name = nameOf(target);
      if (leaf(op) === '=') return node('set', { value: toNode(value) }, { name });
      // `+=` 一族：`a op= b` 就是 `a = a op b`（**不给它开节点** —— 一格附属都不用）
      const o = OPS.get(String(leaf(op)).slice(0, -1));
      if (o === undefined) throw new Error(`awk->graph: 这个复合赋值还没接：${leaf(op)}`);
      return node('set', {
        value: bin(o, node('ref', {}, { name }), toNode(value)),
      }, { name });
    }
    case 'postinc': case 'preinc': case 'postdec': case 'predec': {
      const name = nameOf(kids(x)[0]);
      const op = tag(x).endsWith('inc') ? '+' : '-';
      return node('set', {
        value: bin(op, node('ref', {}, { name }), lit(1)),
      }, { name });
    }
    case 'for': {
      // `for (init; cond; post) stmt` —— 与 lua / go / freebasic 同一个形状
      const [init, cond, post, ...rest] = kids(x);
      // 形状与 go / vlang 一模一样 —— `threePart` 只写一遍（fromtree.js）
      return threePart({
        init: init === undefined ? [] : many([init]),
        cond: cond === undefined ? undefined : truthyLit(toNode(cond)),
        post: post === undefined ? [] : many([post]),
        body: rest.length === 0 ? [] : many(rest),
      });
    }
    case 'while': {
      const [cond, ...rest] = kids(x);
      // `while (1)` 那一格：字面量的真值观在编译期就定了（见 fromtree.js 的 truthyLit）
      return node('loop', { cond: truthyLit(toNode(cond)), body: many(rest) });
    }
    case 'if': {
      const [cond, then, els] = kids(x);
      // `else` 那一格是个包装（`(else …)`）—— 与 go / V 那两门同一处坑
      const e = elseOf(els);
      return branchOf(truthyLit(toNode(cond)), toNode(then), e === undefined ? undefined : toNode(e));
    }
    case 'return': return retOf(many(kids(x)));
    // `break` / `continue` -> **同一格节点**，差的只有一格附属 kind（与 go / lua 同一格）
    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'print': return node('prim', { args: many(kids(x)) }, { name: 'print' });
    case 'call': {
      const fn = leaf(kids(x)[0]);
      const args = kids(x).find((y) => tag(y) === 'args');
      const argNodes = args === undefined ? [] : many(kids(args));
      // `length(s)` 是 POSIX 的内建，落 `prim len` —— 与 lua 的 `#s` **同一格节点**
      // （写法归语言）。别的内建还没接：它们在树上与用户函数同形，靠的正是这张名字表。
      if (fn === 'length' && argNodes.length === 1) {
        return node('prim', { args: argNodes }, { name: 'len' });
      }
      return node('call', { fn: node('ref', {}, { name: fn }), args: argNodes });
    }
    case 'fn': {
      const name = leaf(kids(x)[0]);
      const ps = kids(x).find((y) => tag(y) === 'params');
      const params = ps === undefined ? [] : kids(ps).map((p) => leaf(p));
      const blk = kids(x).find((y) => tag(y) === 'block');
      return node('bind', {
        init: node('func', { body: bodyOf(blk, params) }, { params, name }),
      }, { name });
    }
    case 'rule': {
      const pat = kids(x)[0];
      const blk = kids(x).find((y) => tag(y) === 'block');
      if (tag(pat) === 'begin') return node('region', { body: bodyOf(blk) });
      throw new Error('awk->graph: 这一批只接 BEGIN —— 别的 pattern-action 要 record-loop'
        + '（ext/awk/SPEC.md §3.2：那是只有 awk 一家的节点，还没做）');
    }
    default:
      throw new Error(`awk->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 awk 的 GLR 树（`(program 项…)`）-> 一张图。 */
export function awkToGraph(tree) {
  if (tag(tree) !== 'program') throw new Error('awk->graph: 这不是 (program …)');
  return program(kids(tree).map(toNode).flat());
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 不接 record-loop / field-view（`$0` / `$1`）—— 那两格是 awk 私有的节点。
//   2. `strnum`（值同时是串与数）没接：它是挂在一条 value 边上的附属，
//      与 sbcl 的 cast 同一个位置（`ext/awk/SPEC.md` §3.3 第 2 条）。
//   3. 关联数组、getline、重定向、正则都不在这一批。
