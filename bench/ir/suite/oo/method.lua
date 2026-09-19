-- 元表 + 方法分派
local Point = {}
Point.__index = Point
function Point.new(x, y)
  return setmetatable({ x = x, y = y }, Point)
end
function Point:norm2()
  return self.x * self.x + self.y * self.y
end
function Point:add(o)
  return Point.new(self.x + o.x, self.y + o.y)
end
local acc = 0
local p = Point.new(1, 2)
for i = 1, 200000 do
  local q = Point.new(i % 10, i % 7)
  acc = acc + p:add(q):norm2()
end
print(acc)
