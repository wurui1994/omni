local W, H, MAX = 300, 300, 100
local count = 0
for py = 0, H - 1 do
  local y0 = py / H * 2.0 - 1.0
  for px = 0, W - 1 do
    local x0 = px / W * 3.0 - 2.0
    local x, y, i = 0.0, 0.0, 0
    while i < MAX do
      local x2 = x * x
      local y2 = y * y
      if x2 + y2 > 4.0 then break end
      y = 2.0 * x * y + y0
      x = x2 - y2 + x0
      i = i + 1
    end
    if i == MAX then count = count + 1 end
  end
end
print(count)
