# ext/mojo/examples/dict.mojo —— 与 go / V / awk / nim / lua / Scheme / CL 那几份 dict **同一件事**
#
# 期望输出逐行相同：1 / 3 / 4 / yes。
#
# mojo 的字典是**库里的泛型容器**（`Dict[K, V]`），而"造它的那一步自带标记"——
# `Dict[String, Int]()` 的被调者是一格带泛型实参的名字，认得出就够，不必回问类型
# （与 nim 的 `initTable[K, V]()` 是同一条办法）。落到的是现成的 map 那四格。
#
# 问"在不在"写成 `"a" in m`（V 也是这个算子；go 是 comma-ok、CL 是多值的第二格、
# Scheme 是 `hashtable-contains?`）—— 八种记号，同一格 `map-has`。

fn main():
    var m = Dict[String, Int]()
    m["a"] = 1
    m["b"] = 3
    print(m["a"])
    print(m["b"])
    m["c"] = 4
    print(m["c"])
    if "a" in m:
        print("yes")
