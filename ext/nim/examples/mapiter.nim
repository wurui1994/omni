## ext/nim/examples/mapiter.nim —— 与 go / V 的 mapiter **同一件事**
##
## 期望输出逐行相同：a / b / c / 3 / 9。
## nim 的 `for k in t` 给的是键、`for k, v in t` 是键与值。

import tables

var m = initTable[string, int]()
m["a"] = 1
m["b"] = 3
m["c"] = 5
for k in m:
  echo k
var n = 0
for k in m:
  n = n + 1
echo n
var sum = 0
for k in m:
  sum = sum + m[k]
echo sum
