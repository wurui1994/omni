-- 闭包捕获与计数器
local function counter()
  local n = 0
  return function() n = n + 1; return n end
end
local c1, c2 = counter(), counter()
local s = 0
for i = 1, 200000 do s = s + c1() end
for i = 1, 100 do s = s + c2() end
print(s)
