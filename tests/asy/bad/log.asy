// 超越函数是**逐个**进运行库的，不是一次全收：`exp`/`sin`/`cos` 已经在
// stage0/lib/math.sx 里自己算了（走 tests/asy/tol/），`log` 还没写。
// 「还没写」和「不做」要分得开：绑定表 builtins.tab 里 log 这一行是 `nope`，
// 见到就报错，报错里说清是哪一个 —— 而不是偷偷转手宿主的 libm（那样 run 和 run-c
// 迟早逐字节对不上，量过 atan/tan/log 在最后一位就分叉）。
write(log(1.0));
