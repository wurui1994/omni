// ext/freebasic/tograph.js —— **FreeBASIC 的树 -> 节点图**（第七个前端）
//
// 这一门在语法上离前六门最远（行导向、块靠关键字收尾、自带词序的语句一大批），
// 可它落到的还是那 13 格 —— `ext/freebasic/SPEC.md` §3.5 那句话的可跑版本：
// **"语法难 ≠ 节点多"**。
//
// 两格要单独说的：
//   * **`=` 既是赋值也是比较**（同一个记号）。语法层刻意不分（分了就 113 份文件两个解），
//     所以"到底是哪一种"在这一份里按**位置**判：语句位置上的 `(bin "=" …)` 是赋值。
//     这正是那句"留给语义层"真正该落的地方 —— 图这一层，不是语法层。
//   * 串字面量的引号**留在记号文本里**（`(str "\"ok\"")`），这儿剥掉。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part, unquote, head,
  counted, ops, convs, convOf, binOf, retOf, branchOf, listNew, indexGet, indexSet,
  fieldGet, fieldSet,
} from '../../src/core/graph/fromtree.js';

/**
 * **FB 的数组：`xs(0)` 与函数调用同形**，所以得记住哪些名字是数组。
 *
 * `Dim xs(2) As Integer = {10, 20, 30}` 与 `f(0)` 在树上都是 `(call (n …) (args …))` ——
 * 分不开的话要么把取下标当调用（`unbound name: xs`），要么把调用当取下标（更糟）。
 * FB 自己是靠声明分的，映射也照这么办：`dim` 那一格看见 `(bounds …)` 就把名字记下来。
 *
 * 这与 CL / Scheme 的记录是**同一条纪律**：名字从声明来，落到的仍是现成那三格
 * （`list-new` / `index-get` / `index-set`），一格新节点都不加。
 * 下标起点：`Dim xs(2)` 是 0…2（0 起），与图上一致，所以不用像 lua 那样减一格。
 */
const ARRAYS = new Set();

/**
 * **FB 的 `Type … End Type`：字段表在类型上**，字面量那种写法它没有。
 *
 * 所以记录这一格也是"名字从声明来"：扫到 `(typedecl … (members (f (v (n x) …)) …))`
 * 就把字段顺序记下来，`Dim p As Point` 落成一格 `record-new`（数值字段按 FB 的语义**零起**），
 * `p.x` 落 `field-get`、`p.x = 1` 落 `field-set`。
 *
 * 图上还是现成那三格 —— 这件事原来在 `nodes.js` 的账上写着"要类型声明那一族"，
 * 量出来**记重了**：要的只是一张字段表（登记处），不是图里的类型层。
 */
const TYPES = new Map();


const OPS = ops({ mod: '%', '=': '=', '<>': '!=', '&': 'concat' });
/** 转换名（全小写着查）。`CInt` 是四舍五入、图上那格是截断 —— 差别记在文件尾。 */
const CONV = convs({
  cint: 'int', clng: 'int', clngint: 'int', cbyte: 'int', cshort: 'int',
  cdbl: 'float', csng: 'float', str: 'str', cbool: 'bool',
});

const many = (xs) => xs.map(toNode).flat();
const nameOf = (x) => (tag(x) === 'n' ? leaf(kids(x)[0]) : leaf(x));

function toNode(x) {
  // 空表：空行、只有注释的行、`(mods)` 那种空部件 —— 图上什么都不占
  if (isList(x) && x.items.length === 0) return [];
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: unquote(leaf(kids(x)[0])) });
    case 'n': return node('ref', {}, { name: leaf(kids(x)[0]) });
    case 'paren': return toNode(kids(x)[0]);
    // `p.x` —— 与 go/V 的 `(sel …)`、lua/nim 的 `(dot …)` 同一格 field-get
    case 'dot': return fieldGet(toNode(kids(x)[0]), String(leaf(kids(x)[1])));
    // `Type Point … End Type` —— 只登记字段表（声明这一批没有运行期动作）
    case 'typedecl': {
      const nm = kids(x).find((y) => tag(y) === 'n');
      const ms = part(x, 'members');
      const fields = ms === undefined ? [] : kids(ms)
        .filter((f) => tag(f) === 'f')
        .map((f) => nameOf(kids(kids(f)[0])[0]))
        .filter((s) => s !== undefined && s !== null);
      if (nm !== undefined) TYPES.set(String(nameOf(nm)).toLowerCase(), fields);
      return [];
    }
    // 一行 = 一条或几条语句（`:` 隔开的那几条也在这一格里）
    case 'line': return many(kids(x));
    case 'body': return many(kids(x));

    case 'bin': {
      const [op, a, b] = kids(x);
      // 关键字算符不分大小写 —— 先降成小写再查表（`AndAlso` 与 `andalso` 同一格）
      return binOf(String(leaf(op)).toLowerCase(), toNode(a), toNode(b), OPS, {
        lang: 'fb', and: ['andalso', 'and'], or: ['orelse', 'or'],
      });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === 'not' ? 'not' : leaf(op), toNode(a));
    }
    // 语句位置上的表达式：**顶上是 `=` 就是赋值**（见文件头第一条）
    case 'expr': {
      const inner = kids(x)[0];
      if (tag(inner) === 'bin' && leaf(kids(inner)[0]) === '=') {
        const [, lhs, rhs] = kids(inner);
        // `xs(1) = 5`：左边是**取下标**（数组名登记过）—— 落 index-set，与 go 的 `xs[1] = 5` 同一格
        if (tag(lhs) === 'call') {
          const [fn, args] = kids(lhs);
          const nm = tag(fn) === 'n' ? String(nameOf(fn)).toLowerCase() : null;
          if (nm !== null && ARRAYS.has(nm)) {
            return indexSet(node('ref', {}, { name: nameOf(fn) }), toNode(kids(args)[0]), toNode(rhs));
          }
        }
        // `p.x = 1`：左边是字段 —— 落 field-set（与 go 的 `p.x = 1` 同一格）
        if (tag(lhs) === 'dot') {
          return fieldSet(toNode(kids(lhs)[0]), String(leaf(kids(lhs)[1])), toNode(rhs));
        }
        return node('set', { value: toNode(rhs) }, { name: nameOf(lhs) });
      }
      return toNode(inner);
    }    case 'augassign': {
      const [op, lhs, rhs] = kids(x);
      const o = OPS.get(String(leaf(op)).replace('=', '').trim().toLowerCase());
      const name = nameOf(lhs);
      if (o === undefined) throw new Error(`fb->graph: 这个复合赋值还没接：${leaf(op)}`);
      return node('set', {
        value: bin(o, node('ref', {}, { name }), toNode(rhs)),
      }, { name });
    }
    // `dim [mods] (v (n 名字) 类型 (init …))` —— **类型丢掉**（它是端口的 sort）
    case 'dim': case 'static': case 'const': case 'f': {
      const vs = kids(x).filter((y) => tag(y) === 'v');
      return vs.map((v) => {
        const init = part(v, 'init');
        const nm = kids(v)[0];
        const name = nameOf(nm);
        // `(n xs (bounds …))` = 数组声明：登记名字（`xs(0)` 才分得清是取下标还是调用）
        const bounds = isList(nm) ? kids(nm).find((y) => tag(y) === 'bounds') : undefined;
        if (bounds !== undefined) {
          ARRAYS.add(String(name).toLowerCase());   // FB 的名字不分大小写，登记按小写
          const items = init === undefined ? null : kids(init)[0];
          if (items !== undefined && items !== null && tag(items) === 'braces') {
            // `= {10, 20, 30}`：字面量绑在声明上（这就是 list-new 那格账上 FB 欠的那一条）
            return node('bind', { init: listNew(many(kids(items))) }, { name });
          }
          // 没给初值：FB 的数值数组是**零填满**的，`(bounds n)` 的上界含在内（0…n）
          const hi = Number(leaf(kids(kids(bounds)[0])[0]));
          const size = Number.isFinite(hi) ? hi + 1 : 0;
          return node('bind', {
            init: listNew(Array.from({ length: size }, () => lit(0))),
          }, { name });
        }
        // `Dim p As Point`：类型登记过 -> 一格 record-new（数值字段按 FB 的语义零起）
        const ty = kids(v)[1];
        const tyName = ty !== undefined && tag(ty) === 'n' ? String(nameOf(ty)).toLowerCase() : null;
        if (tyName !== null && TYPES.has(tyName) && init === undefined) {
          const fields = TYPES.get(tyName);
          return node('bind', {
            init: node('record-new', { fields: fields.map(() => lit(0)) }, { names: fields }),
          }, { name });
        }
        return node('bind', {
          init: init === undefined ? lit(null) : toNode(kids(init)[0]),
        }, { name });
      });
    }    case 'routine': {
      const head = part(x, 'head');
      const nm = kids(head).find((y) => tag(y) === 'n');
      const name = nm === undefined ? null : leaf(kids(nm)[0]);
      const ps = kids(head).find((y) => tag(y) === 'params');
      const params = ps === undefined ? [] : kids(ps).map((p) => nameOf(kids(p)[0]));
      const body = part(x, 'body');
      return node('bind', {
        init: node('func', { body: body === undefined ? [] : many(kids(body)) }, { params, name }),
      }, { name });
    }
    // `for i as T = a to b … next` —— region + bind + loop + set（`for` 不给节点）
    case 'for': {
      const head = part(x, 'head');
      const body = part(x, 'body');
      const i = nameOf(kids(head)[0]);
      const from = part(head, 'from');
      const to = part(head, 'to');
      const step = part(head, 'step');
      // 与 lua / sbcl 的计数循环同一个形状 —— `counted` 只写一遍（fromtree.js）
      return counted({
        name: i,
        from: toNode(kids(from)[0]),
        cond: bin('<=', node('ref', {}, { name: i }), toNode(kids(to)[0])),
        step: step === undefined ? lit(1) : toNode(kids(step)[0]),
        body: body === undefined ? [] : many(kids(body)),
      });
    }
    case 'while': case 'do': {
      const cond = kids(x).find((y) => tag(y) !== 'body');
      const body = part(x, 'body');
      return node('loop', {
        cond: cond === undefined ? lit(true) : toNode(cond),
        body: body === undefined ? [] : many(kids(body)),
      });
    }
    case 'if': {
      const cond = kids(x)[0];
      const then = part(x, 'body');
      const els = part(x, 'else');
      return branchOf(
        toNode(cond),
        then === undefined ? [] : many(kids(then)),
        els === undefined ? undefined : many(kids(els)),
      );
    }
    case 'return': return retOf(many(kids(x)));
    case 'print': return node('prim', { args: many(kids(x)) }, { name: 'print' });
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      // FB 的转换是**一族有名字的函数**（`CInt` / `CDbl` / `Str`）—— 关键字不分大小写
      const callee = tag(fn) === 'n' ? String(leaf(kids(fn)[0])).toLowerCase() : null;
      if (callee !== null && CONV.has(callee) && argNodes.length === 1) {
        return convOf(CONV.get(callee), argNodes[0]);
      }
      // 数组名登记过 -> 这是**取下标**，不是调用（FB 两者同形，见文件头 ARRAYS 那段）
      if (callee !== null && ARRAYS.has(callee) && argNodes.length === 1) {
        return indexGet(node('ref', {}, { name: nameOf(fn) }), argNodes[0]);
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    // 命令式调用（`f a, b`）：这一批只在"名字 + 实参"这一种形状上接
    case 'command': {
      const [fn, args] = kids(x);
      return node('call', { fn: toNode(fn), args: args === undefined ? [] : many(kids(args)) });
    }
    case 'scope': return node('region', { body: many(kids(part(x, 'body') ?? { kind: 'list', items: [] })) });
    default:
      throw new Error(`fb->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 freebasic 的 GLR 树（`(module 项…)`）-> 一张图。 */
export function fbToGraph(tree) {
  if (tag(tree) !== 'module') throw new Error('fb->graph: 这不是 (module …)');
  ARRAYS.clear();          // 数组名那张表是**一份源码一张**（见上面那段注释）
  TYPES.clear();           // 字段表同理
  return program(kids(tree).map(toNode).flat());
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 自带词序的语句只接 `print`（`line` / `get` / `put` / `draw` 那一大批在图上是
//      `prim` + 外部 IO，量大不难 —— `ext/freebasic/SPEC.md` §3.5）。
//   2. `Type` / `Union` / 属性（`Property Get/Set`）/ `Gosub` 都不在这一批。
//   3. 定宽整数与四种字符串表示丢掉了 —— 它们是**方言必须有"按宽度读写"**那笔账
//      （SPEC §五第 1 项），要用起来是契约 `carry` 那一问的事。
//   4. `CInt` 是**四舍五入**（到偶数），图上 `conv to=int` 是**截断** —— `examples/conv.bas`
//      刻意用 7/3（两家都给 2）绕开那个差。真要对上，得由 FB 的映射自己再套一格 round。
