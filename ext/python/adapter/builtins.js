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

/** `min(xs)` / `max(xs)` —— 空表在 python 里是 ValueError，这儿 `(fail …)`。 */
export function pickList(xs0, op, name, C) {
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
  h.pre.push({
    kind: 'while',
    cond: bin('<', i, call1('alen', [xs])),
    body: [
      {
        kind: 'if',
        cond: bin(op, { kind: 'index', obj: xs, index: i }, best),
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
export function sortedOf(xs0, C) {
  const h = holder(C);
  const xs = h.keep(xs0, 'st_xs');
  const t = C.tyOfIR(xs);
  if (t.kind !== 'arr') throw new Error('python->IR: `sorted()` 收一格表');
  if (!['int', 'real', 'string'].includes(t.elem.kind)) {
    throw new Error(`python->IR: \`sorted()\` 的元素是 ${t.elem.kind} —— 还没接（要有"怎么比"）`);
  }
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
        cond: bin('&&', bin('>=', k, int(0)), bin('>', { kind: 'index', obj: out, index: k }, cur)),
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
export function splitOf(s0, sep0, C) {
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
export function stripOf(s0, left, right, C) {
  const h = holder(C);
  const s = h.keep(s0, 'tr_s');
  const a = h.decl('tr_a', INT, int(0));
  const b = h.decl('tr_b', INT, call1('slen', [s]));
  const isWs = (i) => bin('!=', call1('sfind', [str(' \t\n\r\u000b\f'), call1('ssub', [s, i, int(1)])]), int(-1));
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

/** `s.replace(a, b)` —— 全部换掉（python 的 `count` 参数那一档还没接）。 */
export function replaceOf(s0, a0, b0, C) {
  const h = holder(C);
  const s = h.keep(s0, 'rp_s');
  const from = h.keep(a0, 'rp_a');
  const to = h.keep(b0, 'rp_b');
  const out = h.decl('rp_o', STR, str(''));
  const at = h.decl('rp_at', INT, int(0));
  const hit = h.decl('rp_h', INT, int(0));
  const rest = h.decl('rp_r', STR, str(''));
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

