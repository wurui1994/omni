// ext/mojo/tograph.js —— **Mojo 的树 -> 节点图**（第八个前端，Python 形状）
//
// 这一门与 nim 一样是**缩进即块**（词法层出 INDENT/DEDENT），可到了图这一层
// 那件事已经消失了 —— 缩进只是语法的形状，节点还是那 13 格。
//
// 两格要说的：
//   * `var x = 1` 与 `x = 1` 在树上是同一条 `assign`，差别在 targets 里有没有 `bind` ——
//     所以映射按它分 `bind` / `set`（**decl 就是 bind**，没有 decl 节点）。
//   * `fn` 与 `def` 落同一格 `func`（`ext/mojo/SPEC.md` §六第 3 条记着它们效应默认值
//     可能不同 —— 那是效应栏的事，不是节点的事）。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part, groupItems, unquote,
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, listNew, indexGet, indexSet, sliceOf,
  fieldGet, fieldSet,
} from '../../src/core/graph/fromtree.js';

/**
 * **mojo 的 `struct`：字段表在类型上**（与 FB 的 `Type … End Type` 同一形状）。
 *
 * `@value struct Point: var x: Int …` 里那个 `@value` 正是 mojo 生成 `__init__` 的写法，
 * 所以 `Point(1, 2)` 是**按字段顺序**的构造 —— 那就是 `record-new` 那一格。
 * 字段顺序从声明登记（与 CL / Scheme / FB 同一条纪律：**名字与顺序从声明来**），
 * `p.x` 落 `field-get`、`p.y = 5` 落 `field-set`。
 *
 * 只收"字段顺序就是构造顺序"这一种：自己写 `fn __init__` 的那种要方法分派
 * （账上另一条），撞上就当普通调用 —— 于是干净地报 `unbound name`，不假接受。
 */
const STRUCTS = new Map();

/**
 * **方法名 -> 它声明在哪个 struct 里**（`case 'struct'` 那一格边翻边填）。
 * mojo 的 `self` 写在形参表第一格 —— 所以方法在图上就是**普通函数**，
 * 这张表只用来认出 `p.total()` 那种写法该改写成 `total(p)`（不查表、不加节点）。
 */
const METHODS = new Map();

/**
 * 进门时一趟扫查：把每个 struct 里的方法名登记成 `名字 -> 它声明在哪个 struct 里`。
 * 单独扫一遍而不是边翻边填，因为 `with` 在 `main` 里就要问"`__exit__` 是方法吗"，
 * 而 struct 可以写在 `main` 后面 —— 判据不许依赖文件里的先后。
 */
function collectMethods(x) {
  if (!isList(x)) return;
  if (tag(x) === 'struct') {
    const nm = kids(x).find((y) => tag(y) === 'n');
    const owner = nm === undefined ? '?' : String(nameOf(nm));
    const body = part(x, 'body');
    const stmts = body === undefined ? [] : kids(body)
      .map((ln) => (tag(ln) === 'line' ? kids(ln)[0] : ln))
      .filter((s) => s !== undefined && tag(s) === 'routine');
    for (const m of stmts) {
      const mn = kids(m).find((y) => tag(y) === 'n');
      if (mn === undefined) continue;
      const name = String(leaf(kids(mn)[0]));
      const had = METHODS.get(name);
      if (had !== undefined && had !== owner) {
        throw new Error(`mojo->graph: ${had} 与 ${owner} 都声明了方法 ${name} —— `
          + '重名要类型才分得开，这一批不猜');
      }
      METHODS.set(name, owner);
    }
  }
  for (const k of kids(x)) collectMethods(k);
}

/** `with` 那几格临时名字的序号 —— **一份源码一份**（进门时清零，见 mojoToGraph）。 */
let withSeq = 0;


const OPS = ops({ '//': '/' });
/** mojo 的转换名是**大写开头**的类型名（`Int` / `Float64` / `String`）。 */
const CONV = convs({
  Int: 'int', Int8: 'int', Int32: 'int', Int64: 'int',
  Float32: 'float', Float64: 'float', String: 'str', Bool: 'bool',
});
const PRINTS = new Set(['print', 'println']);

const many = (xs) => xs.map(toNode).flat();
const nameOf = (x) => {
  if (tag(x) === 'bind') return nameOf(kids(x)[1]);   // `(bind "var" (n x))`
  if (tag(x) === 'n') return leaf(kids(x)[0]);
  if (tag(x) === 'targets') return nameOf(kids(x)[0]);
  return leaf(x);
};

function toNode(x) {
  if (isList(x) && x.items.length === 0) return [];
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: unquote(leaf(kids(x)[0])) });
    case 'n': {
      const n = leaf(kids(x)[0]);
      if (n === 'True') return node('const', {}, { value: true });
      if (n === 'False') return node('const', {}, { value: false });
      if (n === 'None') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    // `[10, 20, 30]` -> list-new；`xs[i]` -> index-get（下标装在一格 `(subs …)` 里）
    case 'list': return listNew(many(kids(x)));
    // `p.x` -> field-get（与 go/V 的 `(sel …)`、lua/nim 的 `(dot …)` 同一格）
    case 'attr': return fieldGet(toNode(kids(x)[0]), String(leaf(kids(x)[1])));
    case 'index': {
      const sub = kids(kids(x)[1])[0];
      // `xs[1:3]`：下标里装着一格 `(slice from to)` -> slice；别的就是取一格
      if (tag(sub) === 'slice') {
        const [a, b] = kids(sub);
        return sliceOf(toNode(kids(x)[0]), a === undefined ? undefined : toNode(a),
          b === undefined ? undefined : toNode(b));
      }
      return indexGet(toNode(kids(x)[0]), toNode(sub));
    }
    case 'line': case 'body': return many(kids(x));
    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'expr': return toNode(kids(x)[0]);

    // `bin` 与 `cmp` 是同一个形状（`(cmp "<=" a b)`）—— 比较在 mojo 的语法里单开一级
    // （Python 的链式比较），但**落到的是同一格 binop**：语法的级数不是节点的格数。
    case 'bin': case 'cmp': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'mojo', and: ['and'], or: ['or'] });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === 'not' ? 'not' : leaf(op), toNode(a));
    }
    // `var x = 1`（targets 里带 bind）出 bind；`x = 1` 出 set；`xs[1] = 5` 出 index-set
    case 'assign': {
      const targets = part(x, 'targets');
      const value = kids(x).find((y) => tag(y) !== 'targets');
      const v = value === undefined ? lit(null) : toNode(value);
      const t0 = targets === undefined ? undefined : kids(targets)[0];
      if (tag(t0) === 'index') return indexSet(toNode(kids(t0)[0]), toNode(kids(kids(t0)[1])[0]), v);
      // `p.y = 5`：左边是字段 -> field-set（与 go 的 `p.y = 5` 同一格）
      if (tag(t0) === 'attr') return fieldSet(toNode(kids(t0)[0]), String(leaf(kids(t0)[1])), v);
      const isDecl = targets !== undefined && kids(targets).some((t) => tag(t) === 'bind');
      const name = nameOf(targets);
      return isDecl
        ? node('bind', { init: v }, { name })
        : node('set', { value: v }, { name });
    }
    case 'augassign': {
      const [op, target, value] = kids(x);
      const name = nameOf(target);
      const o = OPS.get(String(leaf(op)).replace('=', ''));
      if (o === undefined) throw new Error(`mojo->graph: 这个复合赋值还没接：${leaf(op)}`);
      return node('set', {
        value: bin(o, node('ref', {}, { name }), toNode(value)),
      }, { name });
    }
    case 'routine': {
      const nm = kids(x).find((y) => tag(y) === 'n');
      const name = nm === undefined ? null : leaf(kids(nm)[0]);
      const sig = part(x, 'sig');
      const ps = sig === undefined ? [] : kids(sig).filter((y) => tag(y) !== 'ret');
      // `(sig ((p (n n) (n Int)) (p …)) (ret …))` —— 形参装在一格**无名的表**里。
      // 无名表的孩子是**全部** items（不是 items.slice(1)）—— 少了这一条，
      // 每个函数的第一个形参会被当成"标签"吃掉，于是 `n` 未绑定。矩阵当场抓出来的。
      const params = ps.flatMap((g) => (tag(g) === 'p' ? [g] : groupItems(g)))
        .filter((p) => tag(p) === 'p')
        .map((p) => nameOf(kids(p)[0]));
      const body = part(x, 'body');
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
      const els = part(x, 'else') ?? part(x, 'orelse');
      return branchOf(
        toNode(cond),
        body === undefined ? [] : many(kids(body)),
        els === undefined ? undefined : many(kids(els)),
      );
    }
    case 'return': return retOf(many(kids(x)));
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      const callee = tag(fn) === 'n' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      if (callee !== null && CONV.has(callee) && argNodes.length === 1) {
        return convOf(CONV.get(callee), argNodes[0]);   // `Int(x)` / `Float64(x)`
      }
      // `Point(1, 2)`：struct 登记过 -> 一格 record-new（实参按字段顺序，位置对位置）
      if (callee !== null && STRUCTS.has(callee)) {
        const fields = STRUCTS.get(callee);
        return node('record-new', {
          fields: fields.map((f, i) => (argNodes[i] === undefined ? lit(null) : argNodes[i])),
        }, { names: fields });
      }
      // `p.total()` -> `total(p)`：接收者是**第一格实参** —— 而 mojo 的 `self` 本来就
      // 写在形参表第一格，所以这一步只是"把点号那边的对象挪到实参里"，纯改写。
      if (tag(fn) === 'attr' && METHODS.has(String(leaf(kids(fn)[1])))) {
        return node('call', {
          fn: node('ref', {}, { name: String(leaf(kids(fn)[1])) }),
          args: [toNode(kids(fn)[0]), ...argNodes],
        });
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    // `@value struct Point: var x: Int …` —— 装饰器这一层剥掉，里头那格照常走
    case 'decorated': {
      const inner = kids(x).filter((y) => tag(y) !== 'decos');
      return inner.map(toNode).flat();
    }
    // `struct` 登记**字段顺序**，并把里头的方法**提到顶层** —— 见文件头 STRUCTS 那段。
    // 方法在 mojo 里连改写都不用：`self` 已经**写在形参表第一格**（声明里就有），
    // 所以 `fn total(self) -> Int` 落的就是现成的 bind + func，一格新节点也不加。
    case 'struct': {
      const nm = kids(x).find((y) => tag(y) === 'n');
      const body = part(x, 'body');
      const stmts = body === undefined ? [] : kids(body)
        .map((ln) => (tag(ln) === 'line' ? kids(ln)[0] : ln))
        .filter((s) => s !== undefined);
      const fields = stmts
        .filter((s) => tag(s) === 'var')
        .map((s) => nameOf(kids(s).find((y) => tag(y) === 'n')))
        .filter((s) => s !== undefined && s !== null);
      if (nm !== undefined && fields.length > 0) STRUCTS.set(String(nameOf(nm)), fields);
      // 字段表先登记好再翻方法体（方法里可能就有 `Point(…)` 那种构造）。
      // 方法**名字**那张表是进门时一趟扫查填好的（见 collectMethods）—— `with` 要在
      // 翻到 `main` 时就知道 `__exit__` 是不是方法，而 struct 可能写在后面。
      return stmts.filter((s) => tag(s) === 'routine').map(toNode).flat();
    }
    // `with A(1), B(2): 体` —— **出口动作从声明来**：`__enter__` 进、`__exit__` 出，
    // 两格都是方法（第二十四批已经跑得起来）。落的是**现成的 region + scope-exit**：
    //   region { bind t = A(1); bind _ = __enter__(t); scope-exit{ __exit__(t) }; … 体 }
    // 多个 item 按写的顺序进、**逆序**出（scope-exit 本来就是逆序，不用额外说一句），
    // 早退也跑（这一格与 go 的 defer、CL 的 unwind-protect 是**同一格节点**）。
    case 'with': {
      const items = part(x, 'items');
      const body = part(x, 'body');
      if (!METHODS.has('__enter__') || !METHODS.has('__exit__')) {
        throw new Error('mojo->graph: `with` 要 __enter__ 与 __exit__ 两格方法 —— '
          + '这份源码的 struct 里没声明过它们');
      }
      const pre = [];
      for (const it of (items === undefined ? [] : kids(items))) {
        const isAs = tag(it) === 'as';
        const t = `__with${++withSeq}`;
        const call1 = (m) => node('call', {
          fn: node('ref', {}, { name: m }),
          args: [node('ref', {}, { name: t })],
        });
        pre.push(node('bind', { init: toNode(isAs ? kids(it)[0] : it) }, { name: t }));
        // `as y` 有没有都要**进**（那是 mojo 的协议）：没写就绑到一格用不着的名字上
        pre.push(node('bind', { init: call1('__enter__') },
          { name: isAs ? String(nameOf(kids(it)[1])) : `${t}_v` }));
        pre.push(node('scope-exit', { action: [call1('__exit__')] }));
      }
      return node('region', {
        body: [...pre, ...(body === undefined ? [] : many(kids(body)))],
      });
    }
    case 'import': case 'from-import': case 'trait': case 'alias': return [];
    default:
      throw new Error(`mojo->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 mojo 的 GLR 树（`(module 项…)`）-> 一张图。末尾补一格 `call main`。 */
export function mojoToGraph(tree) {
  if (tag(tree) !== 'module') throw new Error('mojo->graph: 这不是 (module …)');
  STRUCTS.clear();          // 字段表是**一份源码一张**（见文件头 STRUCTS 那段）
  METHODS.clear();          // 方法表同理 —— 一份源码一张
  withSeq = 0;              // 临时名字的序号也归零：同一份源码建两遍要**逐字节相同**（G4）
  collectMethods(tree);
  const body = kids(tree).map(toNode).flat();
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 实参约定（默认 / `mut` / `var`+`^` / `out` / `ref`）与 origin 全丢掉 ——
//      它们是 `lifetime` 那一栏（`ext/mojo/SPEC.md` §五第 1-2 项），这一批只检查不使用。
//   2. `for x in …`（迭代器协议）不在这一批，所以例子用 `while`。
//   3. `struct` 只接**字段表 + 方法提到顶层**（第二十三、二十四批）；trait（真的动态分派）、
//      编译期参数 `[…]`、`with`、自己写的 `__init__` 都不在这一批 —— 撞上干净地报错。
//      同名方法（两个 struct 各有一个 `total`）当场报：分开它们要的是类型那一层。
