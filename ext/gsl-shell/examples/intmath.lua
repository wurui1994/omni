-- ext/gsl-shell/examples/intmath.lua —— 第七个家族（**四条腿都跑得动的那个子集**）的 gsl-shell 一格
--
-- 期望输出（家族里所有语言、所有后端逐行相同）：15 / 120。
--
-- 与 ext/lua/examples/intmath.lua 差的只有一处：那个 `|x| x + 1`（gsl-shell 的短 lambda）。
-- 而它是**载重的**，不是摆设：120 是 `fact(4) * inc(4)` 算出来的（24 × 5），
-- 把 gsl-shell.grammar 里那两条产生式删掉，这一份当场过不去。
--
-- 为什么这一份也要有：这个家族是"图 -> 四个后端"全绿的那一格，
-- 所以它同时是"短 lambda 落到的树与 `function` 逐格相同"这句话在 **wat 那条腿上**的判据 ——
-- 映射与后端都一个字没加（ext/gsl-shell/tograph.js 就是 lua 那份）。

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

-- gsl-shell 的短 lambda：`|参数| 表达式`（lua 里没有这个写法）
local inc = |x| x + 1

print(sumto(5))
print(fact(4) * inc(4))
