## ext/nim/examples/basics.nim —— 与前八门那几份**同一件事**
##
## 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
## Nim 这一份压两样别的语言没有的形状，而且两样都**不新增节点**：
##   * **命令式调用**（`echo sumto(5)` 不带括号）—— 树上与 `f(x)` 是两条产生式，
##     图上是同一格（语法的形状 ≠ 节点的格数）。
##   * **`var` 段**（一行声明好几格）—— 一串 bind。
##
## 要素对照：
##   proc + 形参表    -> bind + func（类型与 pragma 丢掉）
##   var a = …        -> bind
##   a = …            -> set
##   while            -> loop
##   if / else        -> branch
##   return           -> ret
##   echo             -> prim print

proc sumto(n: int): int =
  var acc = 0
  var i = 1
  while i <= n:
    acc = acc + i
    i = i + 1
  return acc

proc fact(n: int): int =
  if n == 0:
    return 1
  return n * fact(n - 1)

proc max2(a: int, b: int): int =
  if a > b:
    return a
  else:
    return b

echo sumto(5)
echo fact(5)
echo max2(3, 7)

var tag = "ok"
echo tag
