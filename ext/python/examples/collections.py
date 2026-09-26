# ext/python/examples/collections.py —— 表、字典、切片、两层循环
#
# 切片那一族是判据里最容易错的：python 的切片**从不越界**（`xs[1:100]` 给尾巴、
# `xs[5:2]` 给空表），而方言的 `ssub` / 数组下标越界是当场报错。


def build(n: int) -> list[int]:
    out: list[int] = []
    for i in range(n):
        out.append(i * i)
    return out


def total(xs: list[int]) -> int:
    s = 0
    for x in xs:
        s += x
    return s


def biggest(xs: list[int]) -> int:
    best = xs[0]
    for x in xs:
        if x > best:
            best = x
    return best


def count_chars(text: str) -> dict[str, int]:
    seen: dict[str, int] = {}
    for ch in text:
        if ch in seen:
            seen[ch] = seen[ch] + 1
        else:
            seen[ch] = 1
    return seen


def main():
    xs = build(6)
    print(xs[0], xs[1], xs[5], xs[-1], xs[-2])
    print(len(xs), total(xs), biggest(xs))

    # 切片：两头都夹到 [0, len]，长度夹到 >= 0
    print(xs[1:3], xs[:2], xs[4:], xs[:], xs[1:100], xs[5:2], xs[-2:])

    # 写下标（含负的）
    xs[0] = 100
    xs[-1] = 200
    print(xs)

    # 表里的表
    grid = [[1, 2, 3], [4, 5, 6]]
    for row in grid:
        line = 0
        for cell in row:
            line += cell
        print(line)
    print(grid[1][2], len(grid), len(grid[0]))

    # 字典
    ages = {"ann": 31, "bob": 24}
    ages["cid"] = 45
    print(len(ages), ages["ann"], ages["cid"])
    print("bob" in ages, "dan" in ages)

    counts = count_chars("abracadabra")
    print(counts["a"], counts["b"], counts["r"], len(counts))

    # 串上的切片与走一遍
    word = "abcdef"
    print(word[1:3], word[:2], word[3:], word[1:100], word[4:2], word[-3:])
    out = ""
    for ch in word:
        out = ch + out
    print(out)

    # 表当条件用（空表是假）
    todo: list[str] = []
    if not todo:
        print("nothing to do")
    todo.append("write tests")
    if todo:
        print(len(todo), todo[0])


main()

# ---- 一串记录（表的元素是一张字典）------------------------------------------
# `rows = []` 之后 `rows.append({...})` —— 从 CSV / 配置里读出来的东西几乎都是这个形状。
# 方言那一侧与"数组套数组"同一档：格子里躺一个句柄（字典是引用语义），走按字节那条路。
# 缺的两处都是表：方言的元素白名单，与 `arrIsBlob`（少了它 C 那条腿走标量那条路，
# `arrSuffix` 当场抛）。
rows = []
for i in range(3):
    row = {}
    row["id"] = i
    row["sq"] = i * i
    rows.append(row)
print(len(rows), rows)
for r in rows:
    print(r["id"], r["sq"], len(r))
print(rows[1]["sq"], rows[-1]["id"])
# 引用语义：手上那一格与表里那一格是同一张字典
last = rows[2]
last["extra"] = 1
print(len(rows[2]), sorted(rows[2]))
tot = 0
for r in rows:
    tot += r["sq"]
print(tot)
