-- 哈希表：字符串键的插入与查找
local t = {}
for i = 1, 20000 do t["k" .. i] = i * 2 end
local s = 0
for i = 1, 20000 do s = s + t["k" .. i] end
print(s)
