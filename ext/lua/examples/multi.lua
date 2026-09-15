-- ext/lua/examples/multi.lua —— **多值**那一批节点的例子（第二个例子家族）
--
-- 期望输出（与 ext/go/examples/multi.go 逐行相同）：
--   3
--   7
--   1 2
--
-- 三行各压一格：
--   `return a, b`        -> values（多值的生产侧 —— **多出端口是常态**）
--   `local lo, hi = f()` -> 一格临时 bind + 一串 pick（消费侧，五门语言共用 destructure）
--   `print(f())`         -> 实参表里**只有最后一格展开**（arity 契约那一条）

local function minmax(a, b)
  if a < b then
    return a, b
  end
  return b, a
end

local lo, hi = minmax(7, 3)
print(lo)
print(hi)
print(minmax(1, 2))
