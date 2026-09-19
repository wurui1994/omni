local N = 120
local a, b, c = {}, {}, {}
for i = 1, N do
  a[i] = {}
  b[i] = {}
  c[i] = {}
  for j = 1, N do
    a[i][j] = i + j
    b[i][j] = i - j
    c[i][j] = 0
  end
end
for i = 1, N do
  for j = 1, N do
    local s = 0
    for k = 1, N do
      s = s + a[i][k] * b[k][j]
    end
    c[i][j] = s
  end
end
print(c[N][N])
