-- ext/lua/examples/intmath.lua —— **四条腿都跑得动的那个子集**（第七个例子家族）
--
-- 期望输出（家族里所有语言、所有后端逐行相同）：15 / 120。
--
-- 这一份是刻意"贫瘠"的：只有整数、函数、调用、语句位置的 if、while、打印一格整数。
-- 理由是量出来的（设计文档 §9）：wasm 那条腿现在**恰好**能接住这些 ——
-- 字符串要线性内存、表达式位置的 if 要 block 带 result、break 要 OIR 有带标签的跳转。
-- 所以这个家族是"图 -> 四个后端"第一次全绿的那一格。

local function sumto(n)
  local acc = 0
  local i = 1
  while i <= n do
    acc = acc + i
    i = i + 1
  end
  return acc
end

local function fact(n)
  if n == 0 then
    return 1
  end
  return n * fact(n - 1)
end

print(sumto(5))
print(fact(5))
