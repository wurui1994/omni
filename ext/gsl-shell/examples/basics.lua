-- ext/gsl-shell/examples/basics.lua —— 与另外十门的 basics.* **同一件事**
--
-- 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
--
-- 这一份的看点不是"又一门语言"，是**方言**：它与 ext/lua/examples/basics.lua 差的只有
-- 一处 —— `max2` 用 gsl-shell 的**短 lambda** 写（`|a, b| …`）。那一处就是这门方言
-- 存在的全部理由（量出来的：拿 lua 的语法过它那 186 份语料 139/186，栽在 `|` 的 41 份；
-- 加上那两条产生式 176/186，再叠上一格词法（LuaJIT 的 `1i`）186/186），
-- 也是这份例子的判据：把 gsl-shell.grammar 里那两条产生式删掉，这份例子当场过不去，
-- 而 ext/lua 那一份一个字不改照旧全绿（`tests/grammar/delete.js gsl-shell` 就是量这件事的）。
--
-- 短 lambda 落到的树与 `function` 逐格相同，所以映射一个字不改（见 ext/gsl-shell/tograph.js）。

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
  if n == 0 then return 1 end
  return n * fact(n - 1)
end

-- gsl-shell 的短 lambda：`|参数| 表达式`（lua 里没有这个写法）
local max2 = |a, b| (a > b) and a or b

print(sumto(5))
print(fact(5))
print(max2(3, 7))

do
  local tag = "ok"
  print(tag)
end
