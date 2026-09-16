// ext/chez/tograph.js —— **Scheme 的 datum 树 -> 节点图**
//
// 这一格是"加一门语言"真正要写的东西：一张对照表，左边是 GLR 出来的树的形状，
// 右边是 `src/core/graph/nodes.js` 那 13 格节点。**一行降级代码都不写** ——
// 降级（消去规则）是往后的事，这一步只做"树的形状 -> 图的节点"。
//
// Scheme 在这一格上最省：它的语法只有 datum 一层（`ext/chez/chez.grammar` 12 条产生式），
// 所以"哪个 datum 是 `if`、哪个是调用"这件事在**这一份**里说，不在语法里说 ——
// 与真 Scheme 一样（`if` / `lambda` / `define` 是特殊形式，属于求值那一层）。

import { node, lit, program } from '../../src/core/graph/graph.js';
import {
  head, kids, text, symName, asList, branchOf, listNew, indexGet, indexSet, sliceOf,
  mapNew, mapGet, mapSet, mapHas,
  fieldGet, fieldSet,
} from '../../src/core/graph/fromtree.js';

// 走 datum 树的那几个小函数（`head` / `kids` / `text` / `symName` / `asList`）
// **与 sbcl 共用一份**（`src/core/graph/fromtree.js`）—— 两门 Lisp 原来各抄一遍，
// 而抄的内容完全相同：叶子有 `atom` 与 `string` 两种 kind 这一条也在那儿写着。

/** 数：`1` / `-2` / `1.5`。这一批只收十进制（`#x1f` 那一族记账，见文件尾）。 */
function numOf(t) {
  const v = Number(t);
  if (Number.isNaN(v)) throw new Error(`chez->graph: 这一批还收不了这个数：${t}`);
  return v;
}

/** 内建名字：Scheme 写法 -> `prim` 那一格的名字（`display` 就是 print）。 */
const PRIM = new Map([
  ['display', 'print'], ['write', 'print'],
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['=', '='],
  ['not', 'not'], ['string-append', 'concat'], ['string-length', 'len'],
]);

/** 一串 datum -> 一串节点（`region` 的 body 端口收的就是它）。 */
const many = (xs) => xs.map(toNode);

/**
 * **`define-record-type` 生成的那一族名字** —— 与 CL 的 `defstruct` 是同一件事，
 * 所以两份映射各有一张这样的表（`ext/sbcl/tograph.js` 里那段注释写了为什么它归映射）。
 *
 * 两种写法都收，因为它们**在同一门语言里都合法**，而且难处不一样：
 *   R6RS（Chez 自带）：`(define-record-type point (fields x y))`
 *     —— 名字是**生成**的：`make-point` / `point-x` / `point-x-set!`；
 *   R7RS：`(define-record-type point (make-point x y) point? (x point-x set-point-x!) …)`
 *     —— 名字**写在形式里**，一个都不用猜（所以这一支更省事，反倒是后来的标准更老实）。
 * 别的选项（`(parent …)` / `(protocol …)` / `(nongenerative)`）不收：它们会换掉这一族名字。
 */
const RECORDS = { fields: new Map(), maker: new Map(), access: new Map(), setter: new Map() };

function defRecord(rest) {
  const name = symName(rest[0]) ?? symName((asList(rest[0]) ?? [])[0]);
  if (name === null) throw new Error('chez->graph: define-record-type 的名字那一格还没接');
  const ctor = asList(rest[1]);
  if (ctor !== null && symName(ctor[0]) !== null && symName(ctor[0]) !== 'fields') {
    // R7RS：`(make-point x y)` 给了构造器名与字段顺序，后面每一条 `(字段 访问器 [写入器])`
    const fields = ctor.slice(1).map((f) => symName(f)).filter((s) => s !== null);
    RECORDS.fields.set(name, fields);
    RECORDS.maker.set(symName(ctor[0]), name);
    for (const cl of rest.slice(3)) {
      const c = asList(cl) ?? [];
      const f = symName(c[0]);
      if (f === null) continue;
      if (symName(c[1]) !== null) RECORDS.access.set(symName(c[1]), f);
      if (symName(c[2]) !== null) RECORDS.setter.set(symName(c[2]), f);
    }
    return node('region', { body: [] });
  }
  // R6RS：`(fields x y)` —— 那一族名字按规则生成
  const fieldsClause = rest.slice(1).map((c) => asList(c) ?? [])
    .find((c) => symName(c[0]) === 'fields') ?? [];
  const fields = fieldsClause.slice(1).map((f) => symName(f) ?? symName((asList(f) ?? [])[1]))
    .filter((s) => s !== null);
  RECORDS.fields.set(name, fields);
  RECORDS.maker.set(`make-${name}`, name);
  for (const f of fields) {
    RECORDS.access.set(`${name}-${f}`, f);
    RECORDS.setter.set(`${name}-${f}-set!`, f);
  }
  return node('region', { body: [] });
}

/** `(make-point 1 2)` -> 一格 `record-new`（构造器的实参按字段顺序，位置对位置）。 */
function makeRecord(type, rest) {
  const fields = RECORDS.fields.get(type) ?? [];
  return node('record-new', {
    fields: fields.map((f, i) => (rest[i] === undefined ? lit(null) : toNode(rest[i]))),
  }, { names: fields });
}

function toNode(x) {
  // ---- 叶子 ----------------------------------------------------------------
  switch (head(x)) {
    case 'num': return node('const', {}, { value: numOf(text(x)) });
    case 'str': return node('const', {}, { value: text(x) });
    case 'bool': return node('const', {}, { value: text(x) === '#t' || text(x) === '#true' });
    case 'sym': return node('ref', {}, { name: text(x) });
    case 'quote': return node('const', {}, { value: `'${text(kids(x)[0]) ?? '?'}'` });
    default: break;
  }

  const items = asList(x);
  if (items === null) throw new Error(`chez->graph: 这一格 datum 还没接：${head(x)}`);
  if (items.length === 0) return node('const', {}, { value: null });

  const op = symName(items[0]);
  const rest = items.slice(1);

  switch (op) {
    // `(define-record-type point (fields x y))` —— 与 CL 的 `defstruct` 同一件事：
    // **一句话生成一族名字**。落到的仍是现成那三格（见 ext/sbcl/tograph.js 那段注释）。
    case 'define-record-type': return defRecord(rest);
    // `(define (f a b) body…)` 与 `(define x e)` —— **decl 就是 bind**（没有 decl 节点）
    case 'define': {
      const target = rest[0];
      const inner = asList(target);
      if (inner !== null) {
        const name = symName(inner[0]);
        const params = inner.slice(1).map((p) => symName(p));
        const body = node('func', { body: many(rest.slice(1)) }, { params, name });
        return node('bind', { init: body }, { name });
      }
      return node('bind', { init: rest[1] === undefined ? lit(null) : toNode(rest[1]) }, { name: symName(target) });
    }
    case 'lambda': {
      const params = (asList(rest[0]) ?? []).map((p) => symName(p));
      return node('func', { body: many(rest.slice(1)) }, { params });
    }
    case 'set!': return node('set', { value: toNode(rest[1]) }, { name: symName(rest[0]) });
    // `if` 的两支是 `lazy` 端口 —— 只算一支，那一栏求值语义就是为它准备的
    case 'if': return branchOf(
      toNode(rest[0]),
      toNode(rest[1]),
      rest[2] === undefined ? undefined : toNode(rest[2]),
    );
    case 'when': return node('branch', { cond: toNode(rest[0]), then: many(rest.slice(1)) });
    case 'unless': return node('branch', {
      cond: node('prim', { args: [toNode(rest[0])] }, { name: 'not' }),
      then: many(rest.slice(1)),
    });
    case 'begin': return node('region', { body: many(rest) });
    // `(let ((x 1) (y 2)) body…)` —— 一格 region + 一串 bind
    case 'let': {
      const binds = (asList(rest[0]) ?? []).map((b) => {
        const pair = asList(b) ?? [];
        return node('bind', { init: pair[1] === undefined ? lit(null) : toNode(pair[1]) }, { name: symName(pair[0]) });
      });
      return node('region', { body: [...binds, ...many(rest.slice(1))] });
    }
    // 没有 `while`：Scheme 的循环是递归。`loop` 那一格留给 lua / go / freebasic 用。
    // 向量那三样**不是调用**：它们落 `list-new` / `index-get` / `index-set`
    //（与 `display` 落 `prim print` 同一条 —— 写成什么样是语法的事）。
    case 'vector': return listNew(many(rest));
    // 哈希表那四样也**不是调用**：落 map 那四格（R6RS 的写法与别人差得最远 ——
    // 别的门是下标语法或方法，这门是四个函数名，落到的却是同一批节点）。
    // 明说一格：`hashtable-ref` 的**第三个实参是默认值**，图上没有那一格 ——
    // 图的规矩是"缺键就是错误"，所以那个默认值丢掉（例子里不缺键）。
    case 'make-eqv-hashtable': case 'make-eq-hashtable':
    case 'make-equal-hashtable': case 'make-hashtable': return mapNew();
    case 'hashtable-ref': return mapGet(toNode(rest[0]), toNode(rest[1]));
    case 'hashtable-set!': return mapSet(toNode(rest[0]), toNode(rest[1]), toNode(rest[2]));
    case 'hashtable-contains?': return mapHas(toNode(rest[0]), toNode(rest[1]));
    case 'vector-ref': return indexGet(toNode(rest[0]), toNode(rest[1]));
    case 'vector-set!': return indexSet(toNode(rest[0]), toNode(rest[1]), toNode(rest[2]));
    // `(vector-copy v 1 3)` -> slice。R6RS/R7RS 的规矩与图上一样（**上界不含、0 起**），
    // 所以这一门一格都不用调（nim 那门的 `..` 是"含"，要 +1）。少写上界 = 到末尾。
    case 'vector-copy': case 'subvector': return sliceOf(
      toNode(rest[0]),
      rest[1] === undefined ? undefined : toNode(rest[1]),
      rest[2] === undefined ? undefined : toNode(rest[2]),
    );
    case 'newline': return node('prim', { args: [lit('')] }, { name: 'print' });
    default: break;
  }

  // 内建（`display` / `+` / …）；别的都是普通调用
  if (op !== null && PRIM.has(op)) {
    return node('prim', { args: many(rest) }, { name: PRIM.get(op) });
  }
  // `define-record-type` 生成的那三族名字：构造器 / 访问器 / 写入器
  if (op !== null && RECORDS.maker.has(op)) return makeRecord(RECORDS.maker.get(op), rest);
  if (op !== null && RECORDS.access.has(op)) return fieldGet(toNode(rest[0]), RECORDS.access.get(op));
  if (op !== null && RECORDS.setter.has(op)) {
    return fieldSet(toNode(rest[0]), RECORDS.setter.get(op), toNode(rest[1]));
  }
  return node('call', { fn: toNode(items[0]), args: many(rest) });
}

/**
 * 一棵 chez 的 GLR 树（`(program datum…)`）-> 一张图。
 * 收不下的形状**当场报**（不猜、不静默）—— 与语法那一侧同一条纪律。
 */
export function chezToGraph(tree) {
  if (head(tree) !== 'program') throw new Error('chez->graph: 这不是 (program …)');
  // `define-record-type` 那张登记表是**一份源码一张**（不清的话第二份会看见第一份的字段名）
  RECORDS.fields.clear();
  RECORDS.maker.clear();
  RECORDS.access.clear();
  RECORDS.setter.clear();
  return program(many(kids(tree)));
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 只收十进制的数：`#x1f` / `1/2` / `+inf.0` 那一族记号切得对，但**值**这一层
//      要 `number-tower` 那格能力的提供者（`ext/chez/SPEC.md` §六第 5 条）。
//   2. `quote` 只当一格常量文本收（真的 datum 值要 `graph-literal` 那一格）。
//   3. 宏（`syntax-rules`）没接 —— 它是 `stage`，排在这一批之后（SPEC §五第 7 项）。
//   4. `call/cc` 没接：它落在 `suspends` 那台续延机器上，与 go 的 channel 一起做。
