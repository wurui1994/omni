-- 单链表：头插 + 遍历求和 + 反转
local head = nil
for i = 1, 200000 do head = { v = i, next = head } end
local s = 0
local p = head
while p ~= nil do s = s + p.v; p = p.next end
local prev = nil
p = head
while p ~= nil do
  local nx = p.next
  p.next = prev
  prev = p
  p = nx
end
local s2 = 0
p = prev
while p ~= nil do s2 = s2 + p.v; p = p.next end
print(s .. "," .. s2)
