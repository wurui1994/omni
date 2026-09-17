// ext/vlang/tograph.js —— **V 的树 -> 节点图**（第五个前端）
//
// 与 `ext/go/tograph.js` 对着看：两门语言的树几乎同形（`file` / `fn` / `define` /
// `for` / `inc` / `if` / `return` / `call`），差的只有三处小地方 ——
//   * 形参在 `(params (p 名字 (tname …)))` 里（go 是 `(sig (in (p (tname …) (name …))))`）；
//   * 左值可以带 `mut` 包一层（`mut acc := 0`）—— **不可变是默认的**，`mut` 是一格
//     不产生代码的检查（`ext/vlang/SPEC.md` §四第 2 条），这一批直接拆掉；
//   * `println` 是内建，不用走 `fmt.` 那一格选择器。
// 三处都不影响节点：**落到的还是那 13 格**。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  tag, kids, leaf, part, threePart, elseOf,
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, lazyOr, counted, partKids,
  recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet, sliceOf, destructure,
  mapNew, mapGet, mapSet, mapHas, mapNames, isList,
} from '../../src/core/graph/fromtree.js';

/** 装 map 的那些名字（`vlangToGraph` 里一趟扫查填好）—— 与 go 那一份同一条办法。 */
const MAPS = new Set();
const isMap = (x) => tag(x) === 'name' && MAPS.has(leaf(kids(x)[0]));

/** `(define (lhs (mut (name m))) (rhs (lit (map …) …)))` -> `'m'`（`mut` 要拆一层）。 */
function mapBindName(x) {
  if (!isList(x)) return null;
  // `const m = map[K]V{…}` 也要进这张表（树上是 `(c 名 值)`）—— 漏了它，后面 `m[k]`
  // 会静静落成列表下标，那是"答案错而不报"
  if (tag(x) === 'c') {
    const [nm, v] = kids(x);
    return v !== undefined && tag(v) === 'lit' && tag(kids(v)[0]) === 'map' ? leaf(nm) : null;
  }
  if (tag(x) !== 'define' && tag(x) !== 'assign') return null;
  const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
  const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
  for (let i = 0; i < lhs.length; i++) {
    const r = rhs[i];
    if (r !== undefined && tag(r) === 'lit' && tag(kids(r)[0]) === 'map') return nameOf(lhs[i]);
  }
  return null;
}


const OPS = ops();
const CONV = convs({
  i8: 'int', i16: 'int', i32: 'int', i64: 'int',
  u8: 'int', u16: 'int', u32: 'int', u64: 'int',
  f32: 'float', f64: 'float', string: 'str',
});
const PRINTS = new Set(['println', 'print', 'eprintln', 'dump']);

/**
 * **方法名 -> 它声明的接收者类型名**（一趟扫查得的，见 vlangToGraph）。
 * V 的接收者写在声明里（`fn (p Point) total() int`）—— 与 go 同一件事：分派是单态的，
 * 图上方法就是"多一格实参的普通函数"，不加节点、不查表。重名当场报，不猜。
 */
const METHODS = new Map();

/** 扫一遍顶层：登记每个方法的名字与它的接收者类型。 */
function collectMethods(x) {
  if (!isList(x)) return;
  if (tag(x) === 'method') {
    const [recv, nm] = kids(x);
    const name = leaf(nm);
    const ty = part(kids(recv)[0], 'tname');
    const owner = ty === undefined ? '?' : leaf(kids(ty)[0]);
    const had = METHODS.get(name);
    if (had !== undefined && had !== owner) {
      throw new Error(`v->graph: ${had} 与 ${owner} 都声明了方法 ${name} —— `
        + '重名要类型才分得开，这一批不猜');
    }
    METHODS.set(name, owner);
  }
  for (const k of kids(x)) collectMethods(k);
}

const many = (xs) => xs.map(toNode).flat();

/**
 * `const a = 1` / `const ( … )` / `__global ( … )` -> **一串 bind**（没有 decl 节点）。
 *
 * 树上每一格是 `(c 名 值)`。V 这一格比 go 干净：语法里就写着 `IDENT "=" expr` ——
 * **没有** go 那两条规矩（省略初值重复上一条、`iota`），所以这儿一格一格绑就完了。
 */
function cbinds(x) {
  return kids(x).map((c) => {
    if (tag(c) !== 'c') throw new Error(`v->graph: ${tag(x)} 里不该有 ${tag(c)}`);
    return node('bind', { init: toNode(kids(c)[1]) }, { name: leaf(kids(c)[0]) });
  });
}

/** 左值：`(name x)` 或 `(mut (name x))`。`mut` 只是一格检查，拆掉。 */
function nameOf(x) {
  if (tag(x) === 'mut') return nameOf(kids(x)[0]);
  if (tag(x) === 'name') return leaf(kids(x)[0]);
  return leaf(x);
}

function funcOf(x, name, self) {
  const ps = part(x, 'params');
  const params = ps === undefined ? [] : kids(ps).map((p) => leaf(kids(p)[0]));
  const blk = kids(x).find((y) => tag(y) === 'block');
  return node('func', { body: blk === undefined ? [] : many(kids(blk)) },
    { params: self === undefined ? params : [self, ...params], name });
}

/**
 * **`match` 落一条 branch 链**（与 go 的 `switch` 同一件事 —— V 也没有隐式贯穿）。
 *
 * V 的 match **既是语句也是表达式**，而这两件事在图上不同形，所以这一格收一个 `asStmt`：
 *   * **语句位置**：主语落一格 `bind` 到 `__mtN`（只算一次），各支的体是一格 region；
 *   * **表达式位置**：每一支要交出一个**值**，而 `bind` 摆不进表达式位置 ——
 *     所以那一路**把主语原样抄进每一格比较**，并且只接主语是名字或常量的那种
 *     （别的当场报："主语要算好几遍"）。每一支的体必须正好是一格表达式，
 *     而且**必须有 `else`** —— 不然掉出去那一路没有值。
 *
 * 分支左边是**类型**的那一族（sum type 的 match：`[]int` / `map[string]int` / `&T`）
 * 当场报：分开它们要的正是类型那一层。`.foo` 那种枚举短写法走 toNode 的兜底
 * （枚举声明整格丢掉了，所以那个名字没有出处 —— 明说在文件末尾）。
 */
let MT_DEPTH = 0;

function armConds(a, subjText) {
  return partKids(a, 'items').map((it) => {
    if (tag(it) === 'array' || tag(it) === 'map' || tag(it) === 'ref') {
      throw new Error(`v->graph: match 的分支左边是类型（${tag(it)}）—— sum type 那一族`
        + '要类型才分得开，这一批不猜');
    }
    return binOf('==', subjText(), toNode(it), OPS, { lang: 'v' });
  });
}

function matchOf(x, asStmt) {
  const all = kids(x);
  let subj = all[0];
  if (tag(subj) === 'mut') subj = kids(subj)[0];      // `match mut x` —— mut 只拆不检查
  const holder = `__mt${MT_DEPTH}`;
  const bindSubj = asStmt;
  if (!asStmt && tag(subj) !== 'name' && tag(subj) !== 'num' && tag(subj) !== 'str') {
    throw new Error('v->graph: 表达式位置上的 match 主语要算好几遍 —— 那儿摆不进一格临时量，'
      + '这一批只接主语是名字或常量的');
  }
  const subjText = () => (bindSubj ? node('ref', {}, { name: holder }) : toNode(subj));
  const arms = [];
  let dflt;
  MT_DEPTH += 1;
  try {
    for (const a of all.slice(1)) {
      if (tag(a) === 'else') {
        if (dflt !== undefined) throw new Error('v->graph: 一格 match 里两个 else');
        dflt = armValue(a, asStmt);
        continue;
      }
      if (tag(a) !== 'arm') throw new Error(`v->graph: match 里不该有 ${tag(a)}`);
      const conds = armConds(a, subjText);
      if (conds.length === 0) throw new Error('v->graph: match 的分支左边一个值都没有');
      arms.push([conds.reduce((p, q) => lazyOr(p, q)), armValue(a, asStmt)]);
    }
  } finally {
    MT_DEPTH -= 1;
  }
  if (!asStmt && dflt === undefined) {
    throw new Error('v->graph: 表达式位置上的 match 没有 else —— 掉出去那一路没有值');
  }
  let chain = dflt;
  for (let i = arms.length - 1; i >= 0; i -= 1) chain = branchOf(arms[i][0], arms[i][1], chain);
  if (chain === undefined) return [];
  if (!bindSubj) return chain;
  return node('region', {
    body: [node('bind', { init: toNode(subj) }, { name: holder }), chain],
  });
}

/** 一支的体：语句位置上是一格 region；表达式位置上必须正好是一格表达式。 */
function armValue(a, asStmt) {
  const blk = kids(a).find((y) => tag(y) === 'block');
  const stmts = blk === undefined ? [] : kids(blk);
  if (asStmt) return node('region', { body: many(stmts) });
  if (stmts.length !== 1 || tag(stmts[0]) !== 'expr') {
    throw new Error('v->graph: 表达式位置上的 match，每一支的体要正好是一格表达式');
  }
  return toNode(stmts[0]);
}

/**
 * **`for x in …` 落一格计数循环**（`counted` —— 与 go 的 `range` 同一格 loop）。
 *
 * 两条 V 自己的规矩：
 *   * **一个名字给的是元素**（`for x in xs` 里 x 是元素），两个名字才是"下标 + 元素" ——
 *     这一格与 go 正相反（go 的 `for i := range xs` 里 i 是**下标**）。写法归语言。
 *   * `for i in 0..n` 是**区间**（`(range a b)`）：那一路没有序列，i 直接从 a 走到 b；
 *     终点只算一次（落一格 bind），上界**不含**。
 *
 * `range` 一格 map 当场报（要按键遍历，图上没有那一格）。串与通道判不出来 ——
 * 沿用 `MAPS` 那条既有约定（没登记成 map 的当序列），明说在文件末尾。
 */
let FI_DEPTH = 0;

function forInOf(x) {
  const nms = part(x, 'names');
  const vals = part(x, 'values');
  const blk = kids(x).find((y) => tag(y) === 'block');
  if (nms === undefined || vals === undefined) {
    throw new Error('v->graph: for-in 里没有 (names …) 或 (values …)');
  }
  const names = kids(nms).map(nameOf);
  if (names.length > 2) throw new Error(`v->graph: for-in 左边最多两格，给了 ${names.length}`);
  const subj = kids(vals)[0];
  const at = (n) => node('ref', {}, { name: n });
  const seq = `__in${FI_DEPTH}`;
  const idx = `__ix${FI_DEPTH}`;
  const cnt = `__nc${FI_DEPTH}`;
  FI_DEPTH += 1;
  let inner;
  try {
    inner = blk === undefined ? [] : many(kids(blk));
  } finally {
    FI_DEPTH -= 1;
  }
  // 区间：`for i in 0..n` —— 没有序列，那格名字就是计数量本身
  if (tag(subj) === 'range') {
    if (names.length !== 1) {
      throw new Error('v->graph: 区间那一路只能有一格名字（`for i in a..b`）');
    }
    const [lo, hi] = kids(subj);
    return node('region', {
      body: [
        node('bind', { init: toNode(hi) }, { name: cnt }),
        counted({
          name: names[0],
          from: toNode(lo),
          cond: bin('<', at(names[0]), at(cnt)),
          body: [node('region', { body: inner })],
        }),
      ],
    });
  }
  if (isMap(subj)) {
    throw new Error('v->graph: `for … in` 一格 map 要按键遍历 —— 图上还没有那一格');
  }
  const head = [];
  const elem = indexGet(at(seq), at(idx));
  if (names.length === 1) {
    if (names[0] !== '_') head.push(node('bind', { init: elem }, { name: names[0] }));
  } else {
    if (names[0] !== '_') head.push(node('bind', { init: at(idx) }, { name: names[0] }));
    if (names[1] !== '_') head.push(node('bind', { init: elem }, { name: names[1] }));
  }
  return node('region', {
    body: [
      node('bind', { init: toNode(subj) }, { name: seq }),
      node('bind', { init: node('prim', { args: [at(seq)] }, { name: 'len' }) }, { name: cnt }),
      counted({
        name: idx,
        from: lit(0),
        cond: bin('<', at(idx), at(cnt)),
        body: [node('region', { body: [...head, ...inner] })],
      }),
    ],
  });
}

function toNode(x) {
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: leaf(kids(x)[0]) });
    case 'name': {
      const n = leaf(kids(x)[0]);
      if (n === 'true') return node('const', {}, { value: true });
      if (n === 'false') return node('const', {}, { value: false });
      if (n === 'none' || n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    case 'mut': return toNode(kids(x)[0]);
    // `true` / `false` 在 V 的语法里是**自己一条产生式**（`(bool $1)`），不是名字 ——
    // `name` 那一格里认 'true'/'false' 只兜住了写成标识符的那一路
    case 'bool': return node('const', {}, { value: leaf(kids(x)[0]) === 'true' });
    // `p.x` -> field-get；`Point{ x: 1 }` -> record-new（**类型名不进图**）。
    // V 的字段表标签是 `f`，go 的是 `kv`，lua 的是 `named` —— 三种记号一格节点。
    case 'sel': return fieldGet(toNode(kids(x)[0]), leaf(kids(x)[1]));
    // 结构字面量与 **map 字面量**在树上都叫 `lit`，差的是类型那一格：
    // `map[K]V{…}` 是 `(lit (map …) …)` —— **自带标记**，所以不必回问"这名字是什么类型"
    case 'lit': {
      if (tag(kids(x)[0]) === 'map') {
        return mapNew(kids(x).slice(1).filter((e) => tag(e) === 'kv').map((e) => {
          const [k, v] = kids(e);
          return [toNode(k), toNode(v)];
        }));
      }
      return recordNew(kids(x).slice(1).map((e) => {
        if (tag(e) !== 'f') throw new Error('v->graph: 这一批只接带字段名的结构字面量');
        return [leaf(kids(e)[0]), toNode(kids(e)[1])];
      }));
    }
    // `[10, 20, 30]` -> list-new；`xs[0]` -> index-get（V 与 go 从 0 起，不用减）
    case 'array': return listNew(many(kids(x)));
    case 'index': {
      const [o, i] = kids(x);
      return isMap(o) ? mapGet(toNode(o), toNode(i)) : indexGet(toNode(o), toNode(i));
    }
    // `k in m` -> map-has。V 把"在不在"写成一格算子、go 写成 comma-ok —— 同一格节点
    case 'in': {
      const [k, o] = kids(x);
      if (!isMap(o)) throw new Error('v->graph: `in` 这一批只接 map（数组的 in 要线性查找）');
      return mapHas(toNode(o), toNode(k));
    }
    // `xs[1..3]` -> slice（V 的上界也**不含**）
    case 'slice': {
      const [o, a, b] = kids(x);
      return sliceOf(toNode(o), a === undefined ? undefined : toNode(a),
        b === undefined ? undefined : toNode(b));
    }

    case 'bin': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'v' });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === '!' ? 'not' : leaf(op), toNode(a));
    }

    case 'fn': {
      const name = leaf(kids(x)[0]);
      return node('bind', { init: funcOf(x, name) }, { name });
    }
    // `fn (p Point) total() int { … }` -> 与 `fn` **同一格 bind + func**，
    // 差的只有"接收者当第一格形参"（go 那份一字不差 —— 接收者在声明里，分派是单态的）
    case 'method': {
      const [recv, nm] = kids(x);
      const name = leaf(nm);
      const self = kids(kids(recv)[0])[0];
      if (self === undefined) {
        throw new Error(`v->graph: ${name} 的接收者没有名字 —— 匿名接收者这一批没接`);
      }
      return node('bind', { init: funcOf(x, name, leaf(self)) }, { name });
    }
    case 'block': return node('region', { body: many(kids(x)) });
    case 'define': case 'assign': {
      const isDef = tag(x) === 'define';
      const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
      const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
      // `a, b := two()`：**N 个名字对 1 个右值** ⇒ 多值的消费侧（一串 pick）。
      // 与 go 那一份同一条（`destructure` 在 fromtree.js）—— V 的多返回写成
      // `fn two() (int, int)` + `return 3, 7`，生产侧落 `values`，这儿落 pick。
      if (lhs.length > 1 && rhs.length === 1) {
        return destructure(lhs.map(nameOf), toNode(rhs[0]), { declare: isDef });
      }
      return lhs.map((t, i) => {
        const v = rhs[i] === undefined ? lit(null) : toNode(rhs[i]);
        // 左边是一格字段（`p.y = 5`）或一格下标（`xs[1] = 5`）⇒ field-set / index-set
        if (tag(t) === 'sel') return fieldSet(toNode(kids(t)[0]), leaf(kids(t)[1]), v);
        if (tag(t) === 'index') {
          const [o, i] = kids(t);
          return isMap(o) ? mapSet(toNode(o), toNode(i), v) : indexSet(toNode(o), toNode(i), v);
        }
        return isDef
          ? node('bind', { init: v }, { name: nameOf(t) })
          : node('set', { value: v }, { name: nameOf(t) });
      });
    }
    case 'inc': case 'dec': return node('set', {
      value: bin(tag(x) === 'inc' ? '+' : '-', toNode(kids(x)[0]), lit(1)),
    }, { name: nameOf(kids(x)[0]) });
    case 'for': {
      const init = part(x, 'init');
      const cond = part(x, 'cond');
      const post = part(x, 'post');
      const blk = kids(x).find((y) => tag(y) === 'block');
      // 形状与 go / awk 一模一样 —— `threePart` 只写一遍（fromtree.js）
      return threePart({
        init: init === undefined ? [] : many(kids(init)),
        cond: cond === undefined ? undefined : toNode(kids(cond)[0]),
        post: post === undefined ? [] : many(kids(post)),
        body: blk === undefined ? [] : many(kids(blk)),
      });
    }
    case 'if': {
      const [cond, then, els] = kids(x);
      const e = elseOf(els);
      return branchOf(toNode(cond), toNode(then), e === undefined ? undefined : toNode(e));
    }
    case 'return': return retOf(many(kids(x)));
    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'expr': {
      // `match` **既是语句也是表达式**，而两者在图上不同形（语句那一路的体是 region、
      // 表达式那一路每支要交出一个值）。这儿是唯一知道"它在语句位置上"的地方。
      const inner = kids(x)[0];
      if (tag(inner) === 'match') return matchOf(inner, true);
      return toNode(inner);
    }
    case 'match': return matchOf(x, false);
    case 'for-in': return forInOf(x);
    // `defer { … }` / `defer: …` -> scope-exit（与 go 的 defer、CL 的 unwind-protect
    // **同一格节点**：逆序、早退也跑，八家共用那一格）
    case 'defer': return node('scope-exit', { action: many(kids(x)) });
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      const callee = tag(fn) === 'name' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      if (callee !== null && CONV.has(callee) && argNodes.length === 1) {
        return convOf(CONV.get(callee), argNodes[0]);   // `int(x)` / `f64(x)`
      }
      // `p.total()` -> `total(p)`：接收者是**第一格实参**（声明里写着是哪个类型，
      // 所以这一步是纯改写）。名字没登记成方法就仍然是"取字段再调它" —— 判据在声明里。
      if (tag(fn) === 'sel' && METHODS.has(leaf(kids(fn)[1]))) {
        return node('call', {
          fn: node('ref', {}, { name: leaf(kids(fn)[1]) }),
          args: [toNode(kids(fn)[0]), ...argNodes],
        });
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    // 顶层的这几样在这一批里没有对应物 —— 丢掉，不猜。
    // `typedecl`（`type X = A | B` —— 别名与 sumtype）与 `interface` 都是**类型的声明**，
    // 而类型不进图。树上的标签是 `typedecl` 不是 `type-decl` —— 原来写的那一格是**死代码**
    // （283 份卡在这儿，与 go 那份 `var-decl` / `const-decl` 是同一个错）。
    case 'module': case 'import': case 'struct': case 'enum':
    case 'typedecl': case 'interface': return [];
    // `pub` 是可见性、`attrs` 是属性表 —— 两样都**不产生代码**（与 `mut` 同一类），
    // 拆一层接着走。`(attributed (attrs …) (module …))` 那一路拆完落到 module，也就是空。
    case 'pub': return toNode(kids(x)[0]);
    case 'attributed': return toNode(kids(x)[1]);
    case 'const': case 'global': return cbinds(x);
    default:
      throw new Error(`v->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/**
 * 一棵 V 的 GLR 树（`(file 顶层项…)`）-> 一张图。末尾补一格 `call main`（同 go）。
 * `opts.asModule` = 被 import 进来的那份：**不补**那一格（不然被导入的 `main` 也会跑）。
 */
export function vlangToGraph(tree, opts) {
  if (tag(tree) !== 'file') throw new Error('v->graph: 这不是 (file …)');
  // 先扫一遍哪些名字装 map（`m := map[K]V{…}` 自带标记）—— 与 go 那一份同一条办法
  MAPS.clear();
  for (const nm of mapNames(tree, mapBindName)) MAPS.add(nm);
  // 再扫一遍**声明过的方法名**（接收者的类型写在声明里 —— 单态分派，不查表）
  METHODS.clear();
  collectMethods(tree);
  const body = kids(tree).map(toNode).flat();
  if (opts !== undefined && opts.asModule === true) return program(body);
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

/**
 * 这份文件 `import` 了哪几格（第一百五十一片第二格）。树上是 `(import <mod-path> [(as 名)])`；
 * mod-path 可能是一格名字、也可能点分几格 —— 一律拼回原文（`a.b` 那种）。
 */
export function vlangImports(tree) {
  const out = [];
  const text = (x) => {
    if (!isList(x)) return leaf(x) ?? '';
    /* `kids()` 不含标签（`fromtree.js:34`）—— 别再 slice 一次。 */
    return kids(x).map(text).filter((s) => s !== '').join('.');
  };
  const walk = (x) => {
    if (!isList(x)) return;
    if (tag(x) === 'import') {
      const spec = text(kids(x)[0]);
      if (spec !== '') out.push(spec);
      return;
    }
    for (const k of kids(x)) walk(k);
  };
  walk(tree);
  return out;
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. option/result（`?T` / `!T` / `or {}` / `!` 传播）不在这一批 —— 它是
//      **错误出端口 + 切段**，排在 `multi-value` 那一步（`ext/vlang/SPEC.md` §五第 1 项）。
//   2. `mut` 只拆不检查（它是一格不产生代码的检查特性）。
//   2b. `for … in` 那一格**判不出来的两种**沿用 `MAPS` 那条既有约定（没登记成 map 的当
//      序列），所以串与通道会落成"按下标走"而不报。map 与区间判得出来：前者当场报、
//      后者落 counted。
//   2c. `match` 的分支左边是**类型**的那一族（sum type）当场报；`.foo` 那种枚举短写法
//      走兜底（枚举声明整格丢掉了，那个名字没有出处 —— 见下面第 3 条）。
//   3. struct / enum / interface / `type X = …` 的**声明**都丢掉（字段名从字面量那儿来
//      —— record-new 不要求类型存在）；match / spawn / chan 都不在这一批。
//      **enum 丢掉是有代价的**：`.red` / `Color.red` 那种引用还没有出处（这一格还在墙上）。
//   3b. `assert` 要的是一格"停下来"的内建（图上的 prim 表里没有），所以它留在墙上 ——
//      那不是映射的账。
//   4. 方法：接收者提到形参表第一格（第二十四批，与 go 同一条办法）。`mut` 接收者只拆不检查、
//      接口与方法值不在这一批；同名方法当场报 —— 分开它们要的是类型那一层。
