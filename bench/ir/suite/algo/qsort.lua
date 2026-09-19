local a, n = {}, 100000
local seed = 42
for i = 1, n do
  seed = (seed * 1103515245 + 12345) % 2147483648
  a[i] = seed % 1000000
end
local function qs(lo, hi)
  if lo >= hi then return end
  local p = a[(lo + hi - (lo + hi) % 2) / 2]
  local i, j = lo, hi
  while i <= j do
    while a[i] < p do i = i + 1 end
    while a[j] > p do j = j - 1 end
    if i <= j then a[i], a[j] = a[j], a[i]; i = i + 1; j = j - 1 end
  end
  qs(lo, j)
  qs(i, hi)
end
qs(1, n)
local ok = 1
for i = 2, n do if a[i-1] > a[i] then ok = 0 end end
print(ok .. "," .. a[1] .. "," .. a[n])
