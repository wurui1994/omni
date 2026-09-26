# ext/python/examples/scan.py —— 扫一遍串（tokenizer 那种写法）
#
# 这一份的存在理由是**两处真会答错的**，都在"条件里夹着几句话"上：
#
#   1. **`while` 的条件里夹着几句话**：串上那几个分类（`isdigit` / `isalnum` / …）要现场走
#      一趟循环，于是条件那一格是 `block-expr`；摆在 `while` 的条件位上，那几句会被提到
#      `while` **外头** —— 条件就冻在头一圈那个字符上了。症状：`tokenize("x1 + 42")` 只交
#      一格记号 `('name', 'x1 + 42')`。现在落成 `while true` + 体开头"条件不成立就 break"
#      （`continue` 照旧对：跳到 while 顶上，也就跳回那几句前面）。
#   2. **`and` / `or` 不短路**：右边那几句被提到整句前头，于是右边照算 ——
#      `while j < n and src[j].isdigit()` 在 `j == n` 那一圈当场炸
#      （`substring out of range`）。现在落成一格临时量加一句 `if`。
#
# 这两条连着量出来：修完第一条，第二条立刻露头。


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
