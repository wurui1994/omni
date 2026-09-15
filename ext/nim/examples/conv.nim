## ext/nim/examples/conv.nim —— 与 go / V / freebasic 那几份 conv **同一件事**
##
## 期望输出逐行相同：2 / 3.5。
## nim 的 `int(x)` / `float(x)` 也与调用同形 —— 与"对象构造 vs 命名实参"是同一笔账
## （要驱动器能回问"这名字登记成类型了吗"）。这一批按名字表判，记在映射的不足里。

echo int(7.0 / 3.0)
echo float(7) / 2
