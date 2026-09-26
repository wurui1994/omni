// ext/python/adapter/builtins.js —— **走一遍容器的那几个内建**（现场发一趟循环）
//
// 方言里没有"聚合"这一族算子（没有 sum / min / sorted / join / split），可它有
// `while` / `aget` / `apush` / `sfind` / `ssub` —— 所以这几格全是**现场发一趟循环**。
// 与 `expr.js` 里 `listRepr` 那一处同一条办法（那一格是"表转串"）。
//
// 为什么不往方言里加算子：这几个是 **python 的规矩**（`sum([])` 是 `0` 而不是报错、
// `"a,b".split(",")` 的空段算一格、`.strip()` 去的是哪几个空白字符），不是汇聚层该知道的。
// 加进去就要替十几门语言各自的差别背账 —— 同一条理由写在 `ext/python/SPEC.md` §三。
//
// 这一份里每一格都**只用已有的方言算子**，所以三条腿一行没改就通。

import { INT, REAL, STR, BOOL, arrOf } from '../../../src/core/lower/ty-of.js';

const isPure = (e) => ['int', 'real', 'string', 'bool', 'name'].includes(e.kind);

/** 一格整数字面量 / 名字。 */
const int = (value) => ({ kind: 'int', value });
const str = (value) => ({ kind: 'string', value });
const nm = (name) => ({ kind: 'name', name });
const bin = (op, left, right) => ({ kind: 'binop', op, left, right });
const call1 = (name, args) => ({ kind: 'builtin', name, args });

/** 递一格 `{ keep, pre }`：`keep(e, 前缀)` 把不纯的落成临时量，语句攒在 `pre` 里。 */
function holder(C) {
  const pre = [];
  const keep = (e, p, t) => {
    if (isPure(e)) return e;
    const n = C.fresh(p);
    const ty0 = t ?? C.tyOfIR(e);
    C.bind(n, ty0);
    pre.push({ kind: 'let', name: n, type: ty0, init: e });
    return nm(n);
  };
  const decl = (p, t, initE) => {
    const n = C.fresh(p);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: initE });
    return nm(n);
  };
  const wrap = (value) => (pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value });
  return { pre, keep, decl, wrap };
}

/** `i += 1` */
const inc = (i) => ({ kind: 'assign', target: i, value: bin('+', i, int(1)) });

/* ─── 表上那几个 ─────────────────────────────────────────────────────────── */

/** `sum(xs)` —— python 里空表交 `0`（int），所以累加量的类型跟着元素。 */
export function sumOf(xs0, C) {
  const h = holder(C);
  const xs = h.keep(xs0, 'sum_xs');
  const t = C.tyOfIR(xs);
  if (t.kind !== 'arr' || !['int', 'real'].includes(t.elem.kind)) {
    throw new Error(`python->IR: \`sum()\` 只接数的表（这里是 ${t.kind === 'arr' ? `arr<${t.elem.kind}>` : t.kind}）`);
  }
  const acc = h.decl('sum_a', t.elem, t.elem.kind === 'real' ? { kind: 'real', value: 0 } : int(0));
  const i = h.decl('sum_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      { kind: 'assign', target: acc, value: bin('+', acc, { kind: 'index', obj: xs, index: i }) },
      inc(i),
    ],
  });
  return h.wrap(acc);
}

/**
 * `min(xs)` / `max(xs)` —— 空表在 python 里是 ValueError，这儿 `(fail …)`。
 * `less(a, b)` 是"a 比 b 小"那一格，由 `expr.js` 递进来：元组要按字典序逐格比，
 * 直接 `bin('<', …)` 会去比句柄、静默答错（量到过）。比法是**严格**的，所以并列时留
 * 靠前那一格 —— 与 python 一条。
 */
export function pickList(xs0, op, name, C, less) {
  const h = holder(C);
  const xs = h.keep(xs0, 'pk_xs');
  const t = C.tyOfIR(xs);
  if (t.kind !== 'arr') throw new Error(`python->IR: \`${name}()\` 收一格表或两格以上的值`);
  h.pre.push({
    kind: 'if',
    cond: bin('==', call1('alen', [xs]), int(0)),
    then: [{ kind: 'builtin-stmt', name: 'fail', args: [str(`${name}() arg is an empty sequence`)] }],
    else_: null,
  });
  const best = h.decl('pk_b', t.elem, { kind: 'index', obj: xs, index: int(0) });
  const i = h.decl('pk_i', INT, int(1));
  const cand = { kind: 'index', obj: xs, index: i };
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      {
        kind: 'if',
        cond: op === '<' ? less(cand, best) : less(best, cand),
        then: [{ kind: 'assign', target: best, value: { kind: 'index', obj: xs, index: i } }],
        else_: null,
      },
      inc(i),
    ],
  });
  return h.wrap(best);
}

/**
 * `any(xs)` / `all(xs)` —— **整张表都扫**（python 会短路，可表里那几格值早就算完了，
 * 扫到底与短路**看不出区别**；少一格 `break` 少一条路）。
 */
export function anyAllOf(xs0, wantAll, C, truthy) {
  const h = holder(C);
  const xs = h.keep(xs0, 'aa_xs');
  const t = C.tyOfIR(xs);
  if (t.kind !== 'arr') throw new Error(`python->IR: \`${wantAll ? 'all' : 'any'}()\` 收一格表`);
  const r = h.decl('aa_r', BOOL, { kind: 'bool', value: wantAll });
  const i = h.decl('aa_i', INT, int(0));
  const one = truthy({ kind: 'index', obj: xs, index: i }, C);
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      {
        kind: 'if',
        cond: wantAll ? { kind: 'unop', op: '!', operand: one } : one,
        then: [{ kind: 'assign', target: r, value: { kind: 'bool', value: !wantAll } }],
        else_: null,
      },
      inc(i),
    ],
  });
  return h.wrap(r);
}

/**
 * `sorted(xs)` —— **插入排序**（python 的 sort 是稳定的，插入排序也是；
 * 这儿要的是"答得对"，不是"快"。真要快得先有"函数值当比较器"那一层）。
 */
export function sortedOf(xs0, C, desc = false, less = null) {
  const h = holder(C);
  const xs = h.keep(xs0, 'st_xs');
  const t = C.tyOfIR(xs);
  if (t.kind !== 'arr') throw new Error('python->IR: `sorted()` 收一格表');
  if (less === null && !['int', 'real', 'string'].includes(t.elem.kind)) {
    throw new Error(`python->IR: \`sorted()\` 的元素是 ${t.elem.kind} —— 还没接（要有"怎么比"）`);
  }
  /* "a 比 b 小"那一格：默认就是方言的 `<`，元组那一档由 `expr.js` 递一份进来。 */
  const lt = (x, y) => (less === null ? bin('<', x, y) : less(x, y));
  /* 先抄一份（python 的 sorted 不动原表）。 */
  const out = h.decl('st_o', t, { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: t }, int(0)] });
  const i = h.decl('st_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      { kind: 'builtin-stmt', name: 'apush', args: [out, { kind: 'index', obj: xs, index: i }] },
      inc(i),
    ],
  });
  /* 插入排序：j 从 1 起，往前挪到位。 */
  const j = h.decl('st_j', INT, int(1));
  const k = h.decl('st_k', INT, int(0));
  const cur = h.decl('st_c', t.elem, { kind: 'index', obj: out, index: int(0) });
  h.pre.push({
    kind: 'while',
    cond: bin('<', j, call1('alen', [out])),
    body: [
      { kind: 'assign', target: cur, value: { kind: 'index', obj: out, index: j } },
      { kind: 'assign', target: k, value: bin('-', j, int(1)) },
      {
        kind: 'while',
        cond: bin('&&', bin('>=', k, int(0)),
          desc ? lt({ kind: 'index', obj: out, index: k }, cur)
            : lt(cur, { kind: 'index', obj: out, index: k })),
        body: [
          {
            kind: 'assign',
            target: { kind: 'index', obj: out, index: bin('+', k, int(1)) },
            value: { kind: 'index', obj: out, index: k },
          },
          { kind: 'assign', target: k, value: bin('-', k, int(1)) },
        ],
      },
      { kind: 'assign', target: { kind: 'index', obj: out, index: bin('+', k, int(1)) }, value: cur },
      inc(j),
    ],
  });
  return h.wrap(out);
}

/** `list(range(a, b, step))` —— 步长是**编译期的字面量**（与 `for … in range(…)` 同一条）。 */
export function rangeList(from, to, step, C) {
  const h = holder(C);
  const t = arrOf(INT);
  const out = h.decl('rg_o', t, { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: t }, int(0)] });
  const i = h.decl('rg_i', INT, from);
  h.pre.push({
    kind: 'while',
    cond: bin(step > 0 ? '<' : '>', i, to),
    body: [
      { kind: 'builtin-stmt', name: 'apush', args: [out, i] },
      { kind: 'assign', target: i, value: bin('+', i, int(step)) },
    ],
  });
  return h.wrap(out);
}

/* ─── 字典上那几个（键表已经由方言的 `(dkeys d)` 交出来了）─────────────────── */

/**
 * `d.values()` —— 走一遍键表，逐个 `dget`。
 *
 * 为什么不给方言加一格 `dvalues`：键表那一格是**非加不可**的（不遍历就没有别的路
 * 走到键上），而值表是它的一个推论 —— 加了就要连 `.items()` 一起加，方言那一层
 * 又不该知道 python 的视图语义。次序与 `.keys()` 同（插入序）。
 */
export function valuesList(d0, C) {
  const h = holder(C);
  const d = h.keep(d0, 'dv_d');
  const t = C.tyOfIR(d);
  if (t.kind !== 'map') throw new Error(`python->IR: \`.values()\` 的接收者装的是 ${t.kind}`);
  const vt = arrOf(t.value);
  const ks = h.decl('dv_ks', arrOf(t.key), call1('dkeys', [d]));
  const out = h.decl('dv_o', vt, call1('anew', [{ kind: 'type', type: vt }, int(0)]));
  const i = h.decl('dv_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [ks])),
    body: [
      {
        kind: 'builtin-stmt',
        name: 'apush',
        args: [out, call1('dget', [d, { kind: 'index', obj: ks, index: i }])],
      },
      inc(i),
    ],
  });
  return h.wrap(out);
}

/**
 * `d.clear()` —— 走一遍键表逐个 `ddel`。**不能边走边删**：键表是抄出来的一份
 * （`dkeys` 那一格），所以走它、删字典，两边不打搅。
 */
export function dictClearStmts(d0, C) {
  const h = holder(C);
  const d = h.keep(d0, 'dc_d');
  const t = C.tyOfIR(d);
  if (t.kind !== 'map') throw new Error(`python->IR: \`.clear()\` 的接收者装的是 ${t.kind}`);
  const ks = h.decl('dc_ks', arrOf(t.key), call1('dkeys', [d]));
  const i = h.decl('dc_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [ks])),
    body: [
      { kind: 'expr-stmt', expr: call1('ddel', [d, { kind: 'index', obj: ks, index: i }]) },
      inc(i),
    ],
  });
  return h.pre;
}

/**
 * `d.pop(k)` / `d.pop(k, 默认值)` —— 取走一格。
 *
 * 一格 block-expr：先落一个临时量装值，再 `ddel`。**次序要紧** —— `dget` 得在
 * `ddel` 之前，删过之后那一格就读不到了。
 *
 * 一格实参时键不在是 KeyError（`(fail missMsg)`，那句话由调用方拼 —— 里头要
 * `repr(键)`，而 `pyRepr` 不在这一份里）；两格时答默认值、字典不动。
 * `both`（值与默认值合成的那一格）与 `box`（两侧各自要不要装箱）也都由调用方给。
 */
export function dictPopOf(d0, k0, o, C) {
  const h = holder(C);
  const d = h.keep(d0, 'dp_d');
  const k = h.keep(k0, 'dp_k');
  const out = h.decl('dp_v', o.both, zeroLike(o.both));
  h.pre.push({
    kind: 'if',
    cond: call1('dhas', [d, k]),
    then: [
      { kind: 'assign', target: out, value: o.boxHit(call1('dget', [d, k])) },
      { kind: 'expr-stmt', expr: call1('ddel', [d, k]) },
    ],
    else_: o.dflt === null
      ? [{ kind: 'builtin-stmt', name: 'fail', args: [o.missMsg] }]
      : [{ kind: 'assign', target: out, value: o.boxDflt(o.dflt) }],
  });
  return h.wrap(out);
}

/** 一格类型的"零"（`dp_v` 那个临时量要先有个初值 —— 方言里 let 必须给）。 */
function zeroLike(t) {
  if (t.kind === 'int') return int(0);
  if (t.kind === 'real') return { kind: 'real', value: 0 };
  if (t.kind === 'bool') return { kind: 'bool', value: false };
  if (t.kind === 'string') return str('');
  if (t.kind === 'dyn') return call1('dnull', []);
  throw new Error(`python->IR: \`.pop()\` 交 ${t.kind} 还没接`);
}

/* ─── 表上的拼接与重复（`+` / `*`），以及 `reversed()` ─────────────────────── */

/**
 * `xs + ys` —— python 里这是**新造一张表**（两边都不动）。方言的 `+` 只认数与串，
 * 所以现场发两趟循环抄过去。
 *
 * 元素类型要合得上（`unify` 由调用方给的 `elemT` 定）；装箱那一下也在调用方 ——
 * 异质的两张表拼起来是 `(arr dyn)`，那时两边各自要先装箱。
 */
export function concatList(xs0, ys0, elemT, C, box) {
  const h = holder(C);
  const xs = h.keep(xs0, 'ct_xs');
  const ys = h.keep(ys0, 'ct_ys');
  const t = arrOf(elemT);
  const out = h.decl('ct_o', t, call1('anew', [{ kind: 'type', type: t }, int(0)]));
  const one = (src, p) => {
    const i = h.decl(p, INT, int(0));
    h.pre.push({
      kind: 'while',
      cond: bin('<', i, call1('alen', [src])),
      body: [
        {
          kind: 'builtin-stmt', name: 'apush',
          args: [out, box(src, { kind: 'index', obj: src, index: i })],
        },
        inc(i),
      ],
    });
  };
  one(xs, 'ct_i');
  one(ys, 'ct_j');
  return h.wrap(out);
}

/**
 * `xs * n`（`n * xs` 同）—— 新造一张表，把 xs 抄 n 遍。
 * **n <= 0 给空表**（python 的规矩），所以外层那格循环的条件天然管住了。
 */
export function repeatList(xs0, n0, C) {
  const h = holder(C);
  const xs = h.keep(xs0, 'rp_xs');
  const n = h.keep(n0, 'rp_n', INT);
  const t = C.tyOfIR(xs);
  const out = h.decl('rp_o', t, call1('anew', [{ kind: 'type', type: t }, int(0)]));
  const k = h.decl('rp_k', INT, int(0));
  const i = h.decl('rp_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', k, n),
    body: [
      { kind: 'assign', target: i, value: int(0) },
      {
        kind: 'while',
        cond: bin('<', i, call1('alen', [xs])),
        body: [
          { kind: 'builtin-stmt', name: 'apush', args: [out, { kind: 'index', obj: xs, index: i }] },
          inc(i),
        ],
      },
      inc(k),
    ],
  });
  return h.wrap(out);
}

/**
 * `reversed(xs)` —— python 交的是个迭代器，我们交**倒过来的一张新表**
 * （原表不动，与 `.reverse()` 正相反）。`list(reversed(xs))` 那种写法两边一样。
 */
export function reversedList(xs0, C) {
  const h = holder(C);
  const xs = h.keep(xs0, 'rr_xs');
  const t = C.tyOfIR(xs);
  const out = h.decl('rr_o', t, call1('anew', [{ kind: 'type', type: t }, int(0)]));
  const i = h.decl('rr_i', INT, bin('-', call1('alen', [xs]), int(1)));
  h.pre.push({
    kind: 'while',
    cond: bin('>=', i, int(0)),
    body: [
      { kind: 'builtin-stmt', name: 'apush', args: [out, { kind: 'index', obj: xs, index: i }] },
      { kind: 'assign', target: i, value: bin('-', i, int(1)) },
    ],
  });
  return h.wrap(out);
}

/**
 * 带步长的切片 `xs[a:b:step]` / `s[a:b:step]`。**step 要是字面量** —— 与
 * `range(a, b, step)` 同一条理由：往上走还是往下走得在编译期知道，收运行期的值
 * 就要发两条循环。`s[::-1]`（整条倒过来）是最常见的那一格。
 *
 * `start` 与 `bound` 由调用方算好（两头都已经夹在合法范围里）：
 * 正步长时从 `start` 走到 `bound`（不含），负步长时从 `start` 往下走到 `bound`（含）。
 */
export function stepSlice(box, start, bound, step, isStr, C) {
  const h = holder(C);
  const src = h.keep(box, 'sp_s');
  const down = step < 0;
  const t = isStr ? STR : C.tyOfIR(src);
  const out = h.decl('sp_o', t, isStr
    ? str('')
    : call1('anew', [{ kind: 'type', type: t }, int(0)]));
  const i = h.decl('sp_i', INT, start);
  const at = isStr
    ? call1('ssub', [src, i, int(1)])
    : { kind: 'index', obj: src, index: i };
  h.pre.push({
    kind: 'while',
    cond: down ? bin('>=', i, bound) : bin('<', i, bound),
    body: [
      isStr
        ? { kind: 'assign', target: out, value: bin('+', out, at) }
        : { kind: 'builtin-stmt', name: 'apush', args: [out, at] },
      { kind: 'assign', target: i, value: bin('+', i, int(step)) },
    ],
  });
  return h.wrap(out);
}

/**
 * python 的 `round()` 是**半数取偶**（`round(0.5)` 是 0、`round(1.5)` 是 2、
 * `round(2.5)` 是 2、`round(-2.5)` 是 -2）。C 的 `round()` 是"远离零"，所以 `.5`
 * 那一档两边不一样 —— 量出来的：`round(2.5)` 从前我们交 3、python 交 2。
 *
 * 这一格**不给方言加算子**（`nearbyint` 要五条腿各写一遍，而 JS 的 `Math.round`
 * 也不是半数取偶）—— 用已有的 `floor` / `fmod` 拼出来：
 *   f = floor(x)、d = x - f；d > 0.5 → f+1；d < 0.5 → f；正好 0.5 → f 是偶数就 f、否则 f+1。
 */
export function bankRound(x0, C) {
  const h = holder(C);
  const x = h.keep(x0, 'br_x', REAL);
  const f = h.decl('br_f', REAL, { kind: 'rmath', fn: 'floor', args: [x] });
  const out = h.decl('br_o', REAL, f);
  const d = h.decl('br_d', REAL, bin('-', x, f));
  const one = { kind: 'real', value: 1 };
  const half = { kind: 'real', value: 0.5 };
  const up = [{ kind: 'assign', target: out, value: bin('+', f, one) }];
  const odd = bin('!=',
    { kind: 'rmath', fn: 'fmod', args: [f, { kind: 'real', value: 2 }] },
    { kind: 'real', value: 0 });
  h.pre.push({
    kind: 'if',
    cond: bin('>', d, half),
    then: up,
    else_: [{
      kind: 'if',
      cond: bin('==', d, half),
      then: [{ kind: 'if', cond: odd, then: up, else_: null }],
      else_: null,
    }],
  });
  return h.wrap(out);
}

/**
 * `xs.sort()` / `xs.sort(reverse=True)` —— **就地**排（python 里它交 None，
 * 与 `sorted()` 正相反：那一格抄一份）。插入排序，与 `sortedOf` 里那一段同一条。
 */
export function sortStmts(xs, C, desc = false, less = null) {
  const h = holder(C);
  const t = C.tyOfIR(xs);
  if (t.kind !== 'arr') throw new Error('python->IR: `.sort()` 的接收者要是一格表');
  if (less === null && !['int', 'real', 'string'].includes(t.elem.kind)) {
    throw new Error(`python->IR: \`.sort()\` 的元素是 ${t.elem.kind} —— 还没接（要有"怎么比"）`);
  }
  const lt = (x, y) => (less === null ? bin('<', x, y) : less(x, y));
  const j = h.decl('so_j', INT, int(1));
  const k = h.decl('so_k', INT, int(0));
  const cur = h.decl('so_c', t.elem, { kind: 'index', obj: xs, index: int(0) });
  h.pre.push({
    kind: 'while',
    cond: bin('<', j, call1('alen', [xs])),
    body: [
      { kind: 'assign', target: cur, value: { kind: 'index', obj: xs, index: j } },
      { kind: 'assign', target: k, value: bin('-', j, int(1)) },
      {
        kind: 'while',
        cond: bin('&&', bin('>=', k, int(0)),
          desc ? lt({ kind: 'index', obj: xs, index: k }, cur)
            : lt(cur, { kind: 'index', obj: xs, index: k })),
        body: [
          {
            kind: 'assign',
            target: { kind: 'index', obj: xs, index: bin('+', k, int(1)) },
            value: { kind: 'index', obj: xs, index: k },
          },
          { kind: 'assign', target: k, value: bin('-', k, int(1)) },
        ],
      },
      { kind: 'assign', target: { kind: 'index', obj: xs, index: bin('+', k, int(1)) }, value: cur },
      inc(j),
    ],
  });
  return h.pre;
}

/**
 * `d.update(other)` —— 把 other 的每一格写进 d（键重了就盖掉）。python 里交 None。
 * 走 other 的键表（`dkeys`），与 `.values()` 那一格同一条。
 */
export function dictUpdateStmts(d0, o0, C, box) {
  const h = holder(C);
  const d = h.keep(d0, 'du_d');
  const o = h.keep(o0, 'du_o');
  const ot = C.tyOfIR(o);
  if (ot.kind !== 'map') throw new Error(`python->IR: \`.update()\` 收一格字典，这里是 ${ot.kind}`);
  const ks = h.decl('du_ks', arrOf(ot.key), call1('dkeys', [o]));
  const i = h.decl('du_i', INT, int(0));
  const k = { kind: 'index', obj: ks, index: i };
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [ks])),
    body: [
      { kind: 'builtin-stmt', name: 'dset', args: [d, k, box(call1('dget', [o, k]))] },
      inc(i),
    ],
  });
  return h.pre;
}

/**
 * `d.setdefault(k, v)` —— 键在就交那一格、不在就写进去再交。
 * 交的是**值**，所以是个 block-expr（与 `.pop()` 同一条办法）。
 */
export function dictSetDefaultOf(d0, k0, v, both, boxHit, boxNew, C) {
  const h = holder(C);
  const d = h.keep(d0, 'sd_d');
  const k = h.keep(k0, 'sd_k');
  const out = h.decl('sd_v', both, zeroLike(both));
  h.pre.push({
    kind: 'if',
    cond: call1('dhas', [d, k]),
    then: [{ kind: 'assign', target: out, value: boxHit(call1('dget', [d, k])) }],
    else_: [
      { kind: 'assign', target: out, value: boxNew(v) },
      { kind: 'builtin-stmt', name: 'dset', args: [d, k, out] },
    ],
  });
  return h.wrap(out);
}

/* ─── 串上按字符走的那几格（大小写、类别判断）───────────────────────────────── */

/** 这几串是**判类别**用的（方言里没有"码位"那一格，所以只能拿 `sfind` 在一串里找）。 */
const LOWERS = 'abcdefghijklmnopqrstuvwxyz';
const UPPERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SPACES = ' \t\n\r\u000b\f';

/** 一格字符在不在某一串里。 */
const inSet = (set, ch) => bin('!=', call1('sfind', [str(set), ch]), int(-1));

/**
 * `.title()` / `.capitalize()` / `.swapcase()` —— 逐格走，**只动 ASCII**。
 *
 * 与 `.upper()` / `.lower()` 同一条口径与同一处不足：非 ASCII 的大小写要借
 * `Objects/unicodeobject.c` 的映射表，在那之前只有 ASCII 那一档是对的。
 *
 * `.title()` 的边界是"**前一格不是字母**"（数字也算边界 —— `"a1b".title()` 是
 * `A1B`，拿 python3 比出来的）。
 */
export function caseMapOf(s0, mode, C) {
  const h = holder(C);
  const s = h.keep(s0, 'cm_s');
  const out = h.decl('cm_o', STR, str(''));
  const i = h.decl('cm_i', INT, int(0));
  const ch = h.decl('cm_c', STR, str(''));
  const add = (v) => ({ kind: 'assign', target: out, value: bin('+', out, v) });
  const body = [{ kind: 'assign', target: ch, value: call1('ssub', [s, i, int(1)]) }];
  if (mode === 'swapcase') {
    body.push({
      kind: 'if',
      cond: inSet(LOWERS, ch),
      then: [add(call1('supper', [ch]))],
      else_: [{
        kind: 'if', cond: inSet(UPPERS, ch), then: [add(call1('slower', [ch]))], else_: [add(ch)],
      }],
    });
  } else {
    const up = h.decl('cm_u', BOOL, { kind: 'bool', value: true });
    body.push({
      kind: 'if', cond: up, then: [add(call1('supper', [ch]))], else_: [add(call1('slower', [ch]))],
    });
    body.push({
      kind: 'assign',
      target: up,
      value: mode === 'title'
        ? { kind: 'unop', op: '!', operand: inSet(LOWERS + UPPERS, ch) }
        : { kind: 'bool', value: false },
    });
  }
  h.pre.push({ kind: 'while', cond: bin('<', i, call1('slen', [s])), body: [...body, inc(i)] });
  return h.wrap(out);
}

/**
 * `.isspace()` / `.isdigit()` / `.isalpha()` / `.isalnum()` / `.isupper()` / `.islower()`
 * —— 逐格走，**只认 ASCII**（同上一格的理由）。
 *
 * 两套规矩，别混：前四个是"**每一格都在那一类里**且串非空"；
 * `isupper` / `islower` 是"**有至少一格有大小写之分的、而且没有反着的那一格**"——
 * 所以 `"A1".isupper()` 是 True（数字不碍事），拿 python3 比出来的。
 */
export function charClassOf(s0, mode, C) {
  const CLASS = {
    isspace: SPACES, isdigit: DIGITS, isalpha: LOWERS + UPPERS, isalnum: LOWERS + UPPERS + DIGITS,
  };
  const h = holder(C);
  const s = h.keep(s0, 'cc_s');
  const i = h.decl('cc_i', INT, int(0));
  const ch = h.decl('cc_c', STR, str(''));
  const n = call1('slen', [s]);
  const step = [{ kind: 'assign', target: ch, value: call1('ssub', [s, i, int(1)]) }];
  if (CLASS[mode] !== undefined) {
    const ok = h.decl('cc_k', BOOL, bin('>', n, int(0)));
    h.pre.push({
      kind: 'while',
      cond: bin('&&', ok, bin('<', i, n)),
      body: [...step, {
        kind: 'if',
        cond: { kind: 'unop', op: '!', operand: inSet(CLASS[mode], ch) },
        then: [{ kind: 'assign', target: ok, value: { kind: 'bool', value: false } }],
        else_: null,
      }, inc(i)],
    });
    return h.wrap(ok);
  }
  const want = mode === 'isupper' ? UPPERS : LOWERS;
  const other = mode === 'isupper' ? LOWERS : UPPERS;
  const seen = h.decl('cc_s1', BOOL, { kind: 'bool', value: false });
  const bad = h.decl('cc_b', BOOL, { kind: 'bool', value: false });
  h.pre.push({
    kind: 'while',
    cond: bin('&&', { kind: 'unop', op: '!', operand: bad }, bin('<', i, n)),
    body: [...step, {
      kind: 'if',
      cond: inSet(other, ch),
      then: [{ kind: 'assign', target: bad, value: { kind: 'bool', value: true } }],
      else_: [{
        kind: 'if',
        cond: inSet(want, ch),
        then: [{ kind: 'assign', target: seen, value: { kind: 'bool', value: true } }],
        else_: null,
      }],
    }, inc(i)],
  });
  return h.wrap(bin('&&', seen, { kind: 'unop', op: '!', operand: bad }));
}

/** `s.rfind(p)` —— 从后往前找（方言的 `sfind` 只从前往后）。找不到交 -1。 */
export function rfindOf(s0, p0, C) {
  const h = holder(C);
  const s = h.keep(s0, 'rf_s');
  const p = h.keep(p0, 'rf_p');
  const lp = h.decl('rf_lp', INT, call1('slen', [p]));
  const at = h.decl('rf_at', INT, bin('-', call1('slen', [s]), lp));
  const out = h.decl('rf_o', INT, int(-1));
  h.pre.push({
    kind: 'while',
    cond: bin('&&', bin('==', out, int(-1)), bin('>=', at, int(0))),
    body: [
      {
        kind: 'if',
        cond: bin('==', call1('ssub', [s, at, lp]), p),
        then: [{ kind: 'assign', target: out, value: at }],
        else_: null,
      },
      { kind: 'assign', target: at, value: bin('-', at, int(1)) },
    ],
  });
  return h.wrap(out);
}

/** `xs.copy()` / `list(xs)` —— 抄一张新表出来。 */
export function copyList(xs0, C) {
  const h = holder(C);
  const xs = h.keep(xs0, 'cp2_x');
  const t = C.tyOfIR(xs);
  const out = h.decl('cp2_o', t, call1('anew', [{ kind: 'type', type: t }, int(0)]));
  const i = h.decl('cp2_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      { kind: 'builtin-stmt', name: 'apush', args: [out, { kind: 'index', obj: xs, index: i }] },
      inc(i),
    ],
  });
  return h.wrap(out);
}

/** `d.copy()` —— 抄一格新字典出来（走键表）。 */
export function copyDict(d0, C) {
  const h = holder(C);
  const d = h.keep(d0, 'cd_d');
  const t = C.tyOfIR(d);
  const out = h.decl('cd_o', t, call1('dnew', [{ kind: 'type', type: t }]));
  const ks = h.decl('cd_ks', arrOf(t.key), call1('dkeys', [d]));
  const i = h.decl('cd_i', INT, int(0));
  const k = { kind: 'index', obj: ks, index: i };
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [ks])),
    body: [
      { kind: 'builtin-stmt', name: 'dset', args: [out, k, call1('dget', [d, k])] },
      inc(i),
    ],
  });
  return h.wrap(out);
}

/** `list("abc")` —— 串拆成一格一个字符的表。 */
export function charsOf(s0, C) {
  const h = holder(C);
  const s = h.keep(s0, 'ch_s');
  const t = arrOf(STR);
  const out = h.decl('ch_o', t, call1('anew', [{ kind: 'type', type: t }, int(0)]));
  const i = h.decl('ch_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('slen', [s])),
    body: [
      { kind: 'builtin-stmt', name: 'apush', args: [out, call1('ssub', [s, i, int(1)])] },
      inc(i),
    ],
  });
  return h.wrap(out);
}

/** `dict(pairs)` —— 一串两格的元组造一格字典（键重了后一格盖前一格，与 python 同）。 */
export function dictOfPairs(ps0, kt, vt, C, mk) {
  const h = holder(C);
  const ps = h.keep(ps0, 'dp2_p');
  const t = mk(vt, kt);
  const out = h.decl('dp2_o', t, call1('dnew', [{ kind: 'type', type: t }]));
  const i = h.decl('dp2_i', INT, int(0));
  const at = { kind: 'index', obj: ps, index: i };
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [ps])),
    body: [
      {
        kind: 'builtin-stmt', name: 'dset',
        args: [out, { kind: 'field', obj: at, name: '_0' }, { kind: 'field', obj: at, name: '_1' }],
      },
      inc(i),
    ],
  });
  return h.wrap(out);
}

/* ─── 表上那几个"找"与"改"（`in` / index / count / insert / remove / …）─────── */

/**
 * `v in xs` —— 走一遍（方言的 `in` 只有字典与串两格）。
 *
 * `eq(a, b)` 由调用方给：元素可能是箱子，那时比法要按标签分派（`dyn.js` 的 `dynBin`）——
 * 那笔账不在这一份里。
 */
export function containsList(xs0, v0, C, eq) {
  const h = holder(C);
  const xs = h.keep(xs0, 'in_xs');
  const v = h.keep(v0, 'in_v');
  const r = h.decl('in_r', BOOL, { kind: 'bool', value: false });
  const i = h.decl('in_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      {
        kind: 'if',
        cond: eq({ kind: 'index', obj: xs, index: i }, v),
        then: [{ kind: 'assign', target: r, value: { kind: 'bool', value: true } }, { kind: 'break', label: null }],
        else_: null,
      },
      inc(i),
    ],
  });
  return h.wrap(r);
}

/** `xs.index(v)` —— 找不到在 python 里是 ValueError，这儿 `(fail …)`。 */
export function indexOfList(xs0, v0, C, eq) {
  const h = holder(C);
  const xs = h.keep(xs0, 'ix_xs');
  const v = h.keep(v0, 'ix_v');
  const at = h.decl('ix_at', INT, int(-1));
  const i = h.decl('ix_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      {
        kind: 'if',
        cond: eq({ kind: 'index', obj: xs, index: i }, v),
        then: [{ kind: 'assign', target: at, value: i }, { kind: 'break', label: null }],
        else_: null,
      },
      inc(i),
    ],
  });
  h.pre.push({
    kind: 'if',
    cond: bin('<', at, int(0)),
    then: [{ kind: 'builtin-stmt', name: 'fail', args: [str('list.index(x): x not in list')] }],
    else_: null,
  });
  return h.wrap(at);
}

/** `xs.count(v)` */
export function countList(xs0, v0, C, eq) {
  const h = holder(C);
  const xs = h.keep(xs0, 'ct_xs');
  const v = h.keep(v0, 'ct_v');
  const n = h.decl('ct_n', INT, int(0));
  const i = h.decl('ct_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      {
        kind: 'if',
        cond: eq({ kind: 'index', obj: xs, index: i }, v),
        then: [inc(n)],
        else_: null,
      },
      inc(i),
    ],
  });
  return h.wrap(n);
}

/** `xs.reverse()` —— 两头往中间换（**改原表**，不交值）。 */
export function reverseStmts(xs, C) {
  const h = holder(C);
  const a = h.decl('rv_a', INT, int(0));
  const b = h.decl('rv_b', INT, bin('-', call1('alen', [xs]), int(1)));
  const t = C.tyOfIR(xs).elem;
  const tmp = h.decl('rv_t', t, { kind: 'index', obj: xs, index: int(0) });
  h.pre.push({
    kind: 'while',
    cond: bin('<', a, b),
    body: [
      { kind: 'assign', target: tmp, value: { kind: 'index', obj: xs, index: a } },
      { kind: 'assign', target: { kind: 'index', obj: xs, index: a }, value: { kind: 'index', obj: xs, index: b } },
      { kind: 'assign', target: { kind: 'index', obj: xs, index: b }, value: tmp },
      inc(a),
      { kind: 'assign', target: b, value: bin('-', b, int(1)) },
    ],
  });
  return h.pre;
}

/** `xs.extend(ys)` —— 逐格追加。 */
export function extendStmts(xs, ys0, C, box) {
  const h = holder(C);
  const ys = h.keep(ys0, 'ex_ys');
  const i = h.decl('ex_i', INT, int(0));
  const one = { kind: 'index', obj: ys, index: i };
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [ys])),
    body: [
      { kind: 'builtin-stmt', name: 'apush', args: [xs, box === undefined ? one : box(one)] },
      inc(i),
    ],
  });
  return h.pre;
}

/** `xs.clear()` —— 方言里没有"截断"，所以一格一格弹（`apop` 是唯一的缩法）。 */
export function clearStmts(xs, C) {
  const h = holder(C);
  h.pre.push({
    kind: 'while',
    cond: bin('>', call1('alen', [xs]), int(0)),
    body: [{ kind: 'expr-stmt', expr: call1('apop', [xs]) }],
  });
  return h.pre;
}

/** `xs.insert(i, v)` —— 先长一格，再从尾往回挪，最后写进去。 */
export function insertStmts(xs, at0, v, C) {
  const h = holder(C);
  const at = h.keep(at0, 'is_at', INT);
  h.pre.push({ kind: 'builtin-stmt', name: 'apush', args: [xs, v] });
  const j = h.decl('is_j', INT, bin('-', call1('alen', [xs]), int(1)));
  /* python 的 `insert` 把下标**夹到 [0, len]**（超了就是追加），所以这儿也夹一次。 */
  const lo = h.decl('is_lo', INT, {
    kind: 'ternary', type: INT, cond: bin('<', at, int(0)), then: int(0), else_: at,
  });
  h.pre.push({
    kind: 'while',
    cond: bin('>', j, lo),
    body: [
      {
        kind: 'assign',
        target: { kind: 'index', obj: xs, index: j },
        value: { kind: 'index', obj: xs, index: bin('-', j, int(1)) },
      },
      { kind: 'assign', target: j, value: bin('-', j, int(1)) },
    ],
  });
  h.pre.push({
    kind: 'if',
    cond: bin('<', lo, call1('alen', [xs])),
    then: [{ kind: 'assign', target: { kind: 'index', obj: xs, index: lo }, value: v }],
    else_: null,
  });
  return h.pre;
}

/** 从第 `at` 格起往左挪一格、再弹掉尾巴（`remove` 与 `pop(i)` 共用）。 */
export function dropAtStmts(xs, at, C) {
  const h = holder(C);
  const j = h.decl('dr_j', INT, at);
  h.pre.push({
    kind: 'while',
    cond: bin('<', j, bin('-', call1('alen', [xs]), int(1))),
    body: [
      {
        kind: 'assign',
        target: { kind: 'index', obj: xs, index: j },
        value: { kind: 'index', obj: xs, index: bin('+', j, int(1)) },
      },
      inc(j),
    ],
  });
  h.pre.push({ kind: 'expr-stmt', expr: call1('apop', [xs]) });
  return h.pre;
}

/* ─── 串上那几格补宽度的 ───────────────────────────────────────────────────── */

/** `s.ljust(w[, ch])` / `s.rjust(w[, ch])` / `s.zfill(w)` —— 不够宽就补，够了原样。 */
export function justOf(s0, w0, ch, left, C) {
  const h = holder(C);
  const s = h.keep(s0, 'ju_s');
  const w = h.keep(w0, 'ju_w', INT);
  const fill = call1('srep', [ch, bin('-', w, call1('slen', [s]))]);
  return h.wrap(left ? bin('+', s, fill) : bin('+', fill, s));
}


/** `sep.join(xs)` —— 第一段前面不加分隔符。 */
export function joinOf(sep0, xs0, C) {
  const h = holder(C);
  const sep = h.keep(sep0, 'jn_s');
  const xs = h.keep(xs0, 'jn_xs');
  const t = C.tyOfIR(xs);
  if (t.kind !== 'arr' || t.elem.kind !== 'string') {
    throw new Error(`python->IR: \`.join()\` 收一格串的表（这里是 ${t.kind === 'arr' ? `arr<${t.elem.kind}>` : t.kind}）`);
  }
  const out = h.decl('jn_o', STR, str(''));
  const i = h.decl('jn_i', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      {
        kind: 'if',
        cond: bin('>', i, int(0)),
        then: [{ kind: 'assign', target: out, value: bin('+', out, sep) }],
        else_: null,
      },
      { kind: 'assign', target: out, value: bin('+', out, { kind: 'index', obj: xs, index: i }) },
      inc(i),
    ],
  });
  return h.wrap(out);
}

/**
 * `s.split(sep)` —— **分隔符不能是空串**（python 那边是 ValueError）。
 * 空段算一格（`"a,,b".split(",")` 是三格，`",".split(",")` 是两格空串）。
 */
export function splitOf(s0, sep0, C, maxsplit = null) {
  const h = holder(C);
  const s = h.keep(s0, 'sp_s');
  const sep = h.keep(sep0, 'sp_d');
  const t = arrOf(STR);
  const out = h.decl('sp_o', t, { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: t }, int(0)] });
  const at = h.decl('sp_at', INT, int(0));
  const hit = h.decl('sp_h', INT, int(0));
  const rest = h.decl('sp_r', STR, str(''));
  h.pre.push({
    kind: 'if',
    cond: bin('==', call1('slen', [sep]), int(0)),
    then: [{ kind: 'builtin-stmt', name: 'fail', args: [str('empty separator')] }],
    else_: null,
  });
  /* `maxsplit`：切够那么多次就把剩下的整段推进去（python 的规矩）。
     `maxsplit < 0` 是"不限"，与不给是一回事。 */
  const cut = maxsplit === null || maxsplit < 0 ? null : h.decl('sp_n', INT, int(0));
  h.pre.push({
    kind: 'while',
    cond: { kind: 'bool', value: true },
    body: [
      /* 剩下的那一段 */
      {
        kind: 'assign',
        target: rest,
        value: call1('ssub', [s, at, bin('-', call1('slen', [s]), at)]),
      },
      { kind: 'assign', target: hit, value: call1('sfind', [rest, sep]) },
      ...(cut === null ? [] : [{
        kind: 'if',
        cond: bin('>=', cut, int(maxsplit)),
        then: [{ kind: 'assign', target: hit, value: int(-1) }],
        else_: [{ kind: 'assign', target: cut, value: bin('+', cut, int(1)) }],
      }]),
      {
        kind: 'if',
        cond: bin('<', hit, int(0)),
        then: [
          { kind: 'builtin-stmt', name: 'apush', args: [out, rest] },
          { kind: 'break', label: null },
        ],
        else_: [
          { kind: 'builtin-stmt', name: 'apush', args: [out, call1('ssub', [rest, int(0), hit])] },
          { kind: 'assign', target: at, value: bin('+', bin('+', at, hit), call1('slen', [sep])) },
        ],
      },
    ],
  });
  return h.wrap(out);
}

/** `s.strip()` / `lstrip` / `rstrip` —— 去的是 python 那几个空白字符（`str.strip` 无参那一档）。 */
export function stripOf(s0, left, right, C, chars0 = null) {
  const h = holder(C);
  const s = h.keep(s0, 'tr_s');
  /* 要去掉的那几个字符：没给就是空白那一串（python 的默认）。 */
  const set = chars0 === null ? str(' \t\n\r\u000b\f') : h.keep(chars0, 'tr_cs', STR);
  const a = h.decl('tr_a', INT, int(0));
  const b = h.decl('tr_b', INT, call1('slen', [s]));
  const isWs = (i) => bin('!=', call1('sfind', [set, call1('ssub', [s, i, int(1)])]), int(-1));
  if (left) {
    h.pre.push({
      kind: 'while',
      cond: bin('&&', bin('<', a, b), isWs(a)),
      body: [inc(a)],
    });
  }
  if (right) {
    h.pre.push({
      kind: 'while',
      cond: bin('&&', bin('<', a, b), isWs(bin('-', b, int(1)))),
      body: [{ kind: 'assign', target: b, value: bin('-', b, int(1)) }],
    });
  }
  return h.wrap(call1('ssub', [s, a, bin('-', b, a)]));
}

/**
 * `s.split()` —— **不带分隔符**那一档，与带分隔符是两条规矩：按**连续空白**切，
 * 首尾的空段不算（`"  a b  c ".split()` 是三格，`" ".split(" ")` 是两格空串）。
 * 所以这儿不是"找分隔符"，是"走一遍，攒非空白的那几段"。
 */
export function splitWsOf(s0, C, maxsplit = null) {
  const h = holder(C);
  const s = h.keep(s0, 'sw_s');
  const t = arrOf(STR);
  const out = h.decl('sw_o', t, { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: t }, int(0)] });
  const ls = h.decl('sw_l', INT, call1('slen', [s]));
  const i = h.decl('sw_i', INT, int(0));
  const a = h.decl('sw_a', INT, int(0));
  const cut = maxsplit === null || maxsplit < 0 ? null : h.decl('sw_n', INT, int(0));
  const isWs = (at) => bin('!=', call1('sfind', [str(' \t\n\r\u000b\f'), call1('ssub', [s, at, int(1)])]), int(-1));
  h.pre.push({
    kind: 'while',
    cond: { kind: 'bool', value: true },
    body: [
      /* 先跳过空白 */
      { kind: 'while', cond: bin('&&', bin('<', i, ls), isWs(i)), body: [inc(i)] },
      { kind: 'if', cond: bin('>=', i, ls), then: [{ kind: 'break', label: null }], else_: null },
      /* 切够次数了：剩下的**整段**（含中间的空白）算最后一格 */
      ...(cut === null ? [] : [{
        kind: 'if',
        cond: bin('>=', cut, int(maxsplit)),
        then: [
          { kind: 'builtin-stmt', name: 'apush', args: [out, call1('ssub', [s, i, bin('-', ls, i)])] },
          { kind: 'break', label: null },
        ],
        else_: [{ kind: 'assign', target: cut, value: bin('+', cut, int(1)) }],
      }]),
      { kind: 'assign', target: a, value: i },
      {
        kind: 'while',
        cond: bin('&&', bin('<', i, ls), { kind: 'unop', op: '!', operand: isWs(i) }),
        body: [inc(i)],
      },
      { kind: 'builtin-stmt', name: 'apush', args: [out, call1('ssub', [s, a, bin('-', i, a)])] },
    ],
  });
  return h.wrap(out);
}

/**
 * `s.count(sub)` / `s.count(sub, start, end)` —— 数**不重叠**的那几段
 * （`"aaa".count("aa")` 是 1，不是 2）。空的那一段数的是"位置数"：
 * `"abc".count("")` 是 4。
 */
export function countOf(s0, sub0, C, start0 = null, end0 = null) {
  const h = holder(C);
  const s = h.keep(s0, 'ct_s');
  const sub = h.keep(sub0, 'ct_b');
  const ls = h.decl('ct_l', INT, call1('slen', [s]));
  const lb = h.decl('ct_n', INT, call1('slen', [sub]));
  /* start / end 按 python 的规矩折：负的加长度，再夹到 [0, len] 里。 */
  const clamp = (v) => {
    const x = h.decl('ct_x', INT, v);
    h.pre.push({
      kind: 'if',
      cond: bin('<', x, int(0)),
      then: [{ kind: 'assign', target: x, value: bin('+', x, ls) }],
      else_: null,
    });
    h.pre.push({
      kind: 'if',
      cond: bin('<', x, int(0)),
      then: [{ kind: 'assign', target: x, value: int(0) }],
      else_: [{
        kind: 'if',
        cond: bin('>', x, ls),
        then: [{ kind: 'assign', target: x, value: ls }],
        else_: null,
      }],
    });
    return x;
  };
  const lo = start0 === null ? int(0) : clamp(start0);
  const hi = end0 === null ? ls : clamp(end0);
  const cnt = h.decl('ct_c', INT, int(0));
  const i = h.decl('ct_i', INT, lo);
  h.pre.push({
    kind: 'if',
    cond: bin('==', lb, int(0)),
    /* 空段：位置数是 hi - lo + 1（`hi < lo` 时一格也没有）。 */
    then: [{
      kind: 'if',
      cond: bin('<', hi, lo),
      then: [{ kind: 'assign', target: cnt, value: int(0) }],
      else_: [{ kind: 'assign', target: cnt, value: bin('+', bin('-', hi, lo), int(1)) }],
    }],
    else_: [{
      kind: 'while',
      cond: bin('<=', i, bin('-', hi, lb)),
      body: [
        {
          kind: 'if',
          cond: bin('==', call1('ssub', [s, i, lb]), sub),
          then: [
            { kind: 'assign', target: cnt, value: bin('+', cnt, int(1)) },
            /* 不重叠：对上了就跳过整段 */
            { kind: 'assign', target: i, value: bin('+', i, lb) },
          ],
          else_: [inc(i)],
        },
      ],
    }],
  });
  return h.wrap(cnt);
}

/** `s.startswith(p)` / `s.endswith(p)` —— 比一段（方言里没有这一格算子）。 */
export function startsEndsOf(s0, p0, atStart, C) {
  const h = holder(C);
  const s = h.keep(s0, 'se_s');
  const p = h.keep(p0, 'se_p');
  const ls = call1('slen', [s]);
  const lp = call1('slen', [p]);
  const seg = call1('ssub', [s, atStart ? int(0) : bin('-', ls, lp), lp]);
  return h.wrap(bin('&&', bin('>=', ls, lp), bin('==', seg, p)));
}

/** `s.replace(a, b)` / `s.replace(a, b, n)` —— 换掉全部，或者只换前 n 处。 */
export function replaceOf(s0, a0, b0, C, count = null) {
  const h = holder(C);
  const s = h.keep(s0, 'rp_s');
  const from = h.keep(a0, 'rp_a');
  const to = h.keep(b0, 'rp_b');
  const out = h.decl('rp_o', STR, str(''));
  const at = h.decl('rp_at', INT, int(0));
  const hit = h.decl('rp_h', INT, int(0));
  const rest = h.decl('rp_r', STR, str(''));
  /* `count`：换够那么多处就把剩下的整段接上（与 `splitOf` 的 maxsplit 同一条办法）。
     负的是"不限"，与不给是一回事。 */
  const cap = count === null || count < 0 ? null : h.decl('rp_n', INT, int(0));
  h.pre.push({
    kind: 'if',
    cond: bin('==', call1('slen', [from]), int(0)),
    then: [{ kind: 'builtin-stmt', name: 'fail', args: [str('empty pattern in replace()')] }],
    else_: null,
  });
  h.pre.push({
    kind: 'while',
    cond: { kind: 'bool', value: true },
    body: [
      {
        kind: 'assign',
        target: rest,
        value: call1('ssub', [s, at, bin('-', call1('slen', [s]), at)]),
      },
      { kind: 'assign', target: hit, value: call1('sfind', [rest, from]) },
      ...(cap === null ? [] : [{
        kind: 'if',
        cond: bin('>=', cap, int(count)),
        then: [{ kind: 'assign', target: hit, value: int(-1) }],
        else_: [{ kind: 'assign', target: cap, value: bin('+', cap, int(1)) }],
      }]),
      {
        kind: 'if',
        cond: bin('<', hit, int(0)),
        then: [
          { kind: 'assign', target: out, value: bin('+', out, rest) },
          { kind: 'break', label: null },
        ],
        else_: [
          {
            kind: 'assign',
            target: out,
            value: bin('+', bin('+', out, call1('ssub', [rest, int(0), hit])), to),
          },
          { kind: 'assign', target: at, value: bin('+', bin('+', at, hit), call1('slen', [from])) },
        ],
      },
    ],
  });
  return h.wrap(out);
}

