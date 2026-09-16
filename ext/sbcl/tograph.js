// ext/sbcl/tograph.js —— **Common Lisp 的 datum 树 -> 节点图**（第四个前端）
//
// 与 `ext/chez/tograph.js` 只差一张词汇表（`defun` vs `define`、`setq` vs `set!`、
// `princ` vs `display`）—— 这正是"两门语言共用同一批节点"最便宜的一份证据：
// 树的形状一样、词汇不同，落到的节点完全相同。
//
// CL 独有的两格在这一批里怎么记：
//   * `(defun f (a b) …)` 的形参表可以带 `&optional` / `&rest` —— 元数分派是
//     `callable` 的一格**附属**（chez 那份规格 §3.2 第 2 条），这一批只收定长。
//   * 多值（`values`）、条件系统、CLOS 都不在这一批（`ext/sbcl/SPEC.md` §五那张顺序表）。

import {
  node, lit, program, bin,
} from '../../src/core/graph/graph.js';
import {
  head, kids, text, symName, asList, counted, branchOf, listNew, indexGet, indexSet, sliceOf, destructure,
  mapNew, mapGet, mapSet, mapHas,
  fieldGet, fieldSet,
} from '../../src/core/graph/fromtree.js';

// 走 datum 树的那几个小函数与 chez **共用一份**（fromtree.js）—— 见那边的注释。

/** CL 的内建 -> `prim` 那一格。`princ` / `print` / `write` 都是打印。 */
const PRIM = new Map([
  ['princ', 'print'], ['print', 'print'], ['write', 'print'], ['write-line', 'print'],
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['=', '='], ['eql', '='], ['equal', '='],
  ['not', 'not'], ['null', 'not'], ['concatenate', 'concat'], ['length', 'len'],
]);

const many = (xs) => xs.map(toNode);

/**
 * **`defstruct` 生成的那一族名字**（`(defstruct point x y)` → `make-point` / `point-x` / …）。
 *
 * 这是 CL 与 Scheme 在记录那一格上的**全部难处**：字段名不写在使用处，而是"一句话生成
 * 一族名字"。可落到图上仍然只有现成的三格（`record-new` / `field-get` / `field-set`）——
 * 所以这一格**归映射**，不是新节点，也不要类型层（`nodes.js` 里 record 那三格头一句就是
 * "与类型无关"）。表在这儿：扫到 `defstruct` 就登记，用到那些名字时查。
 *
 * 只收最朴素的写法（`(defstruct 名字 字段…)`，字段可带默认值 `(x 0)`）：
 * `(:constructor …)` / `:include` / `:conc-name` 那几个选项**不收** —— 它们会换掉生成的
 * 名字，而"名字怎么生成"正是这一格的要害，猜不得。撞上就当普通调用（于是报 unbound name）。
 */
const STRUCTS = { fields: new Map(), maker: new Map(), access: new Map() };

/** `(defstruct point x y)` -> 登记那一族名字。回一格空 region（声明这一批没有运行期动作）。 */
function defstruct(rest) {
  const name = symName(rest[0]);
  if (name === null) throw new Error('sbcl->graph: defstruct 的名字那一格还没接（不收 (:constructor …) 那些选项）');
  const fields = rest.slice(1).map((f) => {
    const s = symName(f);
    if (s !== null) return s;
    const pair = asList(f) ?? [];        // `(x 0)`：带默认值的字段，名字仍是第一格
    return symName(pair[0]);
  }).filter((s) => s !== null);
  STRUCTS.fields.set(name, fields);
  STRUCTS.maker.set(`make-${name}`, name);
  for (const f of fields) STRUCTS.access.set(`${name}-${f}`, f);
  return node('region', { body: [] });
}

/** `(make-point :x 1 :y 2)` -> 一格 `record-new`（字段顺序按 `defstruct` 那一行，没给的是 nil）。 */
function makeRecord(type, rest) {
  const fields = STRUCTS.fields.get(type) ?? [];
  const given = new Map();
  for (let i = 0; i < rest.length - 1; i += 2) {
    const k = symName(rest[i]);
    if (k === null || !k.startsWith(':')) throw new Error(`sbcl->graph: make-${type} 只收关键字实参（:x 1）`);
    given.set(k.slice(1), toNode(rest[i + 1]));
  }
  return node('record-new', { fields: fields.map((f) => given.get(f) ?? lit(null)) }, { names: fields });
}

function toNode(x) {
  switch (head(x)) {
    case 'num': return node('const', {}, { value: Number(text(x)) });
    case 'str': return node('const', {}, { value: text(x) });
    case 'sym': {
      const n = text(x);
      if (n === 't') return node('const', {}, { value: true });
      if (n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'quote': return node('const', {}, { value: `'${text(kids(x)[0]) ?? '?'}'` });
    default: break;
  }

  const items = asList(x);
  if (items === null) throw new Error(`sbcl->graph: 这一格 datum 还没接：${head(x)}`);
  if (items.length === 0) return node('const', {}, { value: null });

  const op = symName(items[0]);
  const rest = items.slice(1);

  switch (op) {
    case 'defun': {
      const name = symName(rest[0]);
      const params = (asList(rest[1]) ?? []).map((p) => symName(p));
      return node('bind', { init: node('func', { body: many(rest.slice(2)) }, { params, name }) }, { name });
    }
    case 'lambda': {
      const params = (asList(rest[0]) ?? []).map((p) => symName(p));
      return node('func', { body: many(rest.slice(1)) }, { params });
    }
    case 'setq': case 'setf': {
      // **`setf` 的左边可以是一格形式**（广义位置）：`(setf (aref xs 1) 5)` -> index-set，
      // `(setf (point-y p) 5)` -> field-set（那个名字是 `defstruct` 生成的，查登记表）。
      // 这一格是 CL 独有的形状，落到的却是别人也有的那几格节点（go 的 `xs[1] = 5` / `p.y = 5`）。
      const inner = asList(rest[0]);
      if (inner !== null) {
        const place = symName(inner[0]);
        if (place === 'aref' || place === 'svref' || place === 'elt') {
          return indexSet(toNode(inner[1]), toNode(inner[2]), toNode(rest[1]));
        }
        // `(setf (gethash k m) v)` -> map-set。**CL 的键在前、表在后**（与别的门反着），
        // 那只是记号的顺序 —— 落的是同一格节点。
        if (place === 'gethash') {
          return mapSet(toNode(inner[2]), toNode(inner[1]), toNode(rest[1]));
        }
        if (place !== null && STRUCTS.access.has(place)) {
          return fieldSet(toNode(inner[1]), STRUCTS.access.get(place), toNode(rest[1]));
        }
        throw new Error(`sbcl->graph: 这个 setf 位置还没接：${place}`);
      }
      return node('set', { value: toNode(rest[1]) }, { name: symName(rest[0]) });
    }
    // `(defstruct point x y)` —— 一句话生成一族名字（构造器 / 访问器），见上面那段注释
    case 'defstruct': return defstruct(rest);
    case 'defparameter': case 'defvar': case 'defconstant':
      return node('bind', { init: rest[1] === undefined ? lit(null) : toNode(rest[1]) }, { name: symName(rest[0]) });
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
    case 'progn': return node('region', { body: many(rest) });
    // 多值：CL 是**四门语言里唯一有专门形式的**（`values` / `multiple-value-bind`）——
    // go / lua 靠 `return a, b`、nim 靠元组，落到的是同一对节点（values / 一串 pick）
    case 'values': return node('values', { args: many(rest) });
    case 'multiple-value-bind': {
      const names = (asList(rest[0]) ?? []).map((p) => symName(p));
      return node('region', {
        body: [...destructure(names, toNode(rest[1])), ...many(rest.slice(2))],
      });
    }
    // `(unwind-protect body cleanup…)` —— 与 go 的 defer **同一格节点**：
    // 一格 region 装着"先注册清理、再跑 body"。CL 那七种 cleanup 都是这个形状。
    case 'unwind-protect': return node('region', {
      body: [
        node('scope-exit', { action: many(rest.slice(1)) }),
        ...many(rest.slice(0, 1)),
      ],
    });
    case 'let': case 'let*': {
      const binds = (asList(rest[0]) ?? []).map((b) => {
        const pair = asList(b) ?? [];
        return node('bind', { init: pair[1] === undefined ? lit(null) : toNode(pair[1]) }, { name: symName(pair[0]) });
      });
      return node('region', { body: [...binds, ...many(rest.slice(1))] });
    }
    // `(dotimes (i n) …)` —— CL 的计数循环。落成 region + loop + set（不给它开节点）
    case 'dotimes': {
      const spec = asList(rest[0]) ?? [];
      const i = symName(spec[0]);
      // 与 lua / freebasic 的计数循环同一个形状 —— `counted` 只写一遍（fromtree.js）
      return counted({
        name: i,
        from: lit(0),
        cond: bin('<', node('ref', {}, { name: i }), toNode(spec[1])),
        body: many(rest.slice(1)),
      });
    }
    case 'terpri': return node('prim', { args: [lit('')] }, { name: 'print' });
    // 向量那两样**不是调用**：落 `list-new` / `index-get`（写成什么样是语法的事）
    case 'vector': return listNew(many(rest));
    case 'aref': case 'svref': case 'elt': return indexGet(toNode(rest[0]), toNode(rest[1]));
    // `(subseq v 1 3)` -> slice（**上界不含、0 起** —— CL 这一条与图上一样，不用调）。
    // 少写上界（`(subseq v 1)`）就是"到末尾"，那格端口空着。
    case 'subseq': return sliceOf(
      toNode(rest[0]),
      rest[1] === undefined ? undefined : toNode(rest[1]),
      rest[2] === undefined ? undefined : toNode(rest[2]),
    );
    // 哈希表那几样也**不是调用**：落 map 那四格。CL 的记号有两处与别人不同 ——
    // 键写在表前面（`(gethash k m)`），而"在不在"是 `gethash` 的**第二格返回值**
    // （`(nth-value 1 …)`）。两处都只是记号：落到的是同一批节点。
    case 'make-hash-table': return mapNew();
    case 'gethash': return mapGet(toNode(rest[1]), toNode(rest[0]));
    case 'nth-value': {
      const inner = asList(rest[1]);
      const k = rest[0] === undefined ? null : Number(text(rest[0]));
      if (k === 1 && inner !== null && symName(inner[0]) === 'gethash') {
        return mapHas(toNode(inner[2]), toNode(inner[1]));
      }
      throw new Error('sbcl->graph: 这一批只接 `(nth-value 1 (gethash …))` 那一种多值取用'
        + '（别的要多值那一侧的 pick 一起接）');
    }
    default: break;
  }

  if (op !== null && PRIM.has(op)) return node('prim', { args: many(rest) }, { name: PRIM.get(op) });
  // `defstruct` 生成的那两族名字：构造器落 record-new、访问器落 field-get
  if (op !== null && STRUCTS.maker.has(op)) return makeRecord(STRUCTS.maker.get(op), rest);
  if (op !== null && STRUCTS.access.has(op)) return fieldGet(toNode(rest[0]), STRUCTS.access.get(op));
  return node('call', { fn: toNode(items[0]), args: many(rest) });
}

/** 一棵 sbcl 的 GLR 树（`(program datum…)`）-> 一张图。 */
export function sbclToGraph(tree) {
  if (head(tree) !== 'program') throw new Error('sbcl->graph: 这不是 (program …)');
  // 那张 `defstruct` 登记表是**一份源码一张**（模块层的 Map 在这儿清掉）——
  // 不清的话第二份源码会看见第一份的字段名，那是"跨文件漏进来"的错。
  STRUCTS.fields.clear();
  STRUCTS.maker.clear();
  STRUCTS.access.clear();
  return program(many(kids(tree)));
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. `&optional` / `&rest` / 关键字形参不收（元数分派是 callable 的附属）。
//   2. `format` 那一族没接（它是一格运行期解释的格式串 —— 与 printf 同一笔账）。
//   3. 多值、条件系统（`handler-bind` / restart）、CLOS 都不在这一批。
