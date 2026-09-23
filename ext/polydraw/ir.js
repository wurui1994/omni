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
   于是下标仍是 real，方言那侧当场报"下标要是 int" —— 撞过一次。 */
export const ix = (e) => bi('toint', [e]);
export const aget = (a, i) => bi('aget', [nm(a), ix(i)]);
/** 语句位置的下标写。**不是** `builtin aset` —— 那一格是表达式。 */
export const aset = (a, i, v) => ({
  kind: 'assign', target: { kind: 'index', obj: nm(a), index: ix(i) }, value: v,
});
/** 一格新数组（长度也必须是 int）。 */
export const anew = (n) => bi('anew', [{ kind: 'type', type: ARR }, ix(n)]);

/** 一格函数：形参与返回**一律 real**（EVAL 里只有这一种值）。 */
export const fn = (name, params, body) => ({
  kind: 'fn', name, params: params.map((p) => ({ name: p, type: REAL })), ret: REAL, body,
});
/** 一格模块级的量。 */
export const glob = (name, type = REAL) => ({ kind: 'global', name, type });
