-- 图的广度优先：邻接表 + 队列
local N = 100000
local adj = {}
for i = 1, N do adj[i] = {} end
local seed = 99
for i = 1, N do
  for k = 1, 3 do
    seed = (seed * 1103515245 + 12345) % 2147483648
    local j = seed % N + 1
    adj[i][#adj[i] + 1] = j
  end
end
local dist = {}
for i = 1, N do dist[i] = -1 end
local q, qh, qt = {}, 1, 1
q[qt] = 1; qt = qt + 1; dist[1] = 0
local reached = 0
while qh < qt do
  local u = q[qh]; qh = qh + 1
  reached = reached + 1
  local lst = adj[u]
  for idx = 1, #lst do
    local v = lst[idx]
    if dist[v] < 0 then dist[v] = dist[u] + 1; q[qt] = v; qt = qt + 1 end
  end
end
print(reached)
