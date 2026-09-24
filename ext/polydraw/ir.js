// ext/polydraw/ir.js —— **把标准 IR 拼出来的那几格小工具**（EVAL 两门的设备层共用）
//
// 为什么单独一份：设备（`gfx-rt.js`）与 GL 立即模式（`gl-rt.js`）都是"生成出来的标准 IR"，
// 两份都要 `num` / `nm` / `bin` / `letR` / `whil` 这一小把东西。抄两份的下场是**两份会分叉**
// —— 而这一层最容易错的恰恰是那两三格约定（`let` 的初值字段叫 `init`、下标必须是 int、
// 语句位置的下标写要发 `assign`+`index`）。
//
// 这里**只有形状，没有语义**：类型对不对由公共 lower 与方言那一侧检查。

export const REAL = { kind: 'real' };
export const ARR = { kind: 'arr', elem: REAL };

export const num = (v) => ({ kind: 'real', value: String(v) });
export const str = (s) => ({ kind: 'string', value: s });
export const nm = (n) => ({ kind: 'name', name: n });
export const bin = (op, a, b) => ({ kind: 'binop', op, left: a, right: b });
export const un = (op, a) => ({ kind: 'unop', op, operand: a });
export const call = (n, args) => ({ kind: 'call', fn: nm(n), args });
export const bi = (name, args) => ({ kind: 'builtin', name, args });
export const rm = (fn, args) => ({ kind: 'rmath', fn, args });
export const tern = (c, a, b) => ({ kind: 'ternary', cond: c, then: a, else_: b });
export const set = (n, v) => ({ kind: 'assign', target: nm(n), value: v });
export const letR = (n, v) => ({ kind: 'let', name: n, type: REAL, init: v });
export const ret = (v) => ({ kind: 'return', values: v === undefined ? [] : [v] });
export const iff = (c, then, els = []) => ({ kind: 'if', cond: c, then, else_: els });
export const whil = (c, body) => ({ kind: 'while', cond: c, body });
export const ex = (e) => ({ kind: 'expr-stmt', expr: e });

/* real -> int：**发方言的 `toint`**。公共 lower 里 `{kind:'cast'}` 没钩子时是**原样透传**，
   于是下标仍是 real，方言那侧当场报"下标要是 int" —— 撞过一次。

   **两格不必绕这一趟**（2026-09-25，实时那一轴）：已经是 int 的表达式、与"取整数值的
   real 字面量"（`num(3)` 这种，下标里满地都是）直接给 int 字面量。`toint(3.0)` 与 `3`
   同值，可前者在 C 那条腿上落成一次真调用（`omni_trunc(3.0)`），而且它一出现，
   后面 `base + 3.0` 那一串就全在 double 上算。 */
const isIntLit = (e) => e !== null && e !== undefined && e.kind === 'int';
export const ix = (e) => {
  if (isIntLit(e)) return e;
  if (e !== null && e !== undefined && e.kind === 'real') {
    const v = Number(e.value);
    if (Number.isInteger(v)) return { kind: 'int', value: v };
  }
  return bi('toint', [e]);
};
export const aget = (a, i) => bi('aget', [nm(a), ix(i)]);
/** 语句位置的下标写。**不是** `builtin aset` —— 那一格是表达式。 */
export const aset = (a, i, v) => ({
  kind: 'assign', target: { kind: 'index', obj: nm(a), index: ix(i) }, value: v,
});
/** 一格新数组（长度也必须是 int）。 */
export const anew = (n) => bi('anew', [{ kind: 'type', type: ARR }, ix(n)]);

/* ── **下标那一路的 int 版**（2026-09-25，实时那一轴）。
 *
 * 语言的值只有 real 一种，所以 `a[i]` 每次都要 `toint` 一趟 —— 落到 C 上是
 * `omni_arr_f64_get(a, omni_trunc(base + 1.0))`。批那几格的下标其实是**整数**
 * （顶点号 × 16 + 槽号），所以基址存成一格 int 局部量，之后 `base + k` 全在整数上算，
 * 一趟 `toint` 都不剩。答案不变：`toint` 之后再加整数与先加再 `toint` 在这一段上同值
 * （两边都是精确整数，且远在 2^53 以内）。
 *
 * `INT` / `inum` / `letI` 是标准 IR 里本来就有的形状（`{kind:'int'}`），这门语言先前
 * 没用过而已。 */
export const INT = { kind: 'int' };
export const inum = (v) => ({ kind: 'int', value: v });
export const letI = (n, v) => ({ kind: 'let', name: n, type: INT, init: v });
/** 下标**已经是 int** 的读（不再套 `toint`）。 */
export const agetI = (a, i) => bi('aget', [nm(a), i]);
/** 下标已经是 int 的写（语句位置）。 */
export const asetI = (a, i, v) => ({
  kind: 'assign', target: { kind: 'index', obj: nm(a), index: i }, value: v,
});

/** 一格函数：形参与返回**一律 real**（EVAL 里只有这一种值）。 */
export const fn = (name, params, body) => ({
  kind: 'fn', name, params: params.map((p) => ({ name: p, type: REAL })), ret: REAL, body,
});
/**
 * 一格**形参里有数组**的函数（`[名字, 类型]` 一对一格）。
 *
 * 谁要它：纹理那一族（`glsettex(槽, buf, 宽, 高, 格)` —— `buf` 是一整块），
 * 与 adapter 里用户函数的数组形参同一条路（`(arr real)` 递的是那一块本身）。
 */
export const fnT = (name, params, body) => ({
  kind: 'fn', name, params: params.map(([n, t]) => ({ name: n, type: t ?? REAL })), ret: REAL, body,
});
/** 一格模块级的量。 */
export const glob = (name, type = REAL) => ({ kind: 'global', name, type });
