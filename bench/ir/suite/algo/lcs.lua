-- 最长公共子序列：二维动态规划
local function mkstr(n, seed)
  local t = {}
  local s = seed
  for i = 1, n do
    s = (s * 1103515245 + 12345) % 2147483648
    t[i] = s % 4
  end
  return t
end
local A, B = mkstr(700, 1), mkstr(700, 7)
local dp = {}
for i = 0, #A do dp[i] = {}; for j = 0, #B do dp[i][j] = 0 end end
for i = 1, #A do
  for j = 1, #B do
    if A[i] == B[j] then dp[i][j] = dp[i-1][j-1] + 1
    else
      local u, l = dp[i-1][j], dp[i][j-1]
      if u > l then dp[i][j] = u else dp[i][j] = l end
    end
  end
end
print(dp[#A][#B])
