local t = {}
for i = 1, 100000 do
  t[i] = i * 2
end
local s = 0
for i = 1, 100000 do
  s = s + t[i]
end
print(s)
