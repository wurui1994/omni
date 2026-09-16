## ext/nim/examples/dict.nim —— 与 go / V / awk 那三份 dict **同一件事**
##
## 期望输出逐行相同：1 / 3 / 4 / yes。
## 到这儿 map 那四格有**四个提供者**了（go / V / awk / nim），G5 那条"名单 ≥ 4 才算
## 一台机器"在这一族上成立 —— 而四门的写法一门一个样：
##   * go：`map[K]V{…}` 字面量 + comma-ok 问在不在
##   * V ：同样的字面量 + 一格 `in` 算子
##   * awk：没有声明，所有下标都是关联数组
##   * nim：`initTable[K, V]()` 造出来 + `hasKey` 方法
## 四种记号、四种"问在不在"的写法，落到的是同一格 `map-has`。

import tables

var m = initTable[string, int]()
m["a"] = 1
m["b"] = 3
echo m["a"]
echo m["b"]
m["c"] = 4
echo m["c"]
if m.hasKey("a"):
  echo "yes"
