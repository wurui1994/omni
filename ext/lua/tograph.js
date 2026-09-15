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
import { counted, destructure, ops } from '../../src/core/graph/fromtree.js';

const isList = (x) => x !== null && x !== undefined && x.kind === 'list';
const tag = (x) => (isList(x) && x.items[0]?.kind === 'atom' ? x.items[0].value : null);
const kids = (x) => (isList(x) ? x.items.slice(1) : []);
/**
 * 一格叶子的值。叶子有两种 kind：`atom`（记号文本）与 `string`（已经解过转义的串值，
 * 语法动作里写的 `"+"` 这种字面量也是它）—— 只认 `atom` 的话 `(bin "+" …)` 里那个算符
 * 就成了 null。这一条踩过一次，记在这儿。
 */
const leaf = (x) => (x === null || x === undefined || x.kind === 'list' ? null : x.value);
const atomText = leaf;
const raw = (v) => v;

const PRIM = new Map([
  ['print', 'print'], ['tostring', 'concat'], ['#', 'len'],
]);
const OPS = ops({ '^': '^', '~=': '!=', '..': 'concat', and: 'and', or: 'or' });

const many = (xs) => xs.map(toNode);

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
    case 'num': return node('const', {}, { value: Number(raw(atomText(kids(x)[0]))) });
    case 'str': return node('const', {}, { value: raw(atomText(kids(x)[0])) });
    case 'nil': return node('const', {}, { value: null });
    case 'true': return node('const', {}, { value: true });
    case 'false': return node('const', {}, { value: false });
    case 'name': return node('ref', {}, { name: atomText(kids(x)[0]) });
    case 'paren': return toNode(kids(x)[0]);

    // ---- 算子 --------------------------------------------------------------
    case 'bin': {
      const [opTok, a, b] = kids(x);
      const op = OPS.get(raw(atomText(opTok)));
      if (op === undefined) throw new Error(`lua->graph: 这个算子还没接：${atomText(opTok)}`);
      // `and` / `or` 交出来的是**值**不是真假（lua 那份规格 L-007）：第二个操作数是 lazy，
      // 所以它走 `branch` 而不是 `binop` —— 这一格正是"入端口求值语义"的用处。
      if (op === 'and') return lazyAnd(toNode(a), toNode(b), { keepValue: true });
      if (op === 'or') return lazyOr(toNode(a), toNode(b), { keepValue: true });
      return bin(op, toNode(a), toNode(b));
    }
    case 'un': {
      const [opTok, a] = kids(x);
      return un(raw(atomText(opTok)) === 'not' ? 'not' : raw(atomText(opTok)), toNode(a));
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
      return targets.map((t, i) => node('set', {
        value: values[i] === undefined ? lit(null) : toNode(values[i]),
      }, { name: nameOf(t) }));
    }
    case 'if': {
      const [cond, blk, elifs, els] = kids(x);
      const elifList = elifs === undefined ? [] : kids(elifs);
      // `elseif` 链从后往前折成嵌套的 branch —— 不给它开节点（它是 branch 的一格附属）
      let tail = els === undefined ? undefined : node('region', { body: many(kids(kids(els)[0])) });
      for (let i = elifList.length - 1; i >= 0; i--) {
        const [c, b] = kids(elifList[i]);
        tail = node('branch', {
          cond: toNode(c),
          then: node('region', { body: many(kids(b)) }),
          ...(tail === undefined ? {} : { else: tail }),
        });
      }
      return node('branch', {
        cond: toNode(cond),
        then: node('region', { body: many(kids(blk)) }),
        ...(tail === undefined ? {} : { else: tail }),
      });
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
    case 'return': {
      const vals = kids(x);
      if (vals.length === 0) return node('ret', {});
      // `return a, b` —— 多值的生产侧（**多出端口是常态**，ADR-0033 §3.2）
      const v = vals.length === 1 ? toNode(vals[0]) : node('values', { args: many(vals) });
      return node('ret', { value: v });
    }
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
//   1. 表（table）、metatable、多返回值、`...`、`goto` 都不在这一批 ——
//      `ext/lua/SPEC.md` §五那张顺序表说了它们各自排在哪一步。
//   2. 全局名字当普通名字收（真语义是 `_ENV` 表查）。
//   3. `for … in`（迭代器三件套）没接：它要 `indirect-call` + 协议，排在 `loop` 之后。
