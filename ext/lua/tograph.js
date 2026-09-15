// ext/lua/tograph.js —— **Lua 的树 -> 节点图**（同一张 13 格节点清单，第二个前端）
//
// 与 `ext/chez/tograph.js` 对着看才是这一步的意义：两门语言的**树完全不一样**
// （Scheme 只有 datum，Lua 有 104 条产生式的具体语法），落到的**节点是同一批**。
// 这就是"加一门语言 = 一份语法 + 一张对照表"那句话第一次有了可跑的证据。
//
// Lua 独有的几格在这一批里怎么记（不猜、不硬凑）：
//   * `local x = 1` 与 `x = 1` 都落 `bind` / `set` —— 全局那一格是 `_ENV` 表查
//     （`ext/lua/SPEC.md` §六第 6 条），这一批当普通名字收，记账。
//   * `..`（连接）落 `prim concat`；`#`、metatable、多返回值都不在这一批。
//   * 真值观：Lua 是"只有 nil / false 为假"，与 eval 里那格保守答案**恰好一致**，
//     所以这一批不用套 `prim` 转一层（awk / cpp 那两家要转，见 eval.js 里那段注释）。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf,
  counted, ops, binOf, retOf, branchOf,
  destructure, recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet,
} from '../../src/core/graph/fromtree.js';

// 走树的那几个小函数（`isList` / `tag` / `kids` / `leaf`）**与另外八门共用一份**
// （`src/core/graph/fromtree.js`）—— 叶子有 `atom` 与 `string` 两种 kind 这一条
// 也写在那儿（只认 `atom` 的话 `(bin "+" …)` 里那个算符就成了 null，踩过一次）。
const atomText = leaf;

const PRIM = new Map([
  ['print', 'print'], ['tostring', 'concat'], ['#', 'len'],
]);
const OPS = ops({ '^': '^', '~=': '!=', '..': 'concat', and: 'and', or: 'or' });

const many = (xs) => xs.map(toNode);

/**
 * **1 起 -> 0 起**：lua 的下标从 1 开始，图上的 `index-get` 一律从 0 开始。
 * 字面量当场减（`xs[1]` 出的是 `(lit 0)`，图上看不见多余的算符），别的减一格算符。
 */
const zeroBased = (t) => (tag(t) === 'num'
  ? lit(Number(atomText(kids(t)[0])) - 1)
  : bin('-', toNode(t), lit(1)));

/** 一格 `(names …)` / `(values …)` / `(args …)` 里的孩子。 */
const partOf = (x, name) => {
  const found = kids(x).find((y) => tag(y) === name);
  return found === undefined ? [] : kids(found);
};

function nameOf(x) {
  if (x === null || x === undefined) return null;
  if (x.kind === 'atom') return x.value;
  if (tag(x) === 'att') return atomText(kids(x)[0]);      // `local x <const>`：属性是附属
  if (tag(x) === 'name') return atomText(kids(x)[0]);
  return null;
}

function funcOf(bodyNode, name) {
  const params = partOf(bodyNode, 'params').map(nameOf);
  const blk = kids(bodyNode).find((y) => tag(y) === 'block');
  return node('func', { body: blk === undefined ? [] : many(kids(blk)) }, { params, name });
}

function toNode(x) {
  switch (tag(x)) {
    // ---- 叶子 --------------------------------------------------------------
    case 'num': return node('const', {}, { value: Number(atomText(kids(x)[0])) });
    case 'str': return node('const', {}, { value: atomText(kids(x)[0]) });
    case 'nil': return node('const', {}, { value: null });
    case 'true': return node('const', {}, { value: true });
    case 'false': return node('const', {}, { value: false });
    case 'name': return node('ref', {}, { name: atomText(kids(x)[0]) });
    case 'paren': return toNode(kids(x)[0]);
    // `p.x` -> field-get（与 go/V 的 `(sel …)`、nim 的 `(dot …)` 同一格节点）
    case 'dot': return fieldGet(toNode(kids(x)[0]), atomText(kids(x)[1]));
    // `{ x = 1, y = 2 }` -> record-new。**lua 的表没有类型**，落的却是同一格 ——
    // 这正是"record 不要求任何类型存在"那句话的证据（附录 A）。
    // `{ 10, 20, 30 }`（数组部分）-> list-new：同一条产生式，两种字面量。
    case 'table': {
      const items = kids(x);
      if (items.length > 0 && items.every((e) => tag(e) === 'named')) {
        return recordNew(items.map((e) => {
          const [k, v] = kids(e);
          return [atomText(k), toNode(v)];
        }));
      }
      if (items.some((e) => tag(e) !== 'item')) {
        throw new Error('lua->graph: 这一批不接"名字与位置混着"的表');
      }
      return listNew(items.map((e) => toNode(kids(e)[0])));
    }
    // `xs[i]` -> index-get。**lua 从 1 起，图上从 0 起** —— 差的那一格在这儿减掉
    // （字面量当场算，别的减一格算符；语言的答案由语言的映射给，与真值观同一条）。
    case 'index': return indexGet(toNode(kids(x)[0]), zeroBased(kids(x)[1]));

    // ---- 算子 --------------------------------------------------------------
    case 'bin': {
      const [opTok, a, b] = kids(x);
      // `and` / `or` 交出来的是**值**不是真假（lua 那份规格 L-007）：第二个操作数是 lazy，
      // 所以它走 `branch` 而不是算符 —— 这一格正是"入端口求值语义"的用处。
      return binOf(atomText(opTok), toNode(a), toNode(b), OPS, {
        lang: 'lua', and: ['and'], or: ['or'], keepValue: true,
      });
    }
    case 'un': {
      const [opTok, a] = kids(x);
      return un(atomText(opTok) === 'not' ? 'not' : atomText(opTok), toNode(a));
    }

    // ---- 语句 --------------------------------------------------------------
    case 'block': return node('region', { body: many(kids(x)) });
    case 'do': return node('region', { body: many(kids(kids(x)[0])) });
    case 'local': {
      const names = partOf(x, 'names').map(nameOf);
      const values = partOf(x, 'values');
      // `local a, b = f()`：N 个名字对 1 个右值 ⇒ 多值的消费侧（`destructure` 五门共用）
      if (names.length > 1 && values.length === 1) return destructure(names, toNode(values[0]));
      return names.map((nm, i) => node('bind', {
        init: values[i] === undefined ? lit(null) : toNode(values[i]),
      }, { name: nm }));
    }
    case 'localfn': case 'globalfn': {
      const [nm, body] = kids(x);
      return node('bind', { init: funcOf(body, atomText(nm)) }, { name: atomText(nm) });
    }
    case 'fndef': {
      const [nm, body] = kids(x);
      const name = nameOf(nm) ?? atomText(nm);
      return node('bind', { init: funcOf(body, name) }, { name });
    }
    case 'fn': return funcOf(kids(x)[0]);
    case 'assign': {
      const targets = partOf(x, 'targets');
      const values = partOf(x, 'values');
      return targets.map((t, i) => {
        const v = values[i] === undefined ? lit(null) : toNode(values[i]);
        // 左边是一格字段（`p.y = 5`）或一格下标（`xs[2] = 5`）⇒ field-set / index-set
        if (tag(t) === 'dot') return fieldSet(toNode(kids(t)[0]), atomText(kids(t)[1]), v);
        if (tag(t) === 'index') return indexSet(toNode(kids(t)[0]), zeroBased(kids(t)[1]), v);
        return node('set', { value: v }, { name: nameOf(t) });
      });
    }
    case 'if': {
      const [cond, blk, elifs, els] = kids(x);
      const elifList = elifs === undefined ? [] : kids(elifs);
      // `elseif` 链从后往前折成嵌套的 branch —— 不给它开节点（它是 branch 的一格附属）
      let tail = els === undefined ? undefined : node('region', { body: many(kids(kids(els)[0])) });
      for (let i = elifList.length - 1; i >= 0; i--) {
        const [c, b] = kids(elifList[i]);
        tail = branchOf(toNode(c), node('region', { body: many(kids(b)) }), tail);
      }
      return branchOf(toNode(cond), node('region', { body: many(kids(blk)) }), tail);
    }
    case 'while': {
      const [cond, blk] = kids(x);
      return node('loop', { cond: toNode(cond), body: many(kids(blk)) });
    }
    case 'fornum': case 'fornum-step': {
      // `for i = a, b do … end` —— 落成 bind + loop + set（**不给它开节点**：
      // 它是"一格 region + 一格 loop"的形状，go 的 OFOR / freebasic 的 For 同理）
      const [nm, from, to, ...restKids] = kids(x);
      const step = tag(x) === 'fornum-step' ? restKids[0] : null;
      const blk = restKids[restKids.length - 1];
      const i = atomText(nm);
      // 六门语言的计数循环是同一个形状 —— `counted` 只写一遍（fromtree.js）
      return counted({
        name: i,
        from: toNode(from),
        cond: bin('<=', node('ref', {}, { name: i }), toNode(to)),
        step: step === null ? lit(1) : toNode(step),
        body: many(kids(blk)),
      });
    }
    // `return a, b` —— 多值的生产侧（**多出端口是常态**，ADR-0033 §3.2）
    case 'return': return retOf(many(kids(x)));
    case 'call': {
      const [fn, args] = kids(x);
      const callee = tag(fn) === 'name' ? atomText(kids(fn)[0]) : null;
      const argNodes = args === undefined ? [] : many(kids(args));
      if (callee !== null && PRIM.has(callee)) {
        return node('prim', { args: argNodes }, { name: PRIM.get(callee) });
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    default:
      throw new Error(`lua->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 lua 的 GLR 树（`(block stat…)`）-> 一张图。 */
export function luaToGraph(tree) {
  if (tag(tree) !== 'block') throw new Error('lua->graph: 这不是 (block …)');
  return program(many(kids(tree)).flat());
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 表接两种：`{ k = v }` 落 record-new、`{ 1, 2 }` 落 list-new（混着的当场报）。
//      metatable、`...`、`goto` 都不在这一批；`t[k]`（键是任意值）也不在 ——
//      那是 map 那一格，`index-get` 只管列表（go 的 map 读可能 allocates，效应不同）。
//   2. 全局名字当普通名字收（真语义是 `_ENV` 表查）。
//   3. `for … in`（迭代器三件套）没接：它要 `indirect-call` + 协议，排在 `loop` 之后。
