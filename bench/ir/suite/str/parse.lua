-- 手写词法器：数一段源码里的记号（串遍历 + 状态机）
local src = ""
for i = 1, 2000 do src = src .. "local x" .. i .. " = " .. i .. " + 1 ; " end
local n = #src
local i = 1
local toks = 0
while i <= n do
  local c = src:sub(i, i)
  if c == " " then i = i + 1
  elseif c >= "0" and c <= "9" then
    while i <= n do local d = src:sub(i,i); if d >= "0" and d <= "9" then i = i + 1 else break end end
    toks = toks + 1
  elseif (c >= "a" and c <= "z") or (c >= "A" and c <= "Z") or c == "_" then
    while i <= n do
      local d = src:sub(i,i)
      if (d >= "a" and d <= "z") or (d >= "A" and d <= "Z") or (d >= "0" and d <= "9") or d == "_" then i = i + 1 else break end
    end
    toks = toks + 1
  else i = i + 1; toks = toks + 1 end
end
print(toks)
