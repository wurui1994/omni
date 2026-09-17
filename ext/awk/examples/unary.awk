# ext/awk/examples/unary.awk —— 与 ext/lua/examples/unary.lua **同一件事**
#
# 期望输出逐行相同：-5 / 1 / 3。
#
# 这一族是 `tests/graph/deadcase.js` 找出来的：这份映射里那格 `case 'un'` 是死代码 ——
# awk 的语法给一元算子**各自一条产生式**（`(neg …)` / `(not …)`），没有带算符的 `un`。
#
# 第三行两门写法不同、节点相同：lua 写 `#s`、awk 写 `length(s)`，都落 `prim len`。
# 入口是 BEGIN（这一批不接隐式主循环 —— 见 basics.awk 的文件头）。

function neg(n) {
  return -n
}

BEGIN {
  x = 5
  print neg(x)
  if (!(x > 9)) {
    print 1
  } else {
    print 0
  }
  s = "abc"
  print length(s)
}
