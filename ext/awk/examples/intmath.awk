# ext/awk/examples/intmath.awk —— 与 lua / go / V / nim / mojo 那几份 intmath **同一件事**
#
# 期望输出逐行相同：15 / 120。
# awk 没有声明（`acc = 0` 既是赋值也是"第一次出现"），映射会自己在这一段顶上补一串
# bind —— 那些 bind 落到 wasm 上就是函数级的局部量，正好对得上。

function sumto(n) {
  acc = 0
  for (i = 1; i <= n; i++) acc = acc + i
  return acc
}

function fact(n) {
  if (n == 0) return 1
  return n * fact(n - 1)
}

BEGIN {
  print sumto(5)
  print fact(5)
}
