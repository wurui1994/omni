// ext/go/adapter/stdlib.js —— **包限定的那几格**（`math.Sqrt` / `time.Second` / `strings.Index`）
//
// 三条路，按这个次序：
//   1. **`math` 是内建的**（没有桩）：方言里本来就有 `(rmath "sqrt" …)`，所以直接落那一格。
//      `Max` / `Min` / `Modf` 没有对应的 rmath —— 生成一格 go 级的辅助函数（不用条件表达式：
//      那会把实参复制一遍，`math.Max(f(), g())` 于是变成四次调用）。
//   2. **桩里的常量与函数**（`--pkgs` 读进来的那几份）：名字是**平的**（所有包摊进一个
//      名字空间），所以 `strings.Index` 就是 `Index`、`time.Second` 就是 `Second`。
//   3. 都不认就**当场报**（不猜）。

import { REAL, INT } from '../../../src/core/lower/ty-of.js';

/** `math.F` → 方言的 `(rmath "f" …)`（名单是 `SX_ARITY.rmath` 那一格认的）。 */
export const MATH_RMATH = new Map([
  ['Sqrt', 'sqrt'], ['Abs', 'fabs'], ['Floor', 'floor'], ['Ceil', 'ceil'], ['Round', 'round'],
  ['Pow', 'pow'], ['Mod', 'fmod'], ['Hypot', 'hypot'], ['Atan2', 'atan2'],
  ['Sin', 'sin'], ['Cos', 'cos'], ['Tan', 'tan'],
  ['Asin', 'asin'], ['Acos', 'acos'], ['Atan', 'atan'],
  ['Sinh', 'sinh'], ['Cosh', 'cosh'], ['Tanh', 'tanh'],
  ['Exp', 'exp'], ['Log', 'log'], ['Log10', 'log10'], ['Log1p', 'log1p'], ['Cbrt', 'cbrt'],
]);

/** `math` 里那几格常量。 */
export const MATH_CONSTS = new Map([
  ['Pi', { kind: 'real', value: Math.PI }],
  ['E', { kind: 'real', value: Math.E }],
  ['Sqrt2', { kind: 'real', value: Math.SQRT2 }],
  ['Ln2', { kind: 'real', value: Math.LN2 }],
  ['MaxFloat64', { kind: 'real', value: 1.7976931348623157e308 }],
  ['SmallestNonzeroFloat64', { kind: 'real', value: 5e-324 }],
  ['MaxInt32', { kind: 'int', value: 2147483647 }],
  ['MinInt32', { kind: 'int', value: -2147483648 }],
  ['MaxInt64', { kind: 'int', value: 9223372036854775807n }],
  ['MinInt64', { kind: 'int', value: -9223372036854775808n }],
  ['MaxUint32', { kind: 'int', value: 4294967295 }],
]);

/** `math.X` 当值用（`p := math.Pi`）。认不出回 null。 */
export function mathConst(name) {
  return MATH_CONSTS.get(name) ?? null;
}

/** `math.F(…)`。认不出回 null（那就落到桩那条路上）。 */
export function mathCall(name, rawArgs, C) {
  const rm = MATH_RMATH.get(name);
  if (rm !== undefined) {
    return { kind: 'rmath', fn: rm, args: rawArgs.map((a) => C.valueOf(a, REAL)) };
  }
  if (name === 'Max' || name === 'Min') {
    return {
      kind: 'call',
      fn: { kind: 'name', name: ensurePick(name, C) },
      args: rawArgs.map((a) => C.valueOf(a, REAL)),
    };
  }
  if (name === 'Modf') {
    return {
      kind: 'call',
      fn: { kind: 'name', name: ensureModf(C) },
      args: rawArgs.map((a) => C.valueOf(a, REAL)),
    };
  }
  if (name === 'Inf') {
    /* `math.Inf(1)` / `math.Inf(-1)` —— 用 1/0 造（方言里没有 inf 字面量）。 */
    const sign = rawArgs.length > 0 ? C.valueOf(rawArgs[0], INT) : { kind: 'int', value: 1 };
    return {
      kind: 'binop',
      op: '/',
      left: {
        kind: 'if-expr',
        type: REAL,
        cond: { kind: 'binop', op: '<', left: sign, right: { kind: 'int', value: 0 } },
        then: { kind: 'real', value: -1 },
        else_: { kind: 'real', value: 1 },
      },
      right: { kind: 'real', value: 0 },
    };
  }
  return null;
}

/**
 * **宿主入口那几格**（`src/lib/go/omnihost/omnihost.go` 里**没有体**的那些）。
 * 体在 `libomnigo`（`src/runtime-sched/omni_go.c`）里 —— 调用点落成一格 `(ccall …)`。
 * 这张表只管"这个名字落哪个 C 符号、签名是什么"。
 */
export const HOST_FNS = new Map([
  ['Nanotime', { sym: 'omni_go_nanotime', ret: 'i64', ps: [] }],
  ['NumCPU', { sym: 'omni_go_numcpu', ret: 'i64', ps: [] }],
  ['PathReset', { sym: 'omni_go_path_reset', ret: 'void', ps: [] }],
  ['PathPush', { sym: 'omni_go_path_push', ret: 'void', ps: ['i64'] }],
  ['Open', { sym: 'omni_go_open', ret: 'i64', ps: ['i64'] }],
  ['Write', { sym: 'omni_go_write', ret: 'void', ps: ['i64', 'i64'] }],
  ['Read', { sym: 'omni_go_read', ret: 'i64', ps: ['i64'] }],
  ['Close', { sym: 'omni_go_close', ret: 'void', ps: ['i64'] }],
  ['Out', { sym: 'omni_go_out', ret: 'void', ps: ['i64'] }],
]);

/** 一格宿主调用（认不出回 null）。 */
export function hostCall(name, args, C) {
  const d = HOST_FNS.get(name);
  if (d === undefined) return null;
  C.needC(d.sym, d.ret, d.ps);
  return {
    kind: 'ccall', sym: d.sym, args, type: d.ret === 'void' ? { kind: 'void' } : INT,
  };
}

/** `__goMath_Max` / `__goMath_Min`（两个实参各算一次 —— 不用条件表达式复制它们）。 */
function ensurePick(which, C) {
  const name = `__goMath_${which}`;
  if (C.fns.has(name)) return name;
  const params = [{ name: 'a', type: REAL }, { name: 'b', type: REAL }];
  C.fns.set(name, { params, ret: REAL, results: [{ name: null, type: REAL }] });
  const nm = (n) => ({ kind: 'name', name: n });
  C.decls.push({
    kind: 'fn',
    name,
    params,
    ret: REAL,
    body: [
      {
        kind: 'if',
        cond: { kind: 'binop', op: which === 'Max' ? '>' : '<', left: nm('a'), right: nm('b') },
        then: [{ kind: 'return', values: [nm('a')] }],
        else_: null,
      },
      { kind: 'return', values: [nm('b')] },
    ],
  });
  return name;
}

/** `__goMath_Modf`：整数那一半**往零截断**（go 的规矩），小数那一半是差。 */
function ensureModf(C) {
  const name = '__goMath_Modf';
  if (C.fns.has(name)) return name;
  const params = [{ name: 'x', type: REAL }];
  const ret = C.mvType([REAL, REAL]);
  C.fns.set(name, { params, ret, results: [{ name: null, type: ret }] });
  const nm = (n) => ({ kind: 'name', name: n });
  C.decls.push({
    kind: 'fn',
    name,
    params,
    ret,
    body: [
      {
        kind: 'let',
        name: 'ip',
        type: REAL,
        init: { kind: 'builtin', name: 'toreal', args: [{ kind: 'builtin', name: 'toint', args: [nm('x')] }] },
      },
      {
        kind: 'return',
        values: [{
          kind: 'new-record',
          type: ret,
          ref: false,
          fields: [
            { name: 'v0', value: nm('ip') },
            { name: 'v1', value: { kind: 'binop', op: '-', left: nm('x'), right: nm('ip') } },
          ],
        }],
      },
    ],
  });
  return name;
}
