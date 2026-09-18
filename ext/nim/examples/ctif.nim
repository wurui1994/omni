## ext/nim/examples/ctif.nim —— **编译期分支**（`when`）：与 V 那一份同一族
##
## 期望输出：lin / notwin / both / flagoff。
##
## nim 与 V 差的只有写法（`when defined(x)` / `$if x`）—— 落到的是同一件事：
## 按**声明过的那张环境表**求值，走中的那一支摊开、没走的那一支整格丢掉
## （nim 明说没走的那支不要求编得过）。
##
## 两处归 nim 自己：
##   * 名字是 `defined(x)` 包着的（V 那边是裸名字）；
##   * **`when nimvm:` 那一格是 false** —— 它问的是"这会儿在编译期虚拟机里跑吗"，
##     而我们落的是运行期的图。这一格不是猜，是这一层的事实。

when defined(windows):
  echo "win"
elif defined(linux):
  echo "lin"
else:
  echo "other"

when not defined(windows):
  echo "notwin"

when defined(linux) and defined(cpu64):
  echo "both"

when nimvm:
  echo "vm"
else:
  echo "flagoff"
