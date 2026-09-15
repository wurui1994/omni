## ext/nim/examples/record.nim —— 与 go / lua / vlang 那三份 record 例子**同一件事**
##
## 期望输出逐行相同：1 / 5 / 6。
## 到这儿 record 那三格各有四门语言落在同一格上（G5 的"机器"线）。

type
  Point = object
    x: int
    y: int

var p = Point(x: 1, y: 2)
echo p.x
p.y = 5
echo p.y
echo p.x + p.y
