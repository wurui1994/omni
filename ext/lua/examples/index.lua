-- ext/lua/examples/index.lua —— **列表与下标**那一批（第五个例子家族）
--
-- 期望输出（家族里所有语言、所有后端逐行相同）：10 / 30 / 45。
--
-- 这一份要说清一件事：**下标的起点是语言的事，不是节点的事**。
-- lua 从 1 起、go/V/nim 从 0 起，图上 `index-get` 一律按 0 起 ——
-- 差的那一格由 lua 自己的映射减掉（与"真值观由映射套一格 prim"同一条纪律）。

local xs = { 10, 20, 30 }
print(xs[1])
print(xs[3])
xs[2] = 5
local s = 0
for i = 1, 3 do
  s = s + xs[i]
end
print(s)
