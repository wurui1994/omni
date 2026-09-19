local N = 2000000
local f = {}
for i = 2, N do f[i] = 1 end
local count = 0
for i = 2, N do
  if f[i] == 1 then
    count = count + 1
    local j = i + i
    while j <= N do
      f[j] = 0
      j = j + i
    end
  end
end
print(count)
