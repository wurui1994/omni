// ext/nim/tograph.js —— **Nim 的树 -> 节点图**（第九个前端）
//
// Nim 与 mojo 一样缩进即块，可它多两样别的语言没有的形状，正好各压一格：
//   * **命令式调用**（`echo sumto(5)` —— 不带括号）：树上是 `(command (name echo) (args …))`，
//     与 `(call …)` 是两条产生式、**同一格节点**（语法的形状 ≠ 节点的格数）。
//   * **`var` 段**（`var a = 1` 一行能声明好几格）：`(var-section (item (names …) (init …)))`
//     → 一串 `bind`。这也是"decl 就是 bind"那句话。
//
// pragma（`{.inline.}`）在这一批直接丢掉 —— 它是**附属节点的总入口**
// （`ext/nim/SPEC.md` §3.3 第 2 条），骨架这一批不碰。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part, groupItems, unquote,
  ops, convs, convOf, binOf, retOf, branchOf, loopExit,
  recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet, sliceOf, destructure,
  mapNew, mapGet, mapSet, mapHas, mapNames,
} from '../../src/core/graph/fromtree.js';

/**
 * 装 `Table` 的那些名字（`nimToGraph` 里一趟扫查填好）。
 * nim 的标记不是字面量而是**造它的那个调用**（`initTable[K, V]()`）—— 还是能在树上认出来，
 * 所以这一格也不必回问类型（真要回问的是 `T(x: 1)` vs `f(x = 1)`，见文件末尾的欠款）。
 */
const MAPS = new Set();
const TABLE_CTORS = new Set(['initTable', 'newTable', 'toTable']);
const isMap = (x) => tag(x) === 'name' && MAPS.has(leaf(kids(x)[0]));

/**
 * **登记过的类型名**（`type Point = object …`）与**每个 proc 的形参名**。
 *
 * 这两张表是"那笔账记错了"的证据：文档与这份文件原来都写着
 * "nim 的对象构造 `T(x: 1)` 与命名实参 `f(x = 1)` 在树上同形，要驱动器能回问类型"。
 * 量一遍就知道**在调用实参这个位置上不同形**：语法里 `IDENT "=" expr` 出 `named`、
 * `expr ":" expr` 出 `kv`（两条产生式两个标签）。剩下要判的只有"这名字是类型还是函数"，
 * 而那件事**扫一遍 `type-section` 与 `routine` 就有答案** —— 与 map 那一族同一条路子。
 */
const TYPES = new Set();
const PARAMS = new Map();

/** 扫一遍顶层：登记类型名与每个 proc 的形参名（嵌套的 routine 也一起收）。 */
function collectDecls(x) {
  if (!isList(x)) return;
  if (tag(x) === 'tdef') {
    const nm = kids(x).find((y) => tag(y) === 'n' || tag(y) === 'name');
    if (nm !== undefined) TYPES.add(leaf(kids(nm)[0]));
  }
  if (tag(x) === 'routine') {
    const nm = kids(x).find((y) => tag(y) === 'n' || tag(y) === 'name');
    const sig = part(x, 'sig');
    if (nm !== undefined && sig !== undefined) PARAMS.set(leaf(kids(nm)[0]), paramNames(sig));
  }
  for (const k of kids(x)) collectDecls(k);
}

/** 一格 `(sig …)` 里的形参名（分组写法 `(a, b: int)` 也拆开）。 */
function paramNames(sig) {
  return kids(sig).flatMap((g) => (tag(g) === 'p' ? [g] : groupItems(g)))
    .filter((p) => tag(p) === 'p')
    .map((p) => nameOf(part(p, 'names') ?? kids(p)[0]));
}

/** `var m = initTable[string, int]()` -> `'m'`（不是就给 null）。 */
function mapBindName(x) {
  if (!isList(x) || tag(x) !== 'item') return null;
  const init = part(x, 'init');
  if (init === undefined) return null;
  const rhs = kids(init)[0];
  if (rhs === undefined || tag(rhs) !== 'call') return null;
  const callee = kids(rhs)[0];
  // `initTable[string, int]()`：被调者是一格 `bracket`（泛型实参），名字在它里面
  const nm = tag(callee) === 'bracket' ? kids(callee)[0] : callee;
  if (tag(nm) !== 'name' || !TABLE_CTORS.has(leaf(kids(nm)[0]))) return null;
  return nameOf(part(x, 'names'));
}

/** 无名表的孩子是**全部** items（形参装在这种表里 —— mojo 那边踩过同一处）。 */

const OPS = ops({ div: '/', mod: '%', '&': 'concat' });
const CONV = convs({
  int8: 'int', int16: 'int', int32: 'int', int64: 'int',
  uint: 'int', uint8: 'int', uint32: 'int', uint64: 'int',
  float32: 'float', float64: 'float', '$': 'str',
});
const PRINTS = new Set(['echo', 'write', 'stdout']);

const many = (xs) => xs.map(toNode).flat();

function nameOf(x) {
  if (tag(x) === 'name' || tag(x) === 'n') return leaf(kids(x)[0]);
  if (tag(x) === 'names') return nameOf(kids(x)[0]);
  return leaf(x);
}

function toNode(x) {
  if (isList(x) && x.items.length === 0) return [];
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: unquote(leaf(kids(x)[0])) });
    case 'name': case 'n': {
      const n = leaf(kids(x)[0]);
      if (n === 'true') return node('const', {}, { value: true });
      if (n === 'false') return node('const', {}, { value: false });
      if (n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    // `p.x` -> field-get（与 lua 的 `(dot …)`、go/V 的 `(sel …)` 同一格节点）
    case 'dot': return fieldGet(toNode(kids(x)[0]), leaf(kids(x)[1]));
    case 'line': case 'body': case 'impl': return many(kids(x));
    // `block:` -> region（一段带自己作用域的语句）。nim 的 `defer:` 也挂在最近这一格上 ——
    // 那正是 region 的用处：**作用域与出口是同一格**。
    case 'block': {
      const body = part(x, 'body');
      return node('region', { body: body === undefined ? [] : many(kids(body)) });
    }
    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'expr': return toNode(kids(x)[0]);
    // `defer { … }` / `defer: …` -> scope-exit（与 go 的 defer、CL 的 unwind-protect
    // **同一格节点**：逆序、早退也跑，八家共用那一格）
    case 'defer': return node('scope-exit', { action: many(kids(x)) });

    case 'bin': {
      const [op, a, b] = kids(x);
      // `&` 是 nim 的串连接 —— 表里映到 `concat` 那格内建，与算符走同一条路
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'nim', and: ['and'], or: ['or'] });
    }
    case 'un': {
      const [op, a] = kids(x);
      // `@[1, 2, 3]`：`@` 是"数组字面量 -> seq"的算符，两格合起来就是一格 list-new
      if (leaf(op) === '@' && tag(a) === 'array-lit') return listNew(many(kids(a)));
      // `$x` 是**前缀算符**而不是调用 —— 但它与 `int(x)` / `float(x)` 是同一件事
      // （表示转换），所以查同一张转换名字表，落同一格 `conv`
      if (CONV.has(leaf(op))) return convOf(CONV.get(leaf(op)), toNode(a));
      return un(leaf(op) === 'not' ? 'not' : leaf(op), toNode(a));
    }
    case 'array-lit': return listNew(many(kids(x)));
    // `(a, b)` 元组 -> values（多值的生产侧）。nim 用元组表达"一次返回两格"，
    // CL 用 `values`、go/lua 用 `return a, b` —— **同一对节点**
    case 'tuple-lit': return node('values', { args: many(kids(x)) });
    // `xs[i]` -> index-get（nim 从 0 起，不用减）
    case 'bracket': {
      const sub = kids(part(x, 'args'))[0];
      // `xs[1 .. 2]`：nim 的范围是**含**上界 —— 图上那格不含，所以这儿 +1
      if (tag(sub) === 'bin' && leaf(kids(sub)[0]) === '..') {
        const [, a, b] = kids(sub);
        return sliceOf(toNode(kids(x)[0]), toNode(a), bin('+', toNode(b), lit(1)));
      }
      // `m["a"]` 与 `xs[0]` 在树上同形（都是 `bracket`）—— 分开靠那一趟扫查
      const obj = kids(x)[0];
      return isMap(obj) ? mapGet(toNode(obj), toNode(sub)) : indexGet(toNode(obj), toNode(sub));
    }
    // `var a = 1` / `let a = 1` / `const a = 1` —— 一段能声明好几格
    case 'var-section': case 'let-section': case 'const-section': {
      // `let (lo, hi) = f()` —— 树上是一格 `untuple`：N 个名字对 1 个右值 ⇒ 多值的消费侧
      const untuples = kids(x).filter((y) => tag(y) === 'untuple').flatMap((u) => {
        const names = kids(part(u, 'names')).map((n) => nameOf(n));
        return destructure(names, toNode(kids(part(u, 'init'))[0]));
      });
      const items = kids(x).filter((y) => tag(y) === 'item').map((it) => {
        const init = part(it, 'init');
        return node('bind', {
          init: init === undefined ? lit(null) : toNode(kids(init)[0]),
        }, { name: nameOf(part(it, 'names')) });
      });
      return [...untuples, ...items];
    }
    case 'assign': {
      const [op, lhs, rhs] = kids(x);
      const o = leaf(op) === '=' ? null : OPS.get(String(leaf(op)).replace('=', ''));
      if (leaf(op) !== '=' && o === undefined) {
        throw new Error(`nim->graph: 这个复合赋值还没接：${leaf(op)}`);
      }
      // 左边是一格字段（`p.y = 5`）或一格下标（`xs[1] = 5`）⇒ field-set / index-set
      if (tag(lhs) === 'dot') {
        const obj = () => toNode(kids(lhs)[0]);
        const f = leaf(kids(lhs)[1]);
        const v = o === null ? toNode(rhs) : bin(o, fieldGet(obj(), f), toNode(rhs));
        return fieldSet(obj(), f, v);
      }
      if (tag(lhs) === 'bracket') {
        const obj = () => toNode(kids(lhs)[0]);
        const idx = () => toNode(kids(part(lhs, 'args'))[0]);
        const isM = isMap(kids(lhs)[0]);
        const get = () => (isM ? mapGet(obj(), idx()) : indexGet(obj(), idx()));
        const v = o === null ? toNode(rhs) : bin(o, get(), toNode(rhs));
        return isM ? mapSet(obj(), idx(), v) : indexSet(obj(), idx(), v);
      }
      const name = nameOf(lhs);
      if (o === null) return node('set', { value: toNode(rhs) }, { name });
      return node('set', {
        value: bin(o, node('ref', {}, { name }), toNode(rhs)),
      }, { name });
    }
    case 'routine': {
      const nm = kids(x).find((y) => tag(y) === 'n' || tag(y) === 'name');
      const name = nm === undefined ? null : leaf(kids(nm)[0]);
      const sig = part(x, 'sig');
      const groups = sig === undefined ? [] : kids(sig);
      const params = groups.flatMap((g) => (tag(g) === 'p' ? [g] : groupItems(g)))
        .filter((p) => tag(p) === 'p')
        .map((p) => nameOf(part(p, 'names') ?? kids(p)[0]));
      const impl = sig === undefined ? undefined : part(sig, 'impl');
      const body = impl === undefined ? part(x, 'impl') : impl;
      return node('bind', {
        init: node('func', { body: body === undefined ? [] : many(kids(body)) }, { params, name }),
      }, { name });
    }
    case 'while': {
      const cond = kids(x).find((y) => tag(y) !== 'body');
      const body = part(x, 'body');
      return node('loop', {
        cond: cond === undefined ? lit(true) : toNode(cond),
        body: body === undefined ? [] : many(kids(body)),
      });
    }
    case 'if': {
      const cond = kids(x)[0];
      const body = part(x, 'body');
      const els = part(x, 'else');
      return branchOf(
        toNode(cond),
        body === undefined ? [] : many(kids(body)),
        els === undefined ? undefined : many(kids(els)),
      );
    }
    case 'return': return retOf(many(kids(x)));
    // 命令式调用与括号调用是**同一格节点**（语法两条产生式，图上一格）
    case 'call': case 'command': {
      const [fn, args] = kids(x);
      const argKids = args === undefined ? [] : kids(args);
      // `Point(x: 1, y: 2)` -> record-new。**判据是"这名字登记成类型了吗"** ——
      // 而那句话不用问驱动器：扫一遍 `type-section` 就有答案（见 TYPES）。
      // 顺带把那笔账改对：命名实参在树上是 `named`（`=`），对象构造是 `kv`（`:`）——
      // **在调用实参这个位置上两者不同形**，语法里就是两条产生式。
      if (argKids.length > 0 && argKids.every((a) => tag(a) === 'kv')) {
        const ty = (tag(fn) === 'name' || tag(fn) === 'n') ? leaf(kids(fn)[0]) : null;
        if (ty === null || !TYPES.has(ty)) {
          throw new Error(`nim->graph: ${ty ?? '?'}(x: 1) 这个形状要它是登记过的类型 —— `
            + '没在 type 段里见过它（命名实参请写 f(x = 1)）');
        }
        return recordNew(argKids.map((a) => [nameOf(kids(a)[0]), toNode(kids(a)[1])]));
      }
      // `f(a = 3, b = 4)`：命名实参**按被调者的形参表排回位置** —— 图上只有位置实参
      // （名字对不上、被调者的形参表不知道，都当场报，不猜）
      if (argKids.some((a) => tag(a) === 'named')) {
        const callee = (tag(fn) === 'name' || tag(fn) === 'n') ? leaf(kids(fn)[0]) : null;
        const ps = callee === null ? undefined : PARAMS.get(callee);
        if (ps === undefined) throw new Error(`nim->graph: ${callee ?? '?'} 的形参表不知道，命名实参排不回位置`);
        const given = new Map();
        for (const a of argKids) {
          if (tag(a) !== 'named') throw new Error('nim->graph: 命名实参与位置实参混着写还没接');
          const k = leaf(kids(a)[0]);
          if (!ps.includes(k)) throw new Error(`nim->graph: ${callee} 没有名为 ${k} 的形参`);
          given.set(k, toNode(kids(a)[1]));
        }
        if (given.size !== ps.length) {
          throw new Error(`nim->graph: ${callee} 要 ${ps.length} 格实参，命名实参给了 ${given.size} 格`);
        }
        return node('call', { fn: toNode(fn), args: ps.map((p) => given.get(p)) });
      }
      const argNodes = many(argKids);
      // `initTable[string, int]()` -> map-new：造 Table 的那个调用**就是**那一格节点
      // （nim 的标记不在字面量上，在造它的调用上 —— 认得出就不用回问类型）
      const gen = tag(fn) === 'bracket' ? kids(fn)[0] : fn;
      if ((tag(gen) === 'name' || tag(gen) === 'n') && TABLE_CTORS.has(leaf(kids(gen)[0]))) {
        if (argNodes.length !== 0) throw new Error('nim->graph: 带初值的 Table 造法还没接');
        return mapNew();
      }
      // `m.hasKey(k)` -> map-has。V 写成 `k in m`、go 写成 comma-ok —— 同一格节点
      if (tag(fn) === 'dot' && leaf(kids(fn)[1]) === 'hasKey' && argNodes.length === 1) {
        return mapHas(toNode(kids(fn)[0]), argNodes[0]);
      }
      // `p.total()` -> `total(p)`：nim 的方法**只是调用的另一种写法**（UFCS）——
      // 图上是**纯改写**，不加节点、也不要注册表以外的东西：方法名从声明来
      // （`PARAMS` 是扫 routine 得的那张表），点号左边那一格就是第一个实参。
      // 名字没在 proc 表里就仍然是取字段 —— 判据在声明里，不猜。
      if (tag(fn) === 'dot' && PARAMS.has(leaf(kids(fn)[1]))) {
        const m = leaf(kids(fn)[1]);
        return node('call', {
          fn: node('ref', {}, { name: m }),
          args: [toNode(kids(fn)[0]), ...argNodes],
        });
      }
      const callee = (tag(fn) === 'name' || tag(fn) === 'n') ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      // `int(x)` / `float(x)` 在树上与调用同形 —— 与对象构造那笔账同一笔，这一批按名字表判
      if (callee !== null && CONV.has(callee) && argNodes.length === 1) {
        return convOf(CONV.get(callee), argNodes[0]);
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    case 'import': case 'include': case 'type-section': case 'pragma': return [];
    default:
      throw new Error(`nim->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 nim 的 GLR 树（`(module 项…)`）-> 一张图。 */
export function nimToGraph(tree) {
  if (tag(tree) !== 'module') throw new Error('nim->graph: 这不是 (module …)');
  // 先扫一遍哪些名字装 Table（`initTable[K, V]()` 那种造法在树上认得出）
  MAPS.clear();
  for (const nm of mapNames(tree, mapBindName)) MAPS.add(nm);
  // 再扫一遍**登记过的类型名**与**每个 proc 的形参名**：前者判 `T(x: 1)`、
  // 后者把 `f(x = 1)` 排回位置。这两问都不用驱动器回问 —— 树上就有答案。
  TYPES.clear();
  PARAMS.clear();
  collectDecls(tree);
  return program(kids(tree).map(toNode).flat());
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. pragma 全丢（`raises` / `tags` / `noSideEffect` 是**效应签名**，
//      `ext/nim/SPEC.md` §五第 1 项：效应六格的边界是那一门第一件要做的事）。
//   2. `result` 隐式变量、`discard`、模板/宏、迭代器都不在这一批。
//   3. `var` / `sink` / `lent` 形参丢掉 —— 它们是 `lifetime` 那一栏。
//   4. **对象构造与命名实参分不开**：`T(x: 1)` 与 `f(x = 1)` 在树上是同一格 `kv`，
//      这一批按"实参全是 kv"判成 record-new。要分开得驱动器能回问"这名字是类型吗" ——
//      与 cpp 那笔账同一笔（设计文档附录 A.5 第 3 笔）。
//   5. 方法（第二十四批）：`p.total()` 是 UFCS，纯改写成 `total(p)`。**不带括号**的
//      `p.total` 仍落 field-get（那是取字段还是无参调用，要形参表以外的一句话），
//      泛型 proc、`var` 接收者、`method`（真的动态分派）都不在这一批。
