-- ext/lua/examples/method.lua —— 与 nim / go / V / mojo 那四份 method **同一件事**
--
-- 期望输出逐行相同：3 / 9 / 3。
--
-- lua 这一门与另外四门差得最远：**方法不在声明里，在元表里**。
-- `p:total()` 要先看 `p` 自己有没有 `total`，没有才顺着 `__meta.__index` 那格表找 ——
-- 那是**真的运行期查表**。而查表这件事图上本来就有（map 那四格 + branch），所以：
--   `function Point:total()` -> map-set(Point, "total", func(self, …))
--   `p:total()`              -> call( branch(map-has(p,"total"), map-get(p,"total"),
--                                            map-get(map-get(map-get(p,"__meta"),"__index"),"total")),
--                                     [p] )
-- 一格新节点都没加，而"接收者是第一格实参"与另外四门**一字不差**。
--
-- 只顺一层 `__index`（`Point.__index = Point` 那个惯用法）；链式继承要循环，不在这一批。

local Point = {}
Point.__index = Point

function Point.new(x, y)
  local p = setmetatable({}, Point)
  p.x = x
  p.y = y
  return p
end

function Point:total()
  return self.x + self.y
end

function Point:scaled(k)
  return self:total() * k
end

local p = Point.new(1, 2)
print(p:total())
print(p:scaled(3))
print(p.x + p.y)
