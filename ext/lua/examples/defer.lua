-- ext/lua/examples/defer.lua —— 与 go / V / nim / CL / mojo / FB / cpp 那七份 defer **同一件事**
--
-- 期望输出逐行相同：in / b / a / out。
--
-- lua 的出口动作在**元表**里：`local g <close> = …` 出了作用域就调元表里的 `__close`。
-- 而"元表要不要一格新节点"这笔账量出来的答案是**不要** —— 元表是一格运行期的表，
-- 而"一格表 + 按键取值"图上本来就有（map 那四格）。于是这一行落的是三格现成的节点：
--   一格 map（那个对象）· 一格 map-set（把元表存进保留键 `__meta`）
--   · 一格 scope-exit（出口那一刻从元表里查出 `__close` 再调它）
-- 逆序（后声明的先关）与"`return` 早退也关"都是 scope-exit 那一格本来的语义。
--
-- 这一批只接"元表就写在这一行里"的形状（见 tograph.js 的 closeBind）：
-- `setmetatable` 出现在别处、元表是个变量、`__close` 从别的表继承来 —— 都当场报，
-- 因为那几种要"元表在运行期才知道"，那是 `__index` 那条链的事（另一笔账）。

local function demo()
  local a <close> = setmetatable({}, { __close = function(o, e) print("a") end })
  local b <close> = setmetatable({}, { __close = function(o, e) print("b") end })
  print("in")
  return
end

demo()
print("out")
