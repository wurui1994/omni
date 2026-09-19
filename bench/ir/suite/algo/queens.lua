-- N 皇后：回溯
local N = 11
local col, d1, d2 = {}, {}, {}
local count = 0
local function solve(r)
  if r > N then count = count + 1; return end
  for c = 1, N do
    local k1 = r + c
    local k2 = r - c + N
    if col[c] ~= 1 and d1[k1] ~= 1 and d2[k2] ~= 1 then
      col[c] = 1; d1[k1] = 1; d2[k2] = 1
      solve(r + 1)
      col[c] = 0; d1[k1] = 0; d2[k2] = 0
    end
  end
end
solve(1)
print(count)
