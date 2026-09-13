local a, b = 1, 2
a, b = b, a
print(a) print(b)
local x, y, z = 1, 2, 3
z, y, x = x, y, z
print(x) print(y) print(z)
local p = 1
local ok = p < 2 and p > 0
print(ok)
local i = 0
local st = -1
for k = 3, 1, st do print(k) i = i + 1 end
print(i)
