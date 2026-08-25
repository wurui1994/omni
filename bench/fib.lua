-- 与 bench/fib.omni 等价的 LuaJIT 版本（整数语义靠 math.floor 保证）
local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end

local function sumTo(n)
  local acc = 0
  for i = 1, n do acc = acc + (i * i) % 1000003 end
  return acc
end

print(fib(27))
print(sumTo(2000000))
