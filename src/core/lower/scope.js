// src/core/lower/scope.js —— 公共降级器的作用域栈（ADR-0044）
//
// 所有语言共用的作用域机制：进块 / 出块 / 声明 / 查找。
// 从 src/lang/jnc/emit-ctx.js 提取，去掉 jnc 特有的部分。

/**
 * 作用域栈。每一格 scope 是一层，查找从里到外。
 *
 * 用法：
 *   const s = new Scope();
 *   s.push();                           // 进块
 *   s.declare('x', { type: 'int' });    // 声明
 *   s.lookup('x');                       // 查找 → { type: 'int' }
 *   s.pop();                             // 出块
 */
export class Scope {
  constructor() {
    /** @type {Map<string, any>[]} */
    this.stack = [new Map()];  // 全局那一层
    this.depth = 0;
  }

  /** 进块（开一层新的作用域）。 */
  push() {
    this.stack.push(new Map());
    this.depth += 1;
  }

  /** 出块（丢掉最内层的作用域）。 */
  pop() {
    if (this.stack.length <= 1) throw new Error('scope: 不能 pop 全局那一层');
    this.stack.pop();
    this.depth -= 1;
  }

  /** 在当前层声明一个名字。 */
  declare(name, info) {
    this.stack[this.stack.length - 1].set(name, { ...info, depth: this.depth });
  }

  /** 从里到外查找一个名字。回 info 或 null。 */
  lookup(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const v = this.stack[i].get(name);
      if (v !== undefined) return v;
    }
    return null;
  }

  /** 当前层有没有这个名字（不往外层查）。 */
  has(name) {
    return this.stack[this.stack.length - 1].has(name);
  }

  /** 当前作用域深度。 */
  level() { return this.depth; }
}
