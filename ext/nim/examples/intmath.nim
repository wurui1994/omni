## ext/nim/examples/intmath.nim —— 与 lua / go / V 那几份 intmath **同一件事**
##
## 期望输出逐行相同：15 / 120。

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

echo sumto(5)
echo fact(5)
