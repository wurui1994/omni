// ext/lua/lang.js —— **Lua 这门语言**：把几张表装成一个 lang 对象
//
// `defineLang` / `extend` / 派生索引都在 SDK 那一侧（src/core/frontend-engine/language.js）。
// 这一份只说"Lua 是哪几张表"。方言（ext/gsl-shell、ext/luajit）在这上面加增量。

import { defineLang, extend, holesOf } from '../../src/core/frontend-engine/language.js';
import {
  LUA_KEYWORDS, LUA_OPS, LUA_PUNCT, LUA_UNARY_PREC, LUA_TOKENS,
} from './tokens.js';
import { LUA_NODES, LUA_CLASSES, LUA_SUBCLASS } from './nodes.js';
import { LUA_SCOPE, LUA_CTX } from './scope.js';
import { LUA_YIELDS } from './values.js';

export { defineLang, extend, holesOf };

/** Lua 本身。 */
export const luaLang = defineLang({
  name: 'lua',
  doc: 'Lua 5.1 / LuaJIT 2（含 goto/label）',
  keywords: LUA_KEYWORDS,
  ops: LUA_OPS,
  punct: LUA_PUNCT,
  unaryPrec: LUA_UNARY_PREC,
  classes: LUA_CLASSES,
  subclass: LUA_SUBCLASS,
  nodes: LUA_NODES,
  tokens: LUA_TOKENS,
  blockEnd: ['end', 'else', 'elseif', 'until'],
  scope: LUA_SCOPE,
  ctx: LUA_CTX,
  yields: LUA_YIELDS,
  // LuaJIT 的数字后缀。`1i`（虚数）先前被我当成了 gsl-shell 的扩展 —— 读了源码才知道**不是**：
  // 它在 `luajit2/src/lj_strscan.c:421-425`（`STRSCAN_IMAG`）与 `lj_lex.c:106,121`，
  // 是 LuaJIT 带 FFI 时的数字文法。于是这一格属于基语言，不属于方言增量。
  // 同一处注释列的其余后缀：`U`(u32) `LL`(i64) `ULL/LLU`(u64) `L` `UL/LU`。
  numSuffix: /^(?:i|[uU][lL][lL]|[lL][lL][uU]|[lL][lL]|[uU][lL]|[lL][uU]|[uU]|[lL])/,
});
