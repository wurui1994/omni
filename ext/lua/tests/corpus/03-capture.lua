local total = 0
local step = 2
local function bump(x)
  total = total + x * step
  return total
end
print(bump(1))
print(bump(3))
print(total)
local msg = "n="
local function show()
  print(msg)
end
show()
