-- 二叉堆：数组实现，插入 + 弹出
local h, n = {}, 0
local function push(v)
  n = n + 1
  h[n] = v
  local i = n
  while i > 1 do
    local p = (i - i % 2) / 2
    if h[p] <= h[i] then break end
    h[p], h[i] = h[i], h[p]
    i = p
  end
end
local function pop()
  local top = h[1]
  h[1] = h[n]
  h[n] = nil
  n = n - 1
  local i = 1
  while true do
    local l, r, m = 2 * i, 2 * i + 1, i
    if l <= n and h[l] < h[m] then m = l end
    if r <= n and h[r] < h[m] then m = r end
    if m == i then break end
    h[m], h[i] = h[i], h[m]
    i = m
  end
  return top
end
local seed = 12345
for i = 1, 50000 do
  seed = (seed * 1103515245 + 12345) % 2147483648
  push(seed % 100000)
end
local s = 0
for i = 1, 50000 do s = s + pop() end
print(s)
