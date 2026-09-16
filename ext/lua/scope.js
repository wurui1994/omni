// ext/lua/scope.js —— Lua 的**作用域配方**与**上下文规则**（走一遍的机器在 SDK 那侧）
//
// Lua 的全部作用域规矩就这五条配方（DESIGN.md 第 4 节），一条一行：
//
//   local            右边先算 -> `local x = x` 的右边是外层那个
//   local function   先绑名字再算体（递归要它）
//   funcbody         形参绑在函数那一层
//   for-num/for-in   循环变量只在体里
//   repeat           `until` 看得见 body 里的 local —— Lua 里唯一的"块作用域漏一格"
//
// CTX 那三条是尺子逼出来的：`break` 要循环、`...` 要变长参数、`goto` 要标签。

// 转手 SDK 那一格要**先导入再导出**（`export … from …` 我们自己的 JS 前端不收，
// 见 frontend-js/link.js 的头几行）。
import { bind } from '../../src/core/frontend-engine/bind.js';

export { bind };

/** 每个节点的配方。只有这九个节点有话说，其余按 `syn` 次序走。 */
export const LUA_SCOPE = {
  block: { steps: ['open', 'stats'] },
  funcbody: { steps: ['open', 'bind:names', 'body'] },
  local: { steps: ['init', 'bind:names'] },
  'local-function': { steps: ['bind:names', 'body'] },
  'for-num': { steps: ['from', 'to', 'step', 'open', 'bind:names', 'body'] },
  'for-in': { steps: ['exprs', 'open', 'bind:names', 'body'] },
  repeat: { steps: ['open', 'inline:body', 'cond'] },
  // `function a.b:m()` 的隐形形参 self —— Lua 的 `:` 就是糖，这一格记它是糖的代价。
  function: { steps: ['path', 'body'], selfIn: 'body' },
  // gsl-shell 的 `|x| e` 与 funcbody 同形（形参绑在自己那一层，体是一格表达式）。
  lambda: { steps: ['open', 'bind:names', 'body'] },
};

/**
 * 上下文规则（第二类"位置"约束）。`provides` / `blocks` / `needs` / `declares` / `needsLabel`
 * 全是数据 —— 写在这儿，不写在检查器的分支里。
 */
export const LUA_CTX = {
  while: { provides: 'loop' },
  repeat: { provides: 'loop' },
  'for-num': { provides: 'loop' },
  'for-in': { provides: 'loop' },
  // 函数体挡住 loop，也挡住 vararg —— 除非它自己的形参表里有 `...`（那它自己提供）。
  funcbody: { blocks: ['loop', 'vararg'], provides: (n) => ((n.names ?? []).includes('...') ? 'vararg' : null) },
  lambda: { blocks: ['loop', 'vararg'], provides: (n) => ((n.names ?? []).includes('...') ? 'vararg' : null) },
  break: { needs: 'loop', say: '这儿没有循环可 break' },
  // `...` 只能出现在变长参数的函数里（主 chunk 本身就是变长的，Lua 5.1 手册 §2.5.9）。
  // 这一条是 `--luajit` 那把尺子逼出来的：`|| -> ...` 我先前收，luajit 说
  // `cannot use '...' outside a vararg function`。
  vararg: { needs: 'vararg', say: "这个函数没有 `...` 形参，用不了 `...`" },
  label: { declares: 'label' },
  goto: { needsLabel: true },
};
