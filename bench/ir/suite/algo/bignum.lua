-- 大数：用表当数位，算 2^2000 的十进制位数和
local d = {1}
for step = 1, 2000 do
  local carry = 0
  for i = 1, #d do
    local v = d[i] * 2 + carry
    d[i] = v % 10
    carry = (v - d[i]) / 10
  end
  while carry > 0 do
    d[#d + 1] = carry % 10
    carry = (carry - carry % 10) / 10
  end
end
local s = 0
for i = 1, #d do s = s + d[i] end
print(#d .. "," .. s)
