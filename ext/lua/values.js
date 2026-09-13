// ext/lua/values.js —— Lua 的**元数表**（契约那台机器在 SDK 的 arity.js）
//
// 四条规则里只有这一张三行的表是 Lua 自己的；另两条（列表只有最后一格展开、
// 非列表的洞截成一格）是普适的，写在 SDK 那侧，一格数据都不用给。

export { yieldsOf, listShape, arity, predict } from '../../src/core/frontend-engine/arity.js';

/** 元数表。三行说"谁产生多值"，一行说"谁把多值掐断"。 */
export const LUA_YIELDS = {
  call: 'multi',
  'method-call': 'multi',
  vararg: 'multi',
  paren: 1,          // `(f())` 只有一格 —— Lua 里唯一"括号有语义"的地方
  lambda: 1,         // gsl-shell 的 `|x| e`：它是个函数值，一格
};
