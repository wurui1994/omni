-- map / filter / reduce
local function map(t, f)
  local r = {}
  for i = 1, #t do r[i] = f(t[i]) end
  return r
end
local function filter(t, f)
  local r, n = {}, 0
  for i = 1, #t do if f(t[i]) then n = n + 1; r[n] = t[i] end end
  return r
end
local function reduce(t, f, init)
  local acc = init
  for i = 1, #t do acc = f(acc, t[i]) end
  return acc
end
local a = {}
for i = 1, 100000 do a[i] = i end
local b = map(a, function(x) return x * 2 end)
local c = filter(b, function(x) return x % 3 == 0 end)
local s = reduce(c, function(p, q) return p + q end, 0)
print(s)
