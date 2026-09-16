## ext/nim/examples/method.nim —— **方法那一族**（第十六个例子家族）
##
## 期望输出（家族里所有语言、所有后端逐行相同）：3 / 9 / 3。
##
## 这一族钉住的是一句话：**方法不是一格新节点**。
##   `p.total()` 与 `total(p)` 在 nim 里是同一件事（UFCS），所以图上就该是同一张图 ——
##   最后那行 `echo total(p)` 印的和第一行一样，正是这件事的判据。
## 方法名从**声明**来（扫一遍 proc 就有那张表），接收者只是**第一格实参**。

type
  Point = object
    x: int
    y: int

proc total(p: Point): int =
  return p.x + p.y

proc scaled(p: Point, k: int): int =
  return total(p) * k

var p = Point(x: 1, y: 2)
echo p.total()
echo p.scaled(3)
echo total(p)
