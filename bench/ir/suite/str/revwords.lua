-- 串切分与拼接
local words = {}
for i = 1, 5000 do words[i] = "w" .. (i % 97) end
local joined = ""
for i = 1, #words do joined = joined .. words[i] .. " " end
local cnt, acc = 0, 0
for i = 1, #joined do
  if joined:sub(i,i) == " " then cnt = cnt + 1 end
  acc = acc + 1
end
print(cnt .. "," .. acc)
