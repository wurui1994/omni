-- ext/lua/examples/unary.lua —— **一元那三格**（lua 与 awk 共一族）
--
-- 期望输出：-5 / 1 / 3。
--
-- 这一族是**判据自己找出来的**：`tests/graph/deadcase.js` 量到 lua 与 awk 两份映射里
-- 那格 `case 'un'` 是死代码 —— 两门的语法给一元算子**各自一条产生式**
-- （lua 是 `(neg …)` / `(not …)` / `(len …)`，awk 是 `(neg …)` / `(not …)`），
-- 没有一格带算符的 `un`。于是 `-x` / `not x` / `#s` 一格都落不成图，而例子里正好没有它们。
--
-- 三行落到的节点：`prim -`（一个实参就是取负）· `prim not` · `prim len`。
-- 第三行是"**写法归语言、格子归节点**"的又一例：lua 写 `#s`、awk 写 `length(s)`。

local function neg(n)
  return -n
end

local x = 5
print(neg(x))
if not (x > 9) then
  print(1)
else
  print(0)
end
local s = "abc"
print(#s)
