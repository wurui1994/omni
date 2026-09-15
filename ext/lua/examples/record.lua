-- ext/lua/examples/record.lua —— 与 ext/go/examples/record.go **同一件事**
--
-- 期望输出逐行相同：1 / 5 / 6。
-- Lua 没有 struct 声明，表就是记录 —— 于是这一份正好证明 record 那三格
-- **不依赖类型**（"删光所有类型，record 还是一格有 0 个字段的存储"，附录 A 那句话）。

local p = { x = 1, y = 2 }
print(p.x)
p.y = 5
print(p.y)
print(p.x + p.y)
