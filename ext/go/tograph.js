// ext/go/tograph.js —— **Go 的树 -> 节点图**（第三个前端，同一张 13 格节点清单）
//
// 三门语言对着看，这一步的意义才完整：Scheme 只有 datum、Lua 是具体语法、Go 是
// 静态类型 + 分号自动插入的语言 —— **树差得越远，落到的节点越是同一批**。
//
// Go 这一份多出来的两格"约定"，都不是节点的事，写在这儿：
//   * **类型全丢掉**（`(sig (in (p (tname int) (name n))) (out (tname int))`）：
//     type 是端口的 sort，不是图上的格子（`src/core/graph/nodes.js` 文件头第一条）。
//     这一批只取形参**名字**；类型要用起来是 `carry` 那一问的事（契约 §6）。
//   * **入口是 `main`**：图从上到下跑，所以映射末尾显式补一格 `call main` ——
//     那是这门语言的约定，不是新节点。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  tag, kids, leaf, part, partKids, threePart, elseOf,
  ops, binOf, retOf, branchOf,
  destructure, recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet,
} from '../../src/core/graph/fromtree.js';


const OPS = ops();
/** `fmt.Println` / `println` / `print` 都落 `prim print`（**print 不是节点**）。 */
const PRINTS = new Set(['Println', 'Printf', 'Print', 'println', 'print']);

const many = (xs) => xs.map(toNode).flat();

/** `(name x)`。Go 的 lhs 也是它。 */
const nameOf = (x) => (tag(x) === 'name' ? leaf(kids(x)[0]) : leaf(x));

function funcOf(sig, blk, name) {
  const params = partKids(sig, 'in').map((p) => {
    const nm = part(p, 'name');
    return nm === undefined ? null : leaf(kids(nm)[0]);
  }).filter((n) => n !== null);
  return node('func', { body: blk === undefined ? [] : many(kids(blk)) }, { params, name });
}

function toNode(x) {
  switch (tag(x)) {
    // ---- 叶子 --------------------------------------------------------------
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: leaf(kids(x)[0]) });
    case 'name': {
      const n = leaf(kids(x)[0]);
      if (n === 'true') return node('const', {}, { value: true });
      if (n === 'false') return node('const', {}, { value: false });
      if (n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    // `p.x` -> field-get（与 lua/nim 的 `(dot …)`、V 的 `(sel …)` 同一格节点）
    case 'sel': return fieldGet(toNode(kids(x)[0]), leaf(kids(x)[1]));
    // `Point{x: 1, y: 2}` -> record-new；`[]int{10, 20}` -> list-new。
    // **同一条产生式两种字面量**：带字段名的落记录、不带的落列表（混着的当场报）。
    case 'lit': {
      const elems = kids(x).slice(1);
      if (elems.length > 0 && elems.every((e) => tag(e) === 'kv')) {
        return recordNew(elems.map((e) => {
          const [k, v] = kids(e);
          return [nameOf(k), toNode(v)];
        }));
      }
      if (elems.some((e) => tag(e) === 'kv')) {
        throw new Error('go->graph: 这一批不接"字段名与位置混着"的复合字面量');
      }
      return listNew(many(elems));
    }
    case 'index': return indexGet(toNode(kids(x)[0]), toNode(kids(x)[1]));

    // ---- 算子 --------------------------------------------------------------
    case 'bin': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'go' });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === '!' ? 'not' : leaf(op), toNode(a));
    }

    // ---- 声明与语句 --------------------------------------------------------
    case 'fn': {
      const [nm, sig, blk] = kids(x);
      const name = leaf(nm);
      return node('bind', { init: funcOf(sig, blk, name) }, { name });
    }
    case 'block': return node('region', { body: many(kids(x)) });
    case 'define': case 'assign': {
      // `a, b := 1, 2` 与 `a = 1`。`define` 出 bind、`assign` 出 set —— 一格之差，
      // 正是"decl 就是 bind"那句话（没有 decl 节点）。
      const isDef = tag(x) === 'define';
      const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
      const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
      // `x, y := f()` / `x, ok = m[k]`：N 个名字对 1 个右值 ⇒ 多值的消费侧
      if (lhs.length > 1 && rhs.length === 1) {
        return destructure(lhs.map(nameOf), toNode(rhs[0]), { declare: isDef });
      }
      return lhs.map((t, i) => {
        const v = rhs[i] === undefined ? lit(null) : toNode(rhs[i]);
        // 左边是一格字段（`p.y = 5`）或一格下标（`xs[1] = 5`）⇒ field-set / index-set；
        // `set` 只认名字
        if (tag(t) === 'sel') return fieldSet(toNode(kids(t)[0]), leaf(kids(t)[1]), v);
        if (tag(t) === 'index') return indexSet(toNode(kids(t)[0]), toNode(kids(t)[1]), v);
        return isDef
          ? node('bind', { init: v }, { name: nameOf(t) })
          : node('set', { value: v }, { name: nameOf(t) });
      });
    }
    case 'inc': case 'dec': return node('set', {
      value: bin(tag(x) === 'inc' ? '+' : '-', toNode(kids(x)[0]), lit(1)),
    }, { name: nameOf(kids(x)[0]) });
    case 'for': {
      // 三种 `for` 落成同一格 loop（**不给它开节点**）。形状与 vlang / awk 一模一样，
      // 所以那句话只写一遍 —— `threePart` 在 `src/core/graph/fromtree.js` 里。
      const init = part(x, 'init');
      const cond = part(x, 'cond');
      const post = part(x, 'post');
      const blk = kids(x).find((y) => tag(y) === 'block');
      return threePart({
        init: init === undefined ? [] : many(kids(init)),
        cond: cond === undefined ? undefined : toNode(kids(cond)[0]),
        post: post === undefined ? [] : many(kids(post)),
        body: blk === undefined ? [] : many(kids(blk)),
      });
    }
    case 'if': {
      const parts = kids(x);
      // `else` 那一格是个包装（`(else (block …))` 或 `(else (if …))` —— else-if 链）
      const els = elseOf(parts[2]);
      return branchOf(toNode(parts[0]), toNode(parts[1]), els === undefined ? undefined : toNode(els));
    }
    case 'return': return retOf(many(kids(x)));
    case 'expr': return toNode(kids(x)[0]);
    // `defer f()` -> scope-exit（挂在**当前 region**上，逆序、早退也跑 —— 八家共用那一格）
    case 'defer': return node('scope-exit', { action: many(kids(x)) });
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      // `fmt.Println(x)`：选择器那一格在这一批还没有节点（`record` 排在后面），
      // 所以只认"打印"这一族，别的 sel 调用当场报 —— 不猜、不静默。
      if (tag(fn) === 'sel') {
        const m = leaf(kids(fn)[1]);
        if (PRINTS.has(m)) return node('prim', { args: argNodes }, { name: 'print' });
        throw new Error(`go->graph: 这一批只接 fmt.Print* 那一族，收不了 .${m}`);
      }
      const callee = tag(fn) === 'name' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    // 顶层的这几样在这一批里没有对应物（包、导入、类型声明）—— 丢掉，不猜。
    // `typedecl` 那格：**struct 的字段表不进图**（record-new 的字段名从字面量那儿来），
    // 树上的标签是 `typedecl` 不是 `type-decl` —— 原来写错了一格，record 那份例子量出来的。
    case 'import': case 'typedecl': case 'const-decl': case 'var-decl': return [];
    default:
      throw new Error(`go->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 go 的 GLR 树（`(file 包名 顶层项…)`）-> 一张图。末尾补一格 `call main`。 */
export function goToGraph(tree) {
  if (tag(tree) !== 'file') throw new Error('go->graph: 这不是 (file …)');
  const items = kids(tree).slice(1);          // 第一格是包名
  const body = items.map(toNode).flat();
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 类型全丢（见文件头）；`var` / `const` 顶层声明也丢 —— 例子里不用它们。
//   2. 多返回值、`x, ok = m[k]`、defer、goroutine、channel 都不在这一批
//      （`ext/go/SPEC.md` §五那张顺序表说了它们各排在哪一步）。
//   3. 选择器（`a.b`）落 `field-get`（第四批），但**只当它是取字段** ——
//      `fmt.Println` 那种"包名点方法"仍在 `call` 那一格特判，因为它不是取字段。
