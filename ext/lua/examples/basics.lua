-- ext/lua/examples/basics.lua —— 与 ext/chez/examples/basics.ss **同一件事**
--
-- 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
-- Lua 这一份多用一格 chez 用不上的节点：**loop**（while / for 都落它）——
-- Scheme 那边同一件事是递归，所以两份例子的图不一样、输出一样。
--
-- 要素对照：
--   local / local function  -> bind + func
--   while / for i = a, b    -> loop（`for` 是"region + loop + set"的形状，不给它开节点）
--   if / elseif / else      -> branch（两支是 lazy 端口）
--   return                  -> ret（may-early-exit 效应）
--   print                   -> prim print

local function sumto(n)
  local acc = 0
  local i = 1
  while i <= n do
    acc = acc + i
    i = i + 1
  end
  return acc
end

local function fact(n)
  if n == 0 then return 1 end
  return n * fact(n - 1)
end

local function max2(a, b)
  if a > b then
    return a
  else
    return b
  end
end

print(sumto(5))
print(fact(5))
print(max2(3, 7))

do
  local tag = "ok"
  print(tag)
end
