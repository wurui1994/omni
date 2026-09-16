# ext/awk/examples/loopexit.awk —— 与 go / lua / V / nim / mojo / cpp 那几份**同一件事**
#
# 期望输出逐行相同：12 / 6 / 8。
# `break` / `continue` 落**同一格节点**（差的只有一格附属 kind）—— awk 的写法与 C 一样。
# 第二个循环压的是 **continue 与步进的关系**：`j++` 在 `loop` 的 `post` 端口上，
# `continue` 跳过体的剩下部分却**照跑步进**（缀在体末尾的写法在这儿会死循环）。
# awk 没有声明，未赋值的量当 0 —— 映射会自己在这一段顶上补 bind。

BEGIN {
  s = 0
  i = 0
  while (1) {
    i = i + 1
    if (i > 5) break
    if (i == 3) continue
    s = s + i
  }
  print s
  print i

  t = 0
  for (j = 0; j < 5; j++) {
    if (j == 2) continue
    t = t + j
  }
  print t
}
