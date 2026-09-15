# ext/mojo/examples/loopexit.mojo —— 与 go / lua / V / nim 那几份**同一件事**
#
# 期望输出逐行相同：12 / 6 / 8。
# Mojo 这一批只有 `while`（`for x in …` 是迭代器协议，不在这一批），
# 所以第三段的步进写在体的开头。

fn main():
    var s = 0
    var i = 0
    while True:
        i = i + 1
        if i > 5:
            break
        if i == 3:
            continue
        s = s + i
    print(s)
    print(i)

    var t = 0
    var j = -1
    while j < 4:
        j = j + 1
        if j == 2:
            continue
        t = t + j
    print(t)
