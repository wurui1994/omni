// ext/python/adapter/dyn.js —— **推不出来就退到 dyn**（不是报错要标注）
//
// 这一份纠的是这一门原先的一个错结论：「方言是静态类型，所以 python 里推不出类型的地方
// 必须当场报」。**推得出来最好，推不出来也没关系** —— 方言那一侧早就有真动态那一族
// （`(dyn E)` 装箱、`(dtag E)` 问标签、`(as* E)` 带检查拆箱，钉在
// `tests/sexpr/cases/48-dyn.sx`，四条腿已通），C 侧是 `omni_dyn` 那个带标签的 24 字节胖值。
// 更直接的反证：**JS 整门语言跑的就是这条道**（ADR-0011 决策 1：「JS 的每个值都是
// `dynamic`，不给 JS 做类型推断」），而 js→C 是自举主干 —— 动态性比 python 还强的东西
// 早就编到 C 了。所以「类型必须确定」从来不是这台机器的约束。
//
// 口径按 ADR-0008：**异质 ⇒ 统一降为 dynamic**，一条规则，不做联合类型。
//
// ## 这条道上真正的边界（不是类型，是算子）
//
//   1. **装得进箱子的只有六档**：int / real / bool / string / 函数 / `(dict string dyn)`
//      （`src/core/sexpr/lower.js` 的 `DYN_BOXABLE`）。`(arr T)` 装不进 ——
//      所以"异质的表"落成 `(arr dyn)`（表本身是静态的，元素是动态的），不是"把表装进箱子"。
//   2. **dyn 上没有算术、没有动态取属性 / 下标 / 调用**。要那些得先拆箱，而拆哪一档
//      得看 `(dtag …)` —— 那笔分派的账在**这一份里**（方言那一层不替谁猜）。
//      所以这儿给四件事：`dynText`（印出来，python 的 str/repr 口径）、`dynTruthy`
//      （当条件用）、`dynBin`（二元算符）与 `noneOf` / `isNoneOf`（`None` 那一格）。

import {
  REAL, STR, BOOL, DYN, typeOf, sameType,
} from '../../../src/core/lower/ty-of.js';

/** 一格已经建好的 IR 表达式装的是什么。 */
const ty = (e, C) => typeOf(e, C.tyCtx());

export const isDyn = (t) => t !== null && t !== undefined && t.kind === 'dyn';

/** 装得进箱子的那六档（`DYN_BOXABLE`）。表与记录不在里头 —— 理由见文件头第 1 条。 */
export const boxable = (t) => t !== null && t !== undefined
  && (['int', 'real', 'bool', 'string', 'dyn', 'fn-type'].includes(t.kind)
    || (t.kind === 'map' && isDyn(t.value)));

/** 装箱。**已经是 dyn 就原样交回**（方言那一侧的 `(dyn (dyn E))` 是恒等，但少发一层更好读）。 */
export function boxOf(e, C) {
  const t = ty(e, C);
  if (isDyn(t)) return e;
  if (!boxable(t)) {
    throw new Error(`python->IR: ${t.kind} 装不进 dyn 那格箱子`
      + '（装得进的只有 int / real / bool / str / 函数 / dict[str, 任意]）'
      + ' —— 表要落成 `(arr dyn)`，不是把表装进箱子');
  }
  return { kind: 'builtin', name: 'dyn', args: [e] };
}

/**
 * 几格类型**合成一格**：全一样就是它，不一样就退到 dyn（ADR-0008 那一条）。
 * 有一格还不知道（`null`）就交 `null` —— 那是"再推一轮"，不是"异质"。
 */
export function unify(types) {
  if (types.length === 0) return null;
  if (types.some((t) => t === null || t === undefined)) return null;
  const [first] = types;
  if (types.every((t) => sameType(t, first))) return first;
  if (types.every((t) => boxable(t))) return DYN;
  return null;
}

/**
 * **python 这一侧的合成** —— 同一格变量被写了几回，那一格该声明成什么。
 *
 * 现在就是 `unify`：一样就是它，不一样退到 dyn。
 *
 * **不要把 int 与 real 混着来的那一档提到 real** —— 试过，错的：
 * `y = 1` / `print(y)` / `y = 2.5` 里 python 印的是 `1`，提到 real 之后印 `1.0`。
 * 那一格在第一句之后**真的是 int**，不是"将来会变成 real 的 int"。
 * 省掉按标签分派的那点账，代价是印错数 —— 不换。
 */
export const unifyPy = unify;

/** `(dtag v) == "名"` */
const tagIs = (v, name) => ({
  kind: 'binop', op: '==',
  left: { kind: 'builtin', name: 'dtag', args: [v] },
  right: { kind: 'string', value: name },
});

const strLit = (value) => ({ kind: 'string', value });

/** `None` —— 标签是 `"null"` 的那一格 dyn（方言的 `(dnull)`）。 */
export const noneOf = () => ({ kind: 'builtin', name: 'dnull', args: [] });

/** `x is None` / `x is not None` —— 问标签就够（同一性在这个值域里就是"是不是那一格空"）。 */
export function isNoneOf(v, C, negate = false) {
  const t = ty(v, C);
  /* 静态类型的那几档**永远不是 None**（方言里它们装不了"没有值"）—— 编译期答完。 */
  if (!isDyn(t)) return { kind: 'bool', value: negate };
  const test = tagIs(v, 'null');
  return negate ? { kind: 'unop', op: '!', operand: test } : test;
}

/**
 * **一格 dyn 印成 python 的文本**：按 `(dtag …)` 逐档分派。
 *
 * `quote` 为真是 `repr()` 那一侧（串带一对单引号，容器里的元素走它）；
 * 为假是 `str()` 那一侧。数那两档两侧一样（int 走 `tostr`、real 走 `srepr`），
 * 布尔是 `True` / `False`（不是方言 `tostr` 的 `true`）。
 *
 * **明说的不足**：标签不在这四档里（函数、字典、`null`）时印的是**标签本身**
 * （`"function"` 那种），不是 python 的 `<function f at 0x…>` —— 那串里有地址，
 * 逐字节比不了，所以不装作有。
 *
 * `v` 会被求值**四五次**（每档一次 `dtag` 加一次拆箱），所以不纯的先落一格临时量。
 */
export function dynText(v, C, quote = false) {
  const pre = [];
  let src = v;
  if (!['int', 'real', 'string', 'bool', 'name'].includes(v.kind)) {
    const n = C.fresh('dv');
    C.bind(n, DYN);
    pre.push({ kind: 'let', name: n, type: DYN, init: v });
    src = { kind: 'name', name: n };
  }
  const sv = { kind: 'builtin', name: 'asstr', args: [src] };
  const chain = {
    kind: 'ternary', type: STR, cond: tagIs(src, 'int'),
    then: { kind: 'builtin', name: 'tostr', args: [{ kind: 'builtin', name: 'asint', args: [src] }] },
    else_: {
      kind: 'ternary', type: STR, cond: tagIs(src, 'real'),
      then: { kind: 'builtin', name: 'srepr', args: [{ kind: 'builtin', name: 'asreal', args: [src] }] },
      else_: {
        kind: 'ternary', type: STR, cond: tagIs(src, 'bool'),
        then: {
          kind: 'ternary', type: STR,
          cond: { kind: 'builtin', name: 'asbool', args: [src] },
          then: strLit('True'), else_: strLit('False'),
        },
        else_: {
          kind: 'ternary', type: STR, cond: tagIs(src, 'string'),
          then: quote
            ? {
              kind: 'binop', op: '+',
              left: { kind: 'binop', op: '+', left: strLit("'"), right: sv },
              right: strLit("'"),
            }
            : sv,
          /* 剩下那几档（函数 / 字典 / null）：`None` 印 `None`，别的印标签，见上面那段话。 */
          else_: {
            kind: 'ternary', type: STR, cond: tagIs(src, 'null'),
            then: strLit('None'),
            else_: { kind: 'builtin', name: 'dtag', args: [src] },
          },
        },
      },
    },
  };
  return pre.length === 0 ? chain : { kind: 'block-expr', stmts: pre, value: chain };
}

/** python 的真值，但接收者是一格 dyn：数看是不是 0、串看长度、布尔就是它自己。 */
export function dynTruthy(v, C) {
  const pre = [];
  let src = v;
  if (!['name'].includes(v.kind)) {
    const n = C.fresh('dc');
    C.bind(n, DYN);
    pre.push({ kind: 'let', name: n, type: DYN, init: v });
    src = { kind: 'name', name: n };
  }
  const chain = {
    kind: 'ternary', type: BOOL, cond: tagIs(src, 'int'),
    then: {
      kind: 'binop', op: '!=',
      left: { kind: 'builtin', name: 'asint', args: [src] },
      right: { kind: 'int', value: 0 },
    },
    else_: {
      kind: 'ternary', type: BOOL, cond: tagIs(src, 'real'),
      then: {
        kind: 'binop', op: '!=',
        left: { kind: 'builtin', name: 'asreal', args: [src] },
        right: { kind: 'real', value: 0 },
      },
      else_: {
        kind: 'ternary', type: BOOL, cond: tagIs(src, 'bool'),
        then: { kind: 'builtin', name: 'asbool', args: [src] },
        else_: {
          kind: 'ternary', type: BOOL, cond: tagIs(src, 'string'),
          then: {
            kind: 'binop', op: '!=',
            left: { kind: 'builtin', name: 'scplen', args: [{ kind: 'builtin', name: 'asstr', args: [src] }] },
            right: { kind: 'int', value: 0 },
          },
          /* 别的（函数、字典、null）：`null` 是假，别的是真 —— python 里对象默认为真。 */
          else_: {
            kind: 'binop', op: '!=',
            left: { kind: 'builtin', name: 'dtag', args: [src] },
            right: strLit('null'),
          },
        },
      },
    },
  };
  return pre.length === 0 ? chain : { kind: 'block-expr', stmts: pre, value: chain };
}

/* ─── 箱子上的算术 ──────────────────────────────────────────────────────── */

/** 一格 dyn **当 real 读**：int 那一档要先 `toreal`（箱子里那两档的位不一样）。 */
const asNum = (v) => ({
  kind: 'ternary', type: REAL, cond: tagIs(v, 'int'),
  then: { kind: 'builtin', name: 'toreal', args: [{ kind: 'builtin', name: 'asint', args: [v] }] },
  else_: { kind: 'builtin', name: 'asreal', args: [v] },
});

/** 两边都是整数吗（`+` / `-` / `*` 要它：python 里 int op int 还是 int）。 */
const bothInt = (a, b) => ({ kind: 'binop', op: '&&', left: tagIs(a, 'int'), right: tagIs(b, 'int') });
const bothStr = (a, b) => ({ kind: 'binop', op: '&&', left: tagIs(a, 'string'), right: tagIs(b, 'string') });

/** 这一格箱子里装的是数吗 —— **布尔算数**（python 里 `1 == True` 是 True）。 */
const isNumTag = (v) => ({
  kind: 'binop', op: '||',
  left: tagIs(v, 'int'),
  right: { kind: 'binop', op: '||', left: tagIs(v, 'real'), right: tagIs(v, 'bool') },
});

/** 比较时把一格箱子读成 real：int / real / bool 三档都读得出（`True` 是 1.0）。 */
const asCmpNum = (v) => ({
  kind: 'ternary', type: REAL, cond: tagIs(v, 'int'),
  then: { kind: 'builtin', name: 'toreal', args: [{ kind: 'builtin', name: 'asint', args: [v] }] },
  else_: {
    kind: 'ternary', type: REAL, cond: tagIs(v, 'real'),
    then: { kind: 'builtin', name: 'asreal', args: [v] },
    else_: {
      kind: 'ternary', type: REAL,
      cond: { kind: 'builtin', name: 'asbool', args: [v] },
      then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 },
    },
  },
});

/** 落一格 dyn 的临时量（下面那几支要反复读它）。 */
function hold(v, C, pre, tag_) {
  if (v.kind === 'name') return v;
  const n = C.fresh(tag_);
  C.bind(n, DYN);
  pre.push({ kind: 'let', name: n, type: DYN, init: v });
  return { kind: 'name', name: n };
}

const CMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);
/** 位运算：python 的写法 → 方言里那一格（与 `expr.js` 的 `BITS` 同一张）。 */
const BITS_OPS = new Map([['&', '&'], ['|', '|'], ['^', '^'], ['<<', '<<'], ['>>', '>>']]);

/**
 * **两支各走各的**（不是 `(sel c a b)`）：交回一格临时量 + 一句 `if`。
 *
 * 为什么不能用三目：`pyMod` 那一族会为"算两次"落临时量，落出来的是
 * `{ kind: 'block-expr', stmts, value }` —— 摆进三目的支里，那几句 `let` 会被
 * **提到三目外头**无条件执行，于是 `7.5 // 2` 那一路上 `(asint …)` 也跑了，
 * 当场 `dynamic value is real, expected int`（量出来的）。摆进 `if` 的支里就留在支里。
 */
function dynBranch(cond, thenE, elseE, C, pre) {
  const n = C.fresh('dr');
  C.bind(n, DYN);
  pre.push({ kind: 'let', name: n, type: DYN, init: noneOf() });
  pre.push({
    kind: 'if',
    cond,
    then: [{ kind: 'assign', target: { kind: 'name', name: n }, value: thenE }],
    else_: [{ kind: 'assign', target: { kind: 'name', name: n }, value: elseE }],
  });
  return { kind: 'name', name: n };
}

/**
 * **箱子上的二元算符**：`(dtag …)` 两边各问一次，按档走。
 *
 *   * `+` `-` `*`：两边都是 int 就走整数（交回一格装着 int 的箱子），否则按 real 算；
 *     `+` 另有"两边都是串"那一支（拼接）。
 *   * `/`：python 里永远出浮点。
 *   * `// % **`：两边都是整数走整数那一支（`**` 另加"指数不是负数"—— 运行期问一次），
 *     否则按 real 算。
 *   * 位运算：两边都得是整数（python 里 `1.5 & 1` 是 TypeError），直接发整数那一支。
 *   * 比较：交的是 bool（不装箱）—— 数与数按 real 比，串与串按串比，标签不同型是 False
 *     （`1 == "1"` 在 python 里就是 False，不是报错）。
 *
 * 算术那几支**碰上不该碰的标签是运行期错误**（`"a" - 1` 走到 real 那一支，`asreal`
 * 看见 string 标签当场报 `dynamic value is string, expected real`）—— python 那边是
 * TypeError，方言里没有异常，**报出来比算出个假数字好**，所以就让它报。
 *
 * `hooks` 收 `'//'` / `'%'` / `'**'` 三格算法（`(左, 右, 要整数吗) => IR`）——
 * python 的那三条规矩写在 `expr.js` 里（静态那一侧用的是同一份），这儿只管分派。
 */
export function dynBin(op, a0, b0, C, hooks = {}) {
  const pre = [];
  const a = hold(boxOf(a0, C), C, pre, 'da');
  const b = hold(boxOf(b0, C), C, pre, 'db');
  const wrap = (e) => (pre.length === 0 ? e : { kind: 'block-expr', stmts: pre, value: e });

  if (CMP_OPS.has(op)) {
    return wrap({
      kind: 'ternary', type: BOOL,
      /* **两边都是 `None`** —— `None == None` 在 python 里是 True（不是"标签不同型"那一支）。
         `None < None` 那几个在 python 里是 TypeError，方言里没有异常 —— 这儿答 False，
         不装作有（撞上了看到的是个假答案，不是崩，所以这一条**明说在这儿**）。 */
      cond: { kind: 'binop', op: '&&', left: tagIs(a, 'null'), right: tagIs(b, 'null') },
      then: { kind: 'bool', value: op === '==' },
      else_: {
        kind: 'ternary', type: BOOL, cond: bothStr(a, b),
        then: { kind: 'binop', op, left: { kind: 'builtin', name: 'asstr', args: [a] }, right: { kind: 'builtin', name: 'asstr', args: [b] } },
        else_: {
          kind: 'ternary', type: BOOL,
          /* **两边都是数就按数比**（int / real / bool 算一档 —— python 里 `1 == 1.0` 与
             `1 == True` 都是 True）。一边是数一边是串那种，`==` 是 False、`!=` 是 True。 */
          cond: { kind: 'binop', op: '&&', left: isNumTag(a), right: isNumTag(b) },
          then: { kind: 'binop', op, left: asCmpNum(a), right: asCmpNum(b) },
          else_: { kind: 'bool', value: op === '!=' },
        },
      },
    });
  }

  if (op === '/') {
    return wrap(boxOf({ kind: 'binop', op: '/', left: asNum(a), right: asNum(b) }, C));
  }

  /* `//` `%` `**` —— python 的那三条规矩（向下取整、符号跟着除数、整数次幂还是整数）
     写在 `expr.js` 里（静态那一侧用的是同一份），所以这儿只管**分派**：
     走整数那一支的条件是"两边都是整数"，`**` 另加一条"指数不是负数"
     （python 里 `2 ** -1` 是 0.5 —— 静态那一侧靠"指数是非负整数字面量"才敢说 int，
     箱子上没有那个信息，所以在**运行期**问一次）。 */
  if (['//', '%', '**'].includes(op)) {
    const h = hooks[op];
    if (h === undefined) {
      throw new Error(`python->IR: 箱子上的 '${op}' 没给算法（调用方要传 hooks['${op}']）`);
    }
    const ai = { kind: 'builtin', name: 'asint', args: [a] };
    const bi = { kind: 'builtin', name: 'asint', args: [b] };
    let wantInt = bothInt(a, b);
    if (op === '**') {
      wantInt = {
        kind: 'binop', op: '&&', left: wantInt,
        right: { kind: 'binop', op: '>=', left: bi, right: { kind: 'int', value: 0 } },
      };
    }
    return wrap(dynBranch(
      wantInt,
      boxOf(h(ai, bi, true), C),
      boxOf(h(asNum(a), asNum(b), false), C),
      C,
      pre,
    ));
  }

  /* 位运算：python 里两边都得是整数（`1.5 & 1` 是 TypeError）—— 所以直接发整数那一支，
     标签不对时 `(asint …)` 在运行期报，与那边抛异常同一档（方言里没有异常）。 */
  if (BITS_OPS.has(op)) {
    return wrap(boxOf({
      kind: 'binop', op: BITS_OPS.get(op),
      left: { kind: 'builtin', name: 'asint', args: [a] },
      right: { kind: 'builtin', name: 'asint', args: [b] },
    }, C));
  }

  if (!['+', '-', '*'].includes(op)) {
    throw new Error(`python->IR: 箱子上的 '${op}' 还没接`
      + '（接了的是 + - * / // % **、六个比较与五格位运算）');
  }

  const intArm = boxOf({
    kind: 'binop', op,
    left: { kind: 'builtin', name: 'asint', args: [a] },
    right: { kind: 'builtin', name: 'asint', args: [b] },
  }, C);
  const realArm = boxOf({ kind: 'binop', op, left: asNum(a), right: asNum(b) }, C);
  const numArm = { kind: 'ternary', type: DYN, cond: bothInt(a, b), then: intArm, else_: realArm };
  /* `*` 多一支：**一边是串、一边是整数就重复**（python 里 `"ab" * 3` 与 `3 * "ab"`）。
     不接这一支的症状不是"还没接"，而是运行期一句
     `dynamic value is string, expected real` —— `(asnum …)` 把串往数上掰。
     量到的路子：`v = 1` 之后 `v = "s"`（那一格名字合成 dyn），再 `v * 2`。 */
  if (op === '*') {
    const sRep = (s, n) => boxOf({
      kind: 'builtin',
      name: 'srep',
      args: [
        { kind: 'builtin', name: 'asstr', args: [s] },
        { kind: 'builtin', name: 'asint', args: [n] },
      ],
    }, C);
    return wrap({
      kind: 'ternary', type: DYN,
      cond: { kind: 'binop', op: '&&', left: tagIs(a, 'string'), right: tagIs(b, 'int') },
      then: sRep(a, b),
      else_: {
        kind: 'ternary', type: DYN,
        cond: { kind: 'binop', op: '&&', left: tagIs(b, 'string'), right: tagIs(a, 'int') },
        then: sRep(b, a),
        else_: numArm,
      },
    });
  }
  if (op !== '+') return wrap(numArm);
  /* `+` 多一支：两边都是串就拼起来（python 里 `"a" + "b"`）。 */
  return wrap({
    kind: 'ternary', type: DYN, cond: bothStr(a, b),
    then: boxOf({
      kind: 'binop', op: '+',
      left: { kind: 'builtin', name: 'asstr', args: [a] },
      right: { kind: 'builtin', name: 'asstr', args: [b] },
    }, C),
    else_: numArm,
  });
}
