-- 协程：生成器
local function gen(n)
  return coroutine.wrap(function()
    for i = 1, n do coroutine.yield(i * i) end
  end)
end
local s = 0
local g = gen(200000)
for v in g do s = s + v end
print(s)
