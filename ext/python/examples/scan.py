# ext/python/examples/scan.py —— 扫一遍串（tokenizer 那种写法）
#
# 这一份的存在理由是**三处真会答错的**，都是同一个形状："那一格里夹着几句话"：
#
#   1. **`while` 的条件里夹着几句话**：串上那几个分类（`isdigit` / `isalnum` / …）要现场走
#      一趟循环，于是条件那一格是 `block-expr`；摆在 `while` 的条件位上，那几句会被提到
#      `while` **外头** —— 条件就冻在头一圈那个字符上了。症状：`tokenize("x1 + 42")` 只交
#      一格记号 `('name', 'x1 + 42')`。现在落成 `while true` + 体开头"条件不成立就 break"
#      （`continue` 照旧对：跳到 while 顶上，也就跳回那几句前面）。
#   2. **`and` / `or` 不短路**：右边那几句被提到整句前头，于是右边照算 ——
#      `while j < n and src[j].isdigit()` 在 `j == n` 那一圈当场炸
#      （`substring out of range`）。现在落成一格临时量加一句 `if`。
#   3. **三目不短路**（后来量出来的，同一个形状）：`1 if ok else int("zz")` 当场炸，
#      python 印 1。落法同第二条。**纯表达式那一档照旧发 `(sel …)`** —— 方言那一格本来
#      就是懒的，所以 `x if ok else xs.pop()` 从前答得对、一眼看不出病：
#      这类病只在"那一支带语句"时才现形。
#
# 前两条连着量出来：修完第一条，第二条立刻露头。


def tokenize(src):
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c == " ":
            i += 1
            continue
        if c.isdigit():
            j = i
            while j < n and src[j].isdigit():
                j += 1
            out.append(("num", src[i:j]))
            i = j
            continue
        if c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            out.append(("name", src[i:j]))
            i = j
            continue
        out.append(("op", c))
        i += 1
    return out


def evaluate(toks):
    total = 0
    sign = 1
    for kind, text in toks:
        if kind == "num":
            total += sign * int(text)
        elif kind == "op" and text == "-":
            sign = -1
        elif kind == "op" and text == "+":
            sign = 1
    return total


ts = tokenize("x1 + 42 - 7 + foo_bar")
print(len(ts))
for k, t in ts:
    print(k, t)
print(evaluate(ts))
print(tokenize(""), tokenize("  "))
print(tokenize("a1"), tokenize("1a"), tokenize("_x9"))
print(tokenize("1+2"), evaluate(tokenize("1+2-3")))

# 第三条那一格的判据：没走的那一支**不许算**（`int("zz")` 会当场停下来）
ok = True
print(1 if ok else int("zz"))
print(1 if ok else (2 if ok else int("zz")))
print([1 if ok else int("zz"), 2], {"k": 1 if ok else int("zz")})
print(f"{1 if ok else int('zz')}")
bad = "zz"
print(0 if not ok else 7, tokenize("9") if ok else tokenize(bad))
