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
  counted, ops, binOf, retOf, branchOf, loopExit,
  destructure, recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet,
  mapNew, mapGet, mapSet, mapHas, mapNames,
} from '../../src/core/graph/fromtree.js';

/**
 * 装 map 的那些名字。**lua 的 table 既是数组又是字典**，所以这门语言的判据只能是
 * "它被怎么用过"：**用串当过键**（`t["a"]`）就算 map，只用数当键就是列表。
 *
 * 这一条比 go / V 那种"字面量自带标记"弱，弱在哪儿写清楚：键是变量（`t[k]`）判不了，
 * 混着用（既 `t[1]` 又 `t["a"]`）也判不了 —— 碰上就报错，不猜（见文件末尾的不足）。
 */
const MAPS = new Set();
const mapUseName = (x) => (isList(x) && tag(x) === 'index' && tag(kids(x)[1]) === 'str'
  ? nameOf(kids(x)[0]) : null);
const isMap = (x) => tag(x) === 'name' && MAPS.has(nameOf(x));

/**
 * 一格绑定的右值。名字被当字典用过、右值又是个**空表**时出 `map-new` ——
 * 非空的表混着当字典用判不了（`{1,2}` 到底是列表还是"1、2 两个键"），报错不猜。
 */
function initFor(nm, v) {
  if (!MAPS.has(nm) || tag(v) !== 'table') return toNode(v);
  if (kids(v).length !== 0) {
    throw new Error(`lua->graph: ${nm} 被当字典用过，可它的初值是个非空的表 —— 这一批判不了`);
  }
  return mapNew();
}

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

/**
 * `(body (params …) (block …))` -> 一格 `func`。
 *
 * `name` 这一格**没有就不给**（而不是给一个 `undefined`）：匿名函数在 lua 里是
 * `local f = function(x) … end`，在 gsl-shell 里是 `|x| …`，两处都没有名字。
 * chez / sbcl 的 `lambda` 早就是这么写的（`{ params }`，不带 name）—— 这儿跟上。
 * 给 `undefined` 的代价是量出来的：那一格会被 `toSx` 印成字面的 `undefined`，
 * 读回来当场报"这一格附属的值不是 JSON"（`gsl-shell × sx` 那一格就是这么红的）。
 */
function funcOf(bodyNode, name) {
  const params = partOf(bodyNode, 'params').map(nameOf);
  const blk = kids(bodyNode).find((y) => tag(y) === 'block');
  const attrs = name === null || name === undefined ? { params } : { params, name };
  return node('func', { body: blk === undefined ? [] : many(kids(blk)) }, attrs);
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
    // `t["a"]` -> map-get（键是串）；`xs[i]` -> index-get。**lua 从 1 起，图上从 0 起** ——
    // 差的那一格只在列表那一侧减（map 的键是值，没有"起点"这回事）
    case 'index': {
      const [o, k] = kids(x);
      return isMap(o) ? mapGet(toNode(o), toNode(k)) : indexGet(toNode(o), zeroBased(k));
    }

    // ---- 算子 --------------------------------------------------------------
    case 'bin': {
      const [opTok, a, b] = kids(x);
      // **`t[k] ~= nil` 是 lua 问"在不在"的写法** —— 而图上缺键是错误（`map-get` 会报），
      // 所以这个形状认成一格 `map-has`。这是**一处窥孔**，只认字面上的 `~= nil`：
      // lua 的"缺键给 nil"那条语义与"缺键报错"那条对不上，账记在文件末尾。
      if (atomText(opTok) === '~=' && (tag(a) === 'nil' || tag(b) === 'nil')) {
        const other = tag(a) === 'nil' ? b : a;
        if (tag(other) === 'index' && isMap(kids(other)[0])) {
          return mapHas(toNode(kids(other)[0]), toNode(kids(other)[1]));
        }
      }
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
        // **被当字典用过的名字**：`local m = {}` 出的是 map-new 而不是 list-new
        // （table 那一格自己看不出来是哪种 —— 判据在"它被怎么用过"，见 MAPS）
        init: values[i] === undefined ? lit(null) : initFor(nm, values[i]),
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
        if (tag(t) === 'index') {
          const [o, k] = kids(t);
          return isMap(o) ? mapSet(toNode(o), toNode(k), v) : indexSet(toNode(o), zeroBased(k), v);
        }
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
    // `break` -> loop-exit（lua 没有 continue —— 它的 continue 是 goto）
    case 'break': return loopExit('break');
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
  // 先扫一遍"哪些名字用串当过键" —— lua 的 table 既是数组又是字典，这是这门语言
  // 唯一分得开的判据（go / V 靠字面量自带标记，awk 里全是关联数组）
  MAPS.clear();
  for (const nm of mapNames(tree, mapUseName)) if (nm !== null) MAPS.add(nm);
  return program(many(kids(tree)).flat());
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 表接三种：`{ k = v }` 落 record-new、`{ 1, 2 }` 落 list-new、
//      **被串当键用过的名字**落 map（`local m = {}` + `m["a"]`，见 MAPS）。混着的当场报。
//      metatable、`...`、`goto` 都不在这一批。
//   2. **map 那两条判不了的形状**（都报错，不猜）：键是变量（`t[k]` —— 那要真的类型）、
//      同一个名字既 `t[1]` 又 `t["a"]`（lua 里合法，图上是两格节点）。
//   3. **`t[k] ~= nil` 是一处窥孔**：lua 用它问"在不在"，而图上缺键是错误 ——
//      所以这个形状认成 `map-has`。只认字面上的 `~= nil`；写成 `if m[k] then` 判不了
//      （值是 false 时两条语义分不开），碰上会落 map-get 然后在缺键上报错。
//   4. 全局名字当普通名字收（真语义是 `_ENV` 表查）。
//   5. `for … in`（迭代器三件套）没接：它要 `indirect-call` + 协议，排在 `loop` 之后。
