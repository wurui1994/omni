/* 第二份：同样有模块级的 `op` / `TAG` / `useOp`（与 alpha.js 撞），另外三格是遮蔽的陷阱。 */
export const TAG = 'beta';
export const op = 200;

export function useOp() {
  return op;
}

/** 局部遮住模块级那一格 */
export function localTrap() {
  const op = 5;
  return op;
}

/** catch 的形参也遮 —— 而它只遮 handler 那一段 */
export function catchTrap() {
  try {
    throw new Error('boom');
  } catch (op) {
    return String(op.message);
  }
}

/** for-of 那一格声明只在循环里算 */
export function loopTrap() {
  let s = 0;
  for (const op of [1, 2, 3]) s = s + op;
  return s;
}

/** 类里的字段名与方法名都不是模块级那个名字 */
export class Holder {
  constructor() {
    this.op = 9;
  }

  readOp() {
    return this.op + op;
  }
}
