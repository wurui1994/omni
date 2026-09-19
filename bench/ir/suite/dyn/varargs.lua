-- 变长参数与多返回值
local function sum(...)
  local t = {...}
  local s = 0
  for i = 1, #t do s = s + t[i] end
  return s, #t
end
local total, cnt = 0, 0
for i = 1, 100000 do
  local a, b = sum(i, i + 1, i + 2, i + 3)
  total = total + a
  cnt = cnt + b
end
print(total .. "," .. cnt)
