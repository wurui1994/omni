# ext/nim/examples/casefor.nim —— **`case` 与 `for … in`**（nim 独一份的家族）
#
# 期望输出：10 / 20 / 30 / 40 / 60 / 6。
#
# 两样都落到现成的格子上（branch 链 / `counted`）—— **一格新节点都没加**。
# nim 在这两处各有一条别人没有的：
#   * `case` 里除了 `of` 还能有 **`elif`** —— 那一支走**自己的条件**，不是"主语等于什么"。
#     go 的 switch 与 V 的 match 都没有这一格。
#   * `for i in 0 ..< 4` 的区间是**中缀算符**（`..<` 上界不含、`..` 含），在树上就是一格
#     `bin` —— 所以"这是区间还是集合"看的是那个算符，不是另一条产生式。
#
# `discard f()` 也在这儿：**算掉、把值扔了** —— 带作用的那一格（调用）留下。

proc label(n: int): int =
  var r = 0
  case n
  of 1:
    r = 10
  of 2, 3:
    r = 20
  elif n > 100:
    r = 40
  else:
    r = 30
  return r

proc main() =
  echo label(1)
  echo label(3)
  echo label(9)
  echo label(200)
  let xs = @[10, 20, 30]
  var s = 0
  for x in xs:
    s = s + x
  echo s
  var t = 0
  for i in 0 ..< 4:
    t = t + i
  echo t
  discard label(1)

main()
