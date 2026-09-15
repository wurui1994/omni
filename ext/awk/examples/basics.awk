# ext/awk/examples/basics.awk —— 与前五门那几份**同一件事**
#
# 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
# awk 这一份形状差得最远，压的是两样别的语言压不到的：
#   * **没有声明**：`acc = 0` 既是赋值也是"第一次出现"，函数里除了形参没有局部量。
#     图上 `set` 要求名字绑过 —— 所以映射自己扫一遍被赋值的名字，在 region 顶上补 bind。
#   * **入口是 BEGIN**：这一批不接隐式主循环（record-loop 是 awk 私有的节点，
#     `ext/awk/SPEC.md` §3.2 说了它为什么放在 ext/awk 底下），所以只收 BEGIN。
#
# 要素对照：
#   function + 形参表        -> bind + func（形参之外的名字由映射补 bind）
#   for (init; cond; post)   -> region + loop + set
#   i++                      -> set + binop
#   if / else                -> branch
#   return                   -> ret
#   print                    -> prim print

function sumto(n) {
  acc = 0
  for (i = 1; i <= n; i++) {
    acc = acc + i
  }
  return acc
}

function fact(n) {
  if (n == 0) {
    return 1
  }
  return n * fact(n - 1)
}

function max2(a, b) {
  if (a > b) {
    return a
  } else {
    return b
  }
}

BEGIN {
  print sumto(5)
  print fact(5)
  print max2(3, 7)
  tag = "ok"
  print tag
}
