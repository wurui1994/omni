## ext/nim/examples/loopexit.nim —— 与 go / lua / V / mojo 那几份**同一件事**
##
## 期望输出逐行相同：12 / 6 / 8。
## Nim 只有 `while`（`for x in …` 是迭代器，不在这一批），所以第三段把步进
## 写在体的**开头** —— continue 那一格因此不需要 `post` 端口也对。

var s = 0
var i = 0
while true:
  i = i + 1
  if i > 5:
    break
  if i == 3:
    continue
  s = s + i
echo s
echo i

var t = 0
var j = -1
while j < 4:
  j = j + 1
  if j == 2:
    continue
  t = t + j
echo t
