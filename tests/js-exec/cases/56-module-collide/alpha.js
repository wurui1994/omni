/* 最底层的那一份：模块级的 `op` / `TAG` / `useOp` 与另外两份撞。
   `pick(op)` 那一格的形参与模块级 `op` 同名 —— 遮住了，改名不许动它。 */
export const TAG = 'alpha';
export const op = 100;

export function useOp() {
  return op;
}

/** 形参遮住模块级那一格：回的是**实参** + 1，不是 101 */
export function pick(op) {
  return op + 1;
}

/** 键与成员名不是名字：`{ op: 7 }` 的键、`o.op` 的成员都不许改 */
export function fieldish() {
  const o = { op: 7, tag: TAG };
  return o.op;
}

/** 简写要展开：`{ op }` -> `{ op: 改过的名字 }`，键留原样 */
export function shorthand() {
  const o = { op };
  return o.op;
}
