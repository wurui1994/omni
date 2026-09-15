# ext/mojo/examples/basics.mojo —— 与前七门那几份**同一件事**
#
# 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
# Mojo 与 nim 一样是**缩进即块**（词法层出 INDENT/DEDENT），可到了图这一层
# 那件事已经消失了 —— 缩进只是语法的形状，节点还是那 13 格。
#
# 这一份刻意用 `while` 而不是 `for i in range(n)`：迭代器协议不在第一批
#（它要 indirect-call + 协议，`ext/mojo/SPEC.md` §六第 2 条）。
#
# 要素对照：
#   fn + 形参表（带类型）  -> bind + func（类型丢掉：它是端口的 sort）
#   var x = …             -> bind（targets 里带 bind 的那一格）
#   x = …                 -> set
#   while                 -> loop
#   if / else             -> branch
#   return                -> ret
#   print                 -> prim print

fn sumto(n: Int) -> Int:
    var acc = 0
    var i = 1
    while i <= n:
        acc = acc + i
        i = i + 1
    return acc

fn fact(n: Int) -> Int:
    if n == 0:
        return 1
    return n * fact(n - 1)

fn max2(a: Int, b: Int) -> Int:
    if a > b:
        return a
    else:
        return b

fn main():
    print(sumto(5))
    print(fact(5))
    print(max2(3, 7))
    var tag = "ok"
    print(tag)
