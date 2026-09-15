-- ext/lua/examples/loopexit.lua —— **循环的早退**那一格（第六个例子家族）
--
-- 期望输出（家族里所有语言、所有后端逐行相同）：12 / 6 / 8。
--
-- Lua 只有 `break`（它的 continue 是 `goto`）—— 一格节点两个 kind，不是两格节点。
-- 第三行那一格压的是**步进与 continue 的关系**：`for j = 0, 4` 的步进落在
-- `loop` 的 `post` 端口上（不是缀在体的末尾）—— 别的语言在那儿放 continue 时
-- 步进必须照跑，这一份用"不加"的写法给出同一个数。

local s = 0
local i = 0
while true do
  i = i + 1
  if i > 5 then break end
  if i ~= 3 then s = s + i end
end
print(s)
print(i)

local t = 0
for j = 0, 4 do
  if j ~= 2 then t = t + j end
end
print(t)
