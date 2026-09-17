# 环：ring1 引 ring2、ring2 又引 ring1。**不许挂死**（读过的不再读）——
# nim 与 go 里互相 import 都是合法的，所以这一格是判据，不是错。
import ring2

proc one(): int =
  return 1

echo one() + two()
