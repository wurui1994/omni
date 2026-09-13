local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end
local s = 0
for i = 1, 10 do
  s = s + fib(i)
end
print(s)
local k = 5
while k > 0 do
  k = k - 1
  if k == 2 then break end
end
print(k)
local q = 0
repeat
  local step = 3
  q = q + step
until q > 8
print(q)
for j = 10, 1, -2 do print(j) end
print(2 ^ 10)
print(7 % 3)
print(1 < 2)
print("hi")
