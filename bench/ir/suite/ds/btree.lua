-- 二叉树：建树 + 遍历（指针式结构、递归）
local function mk(depth)
  if depth <= 0 then return { l = nil, r = nil } end
  return { l = mk(depth - 1), r = mk(depth - 1) }
end
local function count(t)
  if t == nil then return 1 end
  return 1 + count(t.l) + count(t.r)
end
local total = 0
for i = 1, 40 do
  local t = mk(12)
  total = total + count(t)
end
print(total)
