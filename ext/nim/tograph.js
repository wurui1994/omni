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
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, lazyOr, lazyAnd, counted,
  recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet, sliceOf, destructure,
  mapNew, mapGet, mapSet, mapHas, mapNames, mapForIn,
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
function collectDecls(x, shapesOnly) {
  if (!isList(x)) return;
  if (tag(x) === 'tdef') {
    const nm = kids(x).find((y) => tag(y) === 'n' || tag(y) === 'name');
    if (nm !== undefined) TYPES.add(leaf(kids(nm)[0]));
  }
  /* `shapesOnly` 是**一起编的那几份**那一趟用的（`opts.also`）：类型名要收，
     **形参名不收** —— 那张表按 proc 名索引，重名的 proc（nim 允许重载）会互相盖掉，
     而 `f(x = 1)` 排回位置靠的正是它：盖错了就是静默的错答案。 */
  if (tag(x) === 'routine' && shapesOnly !== true) {
    const nm = kids(x).find((y) => tag(y) === 'n' || tag(y) === 'name');
    const sig = part(x, 'sig');
    if (nm !== undefined && sig !== undefined) PARAMS.set(leaf(kids(nm)[0]), paramNames(sig));
  }
  for (const k of kids(x)) collectDecls(k, shapesOnly);
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

/* nim 的 `shl` / `shr` 就是位移（没有第二种意思）；**`and` / `or` / `xor` / `not` 不接** ——
   那四个词在 nim 里**按类型**决定是逻辑还是位运算（`true and false` 与 `5 and 3`），
   而这一层没有类型。猜一个就是静默的错答案，所以那四个照旧报。
   `&` 是串接（nim 自己的规矩），所以它在这张 delta 里盖掉公共表那一格。 */
const OPS = ops({
  div: '/', mod: '%', '&': 'concat', shl: 'shl', shr: 'shr',
  /* `..^`（半开区间 `a ..^ b` = 从 a 到 b-1）：在树上是一格 `bin`，和 `..<` 同义，
     但那是独立的算符名。两个只在 `for` 和 `case` 那几处有区别，这一层映到同一格 bin 节点
     —— `binOf` 会原样保留不认识的名字，所以加进 OPS 就行。
     **语义**：与 `..<` 等价（走 `< b`），区别只是 `..<` 是中缀、`..^` 是后缀，
     但在 nim 的真 parser 里它们都降成 `system.`..<`(a, b)`。我们在图上不区分。 */
  '..^': '..<',
});

/**
 * **声明过的编译期环境**（`when defined(x)`）—— 与 `ext/vlang/tograph.js` 那一份同一条口径：
 * 定死一个**参考目标**（linux · x64 · gcc），不看跑在哪台机器上（**尺子要可重现**）。
 *
 * `defined(名字)`：名字在表里就用表里的答案。**不在表里当场报** —— nim 里 `defined()`
 * 对没定义的名字回 false，可那是"编译器知道全部 -d 标志"的前提下；我们这一层看不见
 * 命令行，猜 false 就会静静丢掉一段代码。
 *
 * `nimvm` 那一格是 **false**：它问的是"这会儿在编译期虚拟机里跑吗"，而我们落的是运行期
 * 的图 —— 这一格不是猜，是这一层的事实。
 */
const NIM_CT_ENV = new Map(Object.entries({
  linux: true, posix: true, unix: true, gcc: true, cpu64: true, littleEndian: true,
  windows: false, macosx: false, macos: false, osx: false, bsd: false, freebsd: false,
  openbsd: false, netbsd: false, android: false, ios: false, haiku: false, genode: false,
  js: false, nimscript: false, nimvm: false, cpp: false, objc: false, emscripten: false,
  release: false, danger: false, debug: true, useMalloc: false, gcArc: false, gcOrc: false,
  windowsHasEnvironmentVariables: false, cpu32: false, bigEndian: false, clang: false,
  vcc: false, tcc: false, icl: false, nimHasStyleChecks: true,
  /* **-d 开关那一族**（原来这几个不在表里，24 份卡在 `defined(nimPreviewSlimSystem)` 上）。
     `nimPreviewSlimSystem` 是"不自动 import 那些旧的符号"，新的 nim 编译器自己用它 ——
     声明为 true（那门编译器自己选的开关，当 true 不会丢代码，当 false 会少 import 一批
     但不影响编译 —— 这一格的理由是"漏了"，不是"两边都有理"）。
     `hasThreads` 是 `compileOption("threads")`：参考目标上默认关。
     `useRef` 在 Nim 2.x 的 GC 里：参考目标上默认关。 */
  nimPreviewSlimSystem: true, hasThreads: false, useRef: false,
  /* 第二批补：`isDebug` 是 `compileOption("assertions")`（参考目标 debug 模式 -> true），
     `hasRstdin` 是 Nim 自己那门编译器的检查（`-d:hasRstdin`，默认不带 -> false）。 */
  isDebug: true, hasRstdin: false,
}));

/** `when` 的条件求值。认不出来的形状**当场报**（与 V 那一份同一条纪律：不猜）。 */
function whenCond(c) {
  const t = tag(c);
  if (t === 'paren') return whenCond(kids(c)[0]);
  if (t === 'un' && (leaf(kids(c)[0]) === 'not' || leaf(kids(c)[0]) === '!')) {
    return !whenCond(kids(c)[1]);
  }
  if (t === 'bin') {
    const o = leaf(kids(c)[0]);
    if (o === 'and' || o === '&&') return whenCond(kids(c)[1]) && whenCond(kids(c)[2]);
    if (o === 'or' || o === '||') return whenCond(kids(c)[1]) || whenCond(kids(c)[2]);
  }
  if (t === 'name') {
    const nm = leaf(kids(c)[0]);
    if (nm === 'true') return true;
    if (nm === 'false') return false;
    if (NIM_CT_ENV.has(nm)) return NIM_CT_ENV.get(nm) === true;   // `when nimvm:` 那种裸名字
    throw new Error(`nim->graph: \`when\` 的条件里有 \`${nm}\` —— 不在声明过的那张表里`
      + '（NIM_CT_ENV），这一层不猜');
  }
  /* `defined(x)` —— 树上是一格调用。 */
  if (t === 'call' || t === 'command') {
    const fn = kids(c)[0];
    const args = part(c, 'args');
    if (tag(fn) === 'name' && leaf(kids(fn)[0]) === 'defined' && args !== undefined) {
      const a = kids(args)[0];
      if (a !== undefined && tag(a) === 'name') {
        const nm = leaf(kids(a)[0]);
        if (NIM_CT_ENV.has(nm)) return NIM_CT_ENV.get(nm) === true;
        throw new Error(`nim->graph: \`defined(${nm})\` 不在声明过的那张表里（NIM_CT_ENV）`
          + ' —— 这一层看不见命令行上的 -d，猜 false 就会静静丢掉一段代码');
      }
    }
  }
  throw new Error(`nim->graph: \`when\` 的条件是 \`${t}\` 这个形状 —— 只接 defined() 与`
    + ' and / or / not 拼起来的那几种（`sizeof(int) == 8` 那类要类型与布局）');
}
const CONV = convs({
  int8: 'int', int16: 'int', int32: 'int', int64: 'int',
  uint: 'int', uint8: 'int', uint32: 'int', uint64: 'int',
  float32: 'float', float64: 'float', '$': 'str',
});
const PRINTS = new Set(['echo', 'write', 'stdout']);
/** set 的代数（并 / 差 / 交 / 子集）—— 在 set 上这些是集合算，而图上没有那一族节点，
 *  落成算术是**静默的错答案**。用来在 `binOf` 之前挡一道。 */
const SET_ALG = new Set(['+', '-', '*', '<=', '>=', '<']);

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
      const o = leaf(op);
      /**
       * `x in xs` / `x notin xs` —— **两边要换个位置**（`contains(容器, 元素)`），
       * 所以走不了 `binOf` 那条查表的路。那格内建**只找列表里的元素**：nim 的 `x in s`
       * （串）要 char 那一格，而 char 还没接。判据 `ext/nim/examples/member.nim`。
       *
       * **右边就写着 set 字面量时走 `map-has`**：set 落成的是 key → true 的 map，
       * 而 `contains` 找的是**元素**（值），拿它去问一个 map 得到的是错答案。
       * 语料里最常见的形状正是这一个（`n.kind in {nkIdent, nkSym}`）。
       * 右边是 set **变量**时这一层看不出它是 set 还是序列 —— 那一格照旧发 `contains`，
       * 是明说的不足第 6 条。
       */
      if (o === 'in' || o === 'notin') {
        const yes = tag(b) === 'set-lit'
          ? mapHas(toNode(b), toNode(a))
          : node('prim', { args: [toNode(b), toNode(a)] }, { name: 'contains' });
        return o === 'in' ? yes : un('not', yes);
      }
      /**
       * **set 的代数不许悄悄变成算术**：nim 里 `a + b` / `a - b` / `a * b` / `a <= b`
       * 在 set 上是并 / 差 / 交 / 子集，而 `binOf` 会把它们映到 `add` / `sub` / `mul` /
       * `le` —— 那是**静默的错答案**，比报错坏得多。
       *
       * 这一层没有类型，能认出来的只有"操作数就写着 set 字面量"这一种（语料里 177 处）。
       * 两边都是 set 变量的那种（`x.flags - y.flags`）认不出来 —— 明说的不足第 7 条。
       */
      if (SET_ALG.has(o) && (tag(a) === 'set-lit' || tag(b) === 'set-lit')) {
        throw new Error(`nim->graph: \`${o}\` 的一边是 set 字面量 —— set 上它是并/差/交/子集，`
          + '图上没有那一族节点，落成算术是错答案');
      }
      // `&` 是 nim 的串连接 —— 表里映到 `concat` 那格内建，与算符走同一条路
      return binOf(o, toNode(a), toNode(b), OPS, { lang: 'nim', and: ['and'], or: ['or'] });
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
      // `m["a"]` 与 `xs[0]` 在树上同形（都是 `bracket`）—— 分开靠那一趟扫查。
      // **下标那一格是空的**就是 nim 的解引用（`p[]`）：图上没有指针那一格，当场报 ——
      // 原来这儿把 undefined 往下传，一路走到兜底那句话上炸成了 TypeError。
      if (sub === undefined) {
        throw new Error('nim->graph: `p[]`（解引用）图上没有指针那一格 —— 这一批不猜');
      }
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
    /**
     * `if cond: a elif cond2: b else: c` 在**表达式位置** -> 与 `if` 语句同一格 branch。
     *
     * 树形不同：`(ifexpr cond a (elifs (elif cond2 b)) (else c))` —— cond 与 a 直接是
     * 子节点（第 1 个和第 2 个），而不是 `(body …)` 包装。elif 那一串和 else 照旧有标签。
     * 最后一个 else 必须有（表达式 if 必须有值）—— 不在的话走兜底那一句。
     */
    case 'ifexpr': {
      const [cond, thenExpr] = kids(x);
      const elifs = part(x, 'elifs');
      const els = part(x, 'else');
      let chain = els === undefined ? undefined : toNode(kids(els)[0]);
      if (elifs !== undefined) {
        const es = kids(elifs).filter((e) => tag(e) === 'elif');
        for (let i = es.length - 1; i >= 0; i -= 1) {
          chain = branchOf(toNode(kids(es[i])[0]), toNode(kids(es[i])[1]), chain);
        }
      }
      return branchOf(toNode(cond), toNode(thenExpr), chain);
    }
    /**
     * `when cond: a elif … else: c` 在**表达式位置** —— 编译期分支的表达式形态。
     *
     * 与 `when`（语句那一支）逻辑相同：按 NIM_CT_ENV 求值，中的那支摊开、别的丢掉。
     * 区别只是子节点是**单个表达式**（不是 `(body …)` 包装的多行语句）。
     */
    case 'whenexpr': {
      const [condNode, thenExpr] = kids(x);
      if (whenCond(condNode)) return toNode(thenExpr);
      const elifs = part(x, 'elifs');
      if (elifs !== undefined) {
        for (const e of kids(elifs)) {
          if (tag(e) !== 'elif') continue;
          if (!whenCond(kids(e)[0])) continue;
          return toNode(kids(e)[1]);
        }
      }
      const els = part(x, 'else');
      if (els === undefined) return [];
      return toNode(kids(els)[0]);
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
    // `nil` 那一格在 `name` 分支里认 'nil' 只兜住了写成名字的那一路，
    // 而 nim.grammar 给 nil 一条**自己的产生式** `(nil)` —— 与 vlang 的 `(bool …)` 同一种错
    case 'nil': return node('const', {}, { value: null });
    /**
     * `'a'` —— nim 的字符字面量。**落一格单字符的串**（与 V 那一份同一条口径）。
     *
     * 原来这儿当场报，理由写的是"印出来是字符、`ord` 又要它是数，落哪一格都会在另一处错"。
     * **那个理由是对的，可它没数过语料**：nim 自己那门编译器里字符字面量 1594 处，
     * 而与 `ord(` 同行的只有 **34 处（2.1%）** —— 压倒性地是 `s[i] == '0'` / `of '$'` /
     * `add(' ')` 这一族"比较与拼接"。落成单字符的串，那 97.9% 就对了。
     *
     * 剩下那 2.1%（`ord(frmt[i]) - ord('0')`）**照旧走 `ord` 那格调用**，而 `ord` 这一层
     * 没接 —— 于是它是一格有名有姓的墙，不是静默的错答案。这一条与 V 那一份逐字同理
     * （那边是 `` c + `0` `` 4 处 / 508 处）。
     *
     * 记号里带着两端的单引号（`leaf` 拿到的是 `'a'` 三个字符）—— 去掉它们，
     * 转义在这儿解开。不去掉就成了三字符的串：与真的单字符串比一律不等，那是静默的错答案。
     */
    case 'char': {
      const raw = leaf(kids(x)[0]);
      const inner = raw.length >= 2 && raw[0] === "'" ? raw.slice(1, -1) : raw;
      const ch = inner.length >= 2 && inner[0] === '\\'
        ? ({ n: '\n', t: '\t', r: '\r', '0': '\u0000', '\\': '\\', "'": "'" })[inner[1]] ?? inner[1]
        : inner;
      return node('const', {}, { value: ch });
    }
    /**
     * `{1, 3, 5}` —— nim 的 **set 字面量**。`{k: v}` 带 kv 的那种是 table 构造。
     *
     * **落到 `map-new`**：set 是 key → true 的 map（`x in s` 已经落到 `contains`，
     * 那一格就是 `mapHas`），table 的 kv 直接落 mapNew(pairs)。
     *
     * **区间**（`{a .. b}`）也在这一层：nim 的 set 里 `..` 是"从 a 到 b 的连续值"，
     * 静态展开需要类型信息（set[char] 与 set[int] 的宽度不同），我们在这一层没有类型
     * —— 直接报。`{a .. b}` 在语料里是 175 处，但 **set-lit 只是包它的壳**，
     * 区间在树上就是一格 `bin` children `[.., a, b]`。我们按孩子逐个走：kv 走 pair、
     * bin `..`/`..<` 报、裸表达式走 key → true。
     */
    case 'set-lit': {
      const ch = kids(x);
      if (ch.length === 0) return mapNew();
      /* 全是 kv -> table 构造（与 toTable 同一格）。 */
      if (ch.every((c) => tag(c) === 'kv')) {
        return mapNew(ch.map((c) => [toNode(kids(c)[0]), toNode(kids(c)[1])]));
      }
      /* 有 kv 也有裸值 -> 混合形状，不猜 */
      if (ch.some((c) => tag(c) === 'kv')) {
        throw new Error('nim->graph: set 字面量里混着 kv 与裸值 —— 这一批不猜');
      }
      /* 裸值里有区间 `a .. b` / `a ..< b` 就报（静态展开要类型） */
      for (const c of ch) {
        if (tag(c) === 'bin' && kids(c).length > 0) {
          const o = leaf(kids(c)[0]);
          if (o === '..' || o === '..<') {
            throw new Error('nim->graph: set 字面量里的区间（`a .. b`）要类型才展得开 —— 这一批不猜');
          }
        }
      }
      /* 裸元素 -> key:true 的 map */
      return mapNew(ch.map((c) => [toNode(c), lit(true)]));
    }
    // `from system import nil` / `export symbol` —— 另两种导入写法，丢掉
    case 'from': case 'export': return [];
    // `discard f()` / `discard` —— **算掉、把值扔了**。带作用的那一格（调用）要留下，
    // 纯值那一格扔了就是真的没了（`discard 0` 是 nim 写"这儿什么都不做"的办法）。
    case 'discard': {
      const e = kids(x)[0];
      if (e === undefined) return [];
      const v = toNode(e);
      return v.op === 'call' || v.op === 'prim' ? v : [];
    }
    /**
     * `for x in xs:` 落一格**计数循环**（`counted`，与 go 的 range、V 的 `for … in` 同一格）。
     *
     * nim 这一格的特殊之处在于 **`countup` / `countdown` / 区间操作符 `..` 和 `..<`**
     * 都在语料里——但它们在树上就是普通调用或中缀运算符。所以这一格收两条路：
     *   * `for x in collection:` —— 按长度遍历（与 V 的 `for x in xs` 一样：
     *     一个名字给的是元素，两个名字才是"下标 + 元素"）。
     *   * `for x in a ..< b:` —— 区间（上界不含 `..<` 或含 `..`）：没有序列，
     *     x 直接走 counted。
     *
     * 迭代器（`items` / `pairs`）还没接——但它们在树上也只是一格调用，
     * 第一批走不进去只是因为调用的返回值没有类型。
     */
    case 'for': {
      const nms = part(x, 'names') ?? part(x, 'untuple');
      const body = kids(x).find((y) => tag(y) === 'body');
      const subj = kids(x).find((y) => tag(y) !== 'names' && tag(y) !== 'untuple'
        && tag(y) !== 'body');
      if (nms === undefined || subj === undefined) {
        throw new Error('nim->graph: for 里没有 (names …) 或 subject');
      }
      const names = kids(nms).map((n) => nameOf(n));
      const inner = body === undefined ? [] : many(kids(body));
      const at = (n) => node('ref', {}, { name: n });
      // 区间：`for i in 0 ..< n:` —— 中缀 `..<` 或 `..` 在树上就是一格 bin
      if (tag(subj) === 'bin' && (leaf(kids(subj)[0]) === '..<'
          || leaf(kids(subj)[0]) === '..')) {
        if (names.length !== 1) {
          throw new Error('nim->graph: 区间那一路只能有一格名字');
        }
        const [op, lo, hi] = kids(subj);
        const limName = '__fl0';
        const isExcl = leaf(op) === '..<';
        return node('region', {
          body: [
            node('bind', { init: toNode(hi) }, { name: limName }),
            counted({
              name: names[0],
              from: toNode(lo),
              cond: bin(isExcl ? '<' : '<=', at(names[0]), at(limName)),
              body: [node('region', { body: inner })],
            }),
          ],
        });
      }
      // 调用 countup / countdown 也是区间：`for i in countup(a, b):`
      if ((tag(subj) === 'call' || tag(subj) === 'command')) {
        const fn = kids(subj)[0];
        const cName = (tag(fn) === 'name' || tag(fn) === 'n') ? leaf(kids(fn)[0]) : null;
        if (cName === 'countup' || cName === 'countdown') {
          if (names.length !== 1) {
            throw new Error(`nim->graph: ${cName} 那一路只能有一格名字`);
          }
          const argNodes = kids(kids(subj)[1] ?? []);
          if (argNodes.length < 2) {
            throw new Error(`nim->graph: ${cName} 要两格实参`);
          }
          const limName = '__fl0';
          return node('region', {
            body: [
              node('bind', { init: toNode(argNodes[1]) }, { name: limName }),
              counted({
                name: names[0],
                from: toNode(argNodes[0]),
                cond: bin(cName === 'countdown' ? '>=' : '<=', at(names[0]), at(limName)),
                body: [node('region', { body: inner })],
                step: cName === 'countdown' ? lit(-1) : undefined,
              }),
            ],
          });
        }
      }
      /* 一格 `Table`：**按键遍历**（第三十批）。nim 的 `for k in t` 给的是键、
         `for k, v in t` 是键与值（`t.pairs` 那种写法在树上已经落成同一个形状）。
         三门在这一格上恰好同形，所以走共用的那一份 `mapForIn`。 */
      if (isMap(subj)) {
        return mapForIn({
          subject: toNode(subj),
          keyName: names.length > 0 ? names[0] : null,
          valName: names.length > 1 ? names[1] : null,
          body: inner,
          mapVar: '__nm0',
          keysVar: '__nk0',
          idxVar: '__ni0',
          cntVar: '__nn0',
        });
      }
      // 一般集合（seq / array）
      const seq = '__ns0';
      const idx = '__ni0';
      const cnt = '__nn0';
      const head = [];
      const elem = indexGet(at(seq), at(idx));
      if (names.length === 1) {
        if (names[0] !== '_') head.push(node('bind', { init: elem }, { name: names[0] }));
      } else if (names.length === 2) {
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
    /**
     * `case x` 落一条 **branch 链**（与 go 的 switch、V 的 match 同一件事）。
     *
     * nim 的 case 有 `of` / `elif` / `else` 三种分支 —— `elif` 走**自己的条件**
     * （不是"主语等于什么"），它比 go 的 switch 多出来的正是这一格。
     */
    case 'case': {
      const subj = kids(x)[0];
      const holder = '__cs0';
      const at = (n) => node('ref', {}, { name: n });
      const arms = [];
      let dflt;
      for (const a of kids(x).slice(1)) {
        if (tag(a) === 'else') {
          dflt = node('region', { body: many(kids(a)) });
          continue;
        }
        if (tag(a) === 'elif') {
          const eb = part(a, 'body');
          if (eb === undefined) throw new Error('nim->graph: elif 里没有 (body …)');
          arms.push([toNode(kids(a)[0]), node('region', { body: many(kids(eb)) })]);
          continue;
        }
        if (tag(a) !== 'of') throw new Error(`nim->graph: case 里不该有 ${tag(a)}`);
        const vals = part(a, 'values');
        const body = kids(a).find((y) => tag(y) === 'body');
        if (vals === undefined) throw new Error('nim->graph: of 里没有 (values …)');
        /* **`of 1 .. 5:` 是一段区间**（nim 的区间**含上界**）—— 落成两格比较用 and 串起来。
           从前这一支跟着走 `==`，于是那格 `..` 掉进 `binOf` 里当场报"这个算子还没接：.."。
           区间在 nim 里是中缀算符，所以这儿要自己认（`for` 那一格早就是这么认的）。 */
        const oneCond = (v) => {
          if (tag(v) === 'bin' && leaf(kids(v)[0]) === '..') {
            const [, lo, hi] = kids(v);
            return lazyAnd(
              binOf('>=', at(holder), toNode(lo), OPS, { lang: 'nim', and: ['and'], or: ['or'] }),
              binOf('<=', at(holder), toNode(hi), OPS, { lang: 'nim', and: ['and'], or: ['or'] }),
            );
          }
          return binOf('==', at(holder), toNode(v), OPS, { lang: 'nim', and: ['and'], or: ['or'] });
        };
        const conds = kids(vals).map(oneCond);
        arms.push([
          conds.reduce((p, q) => lazyOr(p, q)),
          node('region', { body: body === undefined ? [] : many(kids(body)) }),
        ]);
      }
      let chain = dflt;
      for (let i = arms.length - 1; i >= 0; i -= 1) chain = branchOf(arms[i][0], arms[i][1], chain);
      if (chain === undefined) return [];
      return node('region', {
        body: [node('bind', { init: toNode(subj) }, { name: holder }), chain],
      });
    }
    // `when` 是 nim 的**编译期分支**（V 里那一格叫 `ctime`、`$if`）。
    //
    // **它不是映射的账，也不能丢掉**：`when defined(windows): …` 丢掉就少了一段代码，
    // 顶层的 `when` 里还装着声明 —— 丢了就是"答案错而不报"。落成运行期 branch 也不对：
    // 没走的那一支在 nim 里根本不要求编得过。这一格要的是**编译期求值**（ADR-0037 §7
    // 第 9 步那一刀），所以它留在墙上。
    /**
     * `when 条件: … elif … else …` —— **编译期分支**：按声明过的那张环境表求值，
     * 走中的那一支摊开、**没走的那一支整格丢掉**（nim 明说没走的那支不要求编得过）。
     * 图上一格新节点也没加 —— 这一格根本不该落成运行期的 branch。
     */
    case 'when': {
      const body = part(x, 'body');
      if (whenCond(kids(x)[0])) return body === undefined ? [] : many(kids(body));
      for (const e of kids(part(x, 'elifs') ?? { kind: 'list', items: [] })) {
        if (tag(e) !== 'elif') continue;
        if (!whenCond(kids(e)[0])) continue;
        const eb = part(e, 'body');
        return eb === undefined ? [] : many(kids(eb));
      }
      const els = part(x, 'else');
      if (els === undefined) return [];
      const eb = part(els, 'body') ?? kids(els)[0];
      return eb === undefined ? [] : many(kids(eb));
    }
    case 'import': case 'include': case 'type-section': case 'pragma': return [];
    default:
      throw new Error(`nim->graph: 这一格还没接：${tag(x) ?? String(JSON.stringify(x)).slice(0, 40)}`);
  }
}

/**
 * 一棵 nim 的 GLR 树（`(module 项…)`）-> 一张图。
 *
 * `opts` 收下但不用：nim 的顶层代码**本来就该跑**（import 一份 nim 模块会跑它的顶层），
 * 所以"被导入的那份"与"主文件"在这门语言里没有区别 —— go / v 那两门要夹掉末尾那格
 * `call main`，这门不用。
 */
export function nimToGraph(tree, opts) {
  if (tag(tree) !== 'module') throw new Error('nim->graph: 这不是 (module …)');
  // 先扫一遍哪些名字装 Table（`initTable[K, V]()` 那种造法在树上认得出）
  MAPS.clear();
  for (const nm of mapNames(tree, mapBindName)) MAPS.add(nm);
  // 再扫一遍**登记过的类型名**与**每个 proc 的形参名**：前者判 `T(x: 1)`、
  // 后者把 `f(x = 1)` 排回位置。这两问都不用驱动器回问 —— 树上就有答案。
  TYPES.clear();
  PARAMS.clear();
  /* **一起编的那几份先扫**（`opts.also`）：nim 的 `T(x: 1)` 要"这名字登记成类型了吗"、
     `f(x = 1)` 要形参名，而这两样都可能声明在 import 进来的那份里。
     这一趟只收声明，不落节点；旁边的先扫、自己的后扫。 */
  for (const t of opts?.also ?? []) {
    if (t === tree) continue;
    for (const nm of mapNames(t, mapBindName)) MAPS.add(nm);
    collectDecls(t, true);   // shapesOnly：类型名要，形参名不要（重载会盖错）
  }
  collectDecls(tree);
  return program(kids(tree).map(toNode).flat());
}

/**
 * 这份文件 `import` / `include` 了哪几格（第一百五十一片第二格）。
 * 树上是 `(import (name tables) …)`；`import a/b` 那种带斜杠的路径拼回原文。
 */
export function nimImports(tree) {
  const out = [];
  const text = (x) => {
    if (!isList(x)) return leaf(x) ?? '';
    /* `kids()` **本来就不含标签**（`fromtree.js:34` 是 `items.slice(1)`）——
     * 所以这儿不能再 slice 一次。踩过：那样 `(name util)` 拼出来是空串。 */
    return kids(x).map(text).filter((s) => s !== '').join('/');
  };
  const walk = (x) => {
    if (!isList(x)) return;
    if (tag(x) === 'import' || tag(x) === 'include') {
      for (const it of kids(x)) {
        const spec = text(it);
        if (spec !== '') out.push(spec);
      }
      return;
    }
    for (const k of kids(x)) walk(k);
  };
  walk(tree);
  return out;
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
//   6. **set 落成 key → true 的 map**（2026-09-19）。两处是明说的偏差：
//      - 迭代次序：nim 的 set 按 ordinal 走，`map-new` 是插入序。只做成员判断时看不出来。
//      - `x in s` 里 `s` 是 set **变量**时这一层不知道它是 set 还是序列，照旧发
//        `contains`（找元素）而不是 `map-has`（找键）—— 右边**写着** set 字面量的
//        那一种才发 `map-has`。语料里最常见的 `n.kind in {nkIdent, nkSym}` 属于后者。
//   7. **set 的代数只挡得住一半**：`+` / `-` / `*` / `<=` 在 set 上是并/差/交/子集，
//      落成算术是静默的错答案，所以有一边**写着** set 字面量就当场报（`SET_ALG`，
//      语料里 177 处）。两边都是 set **变量**（`x.flags - y.flags`）这一层认不出来 ——
//      要真治得给图加一族 set 节点（或者第 40 条那层类型）。这一条是**已知的残留风险**，
//      不是"已经解决"。
