## ext/nim/examples/index.nim —— 与 go / lua / vlang 那三份 index 例子**同一件事**
##
## 期望输出逐行相同：10 / 30 / 45。
## nim 的 `@[…]` 是 seq 的字面量 —— 与 go 的 `[]int{…}`、V 的 `[…]`、lua 的 `{…}`
## 落**同一格** list-new。

var xs = @[10, 20, 30]
echo xs[0]
echo xs[2]
xs[1] = 5
var s = 0
var i = 0
while i < 3:
  s = s + xs[i]
  i = i + 1
echo s
