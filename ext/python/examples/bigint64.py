# ext/python/examples/bigint64.py —— int 那一格**贴着 64 位上界**的一趟
#
# 我们的 int 是 64 位（python 的没有上界 —— 那一格要借 `Objects/longobject.c`，还没接）。
# 但 **2^53 到 2^63 之间那一段**是我们该给得出的，而它恰好是 double 装不下的地方：
# 凡是"顺手借了 double 的路"的算子，都在这一段上静静答错。已经抓出过三格
# （`**`、`//` 与 `%`、单参 `round`），所以这一份把常用的一族整数运算在这一段上
# 全走一遍 —— 往后再加算子，先让它过这一份。
#
# 溢出那一格不在这里（`2 ** 64` 报"无上界的整数还没接"）：这一份只量**答得出的**那一段。


def main():
    big = 4052555153018976267          # = 3 ** 39，17 位有效数字，double 装不下
    print(abs(-big), abs(big))
    print(min(big, big - 1), max(big, big - 1))
    print(big + 1, big - 1, big * 2 - big)
    print(big > big - 1, big == big, big < big + 1)
    print(big & 255, big | 1, big ^ 1)
    print(big >> 10, (big >> 10) << 10)
    print(str(big), len(str(big)))
    print(int("4052555153018976267"))
    print(round(big), round(big / 1000000))
    print(sum([big, 1, 2]))
    print(big // 10 * 10 + big % 10)
    xs = [big, big - 1, big - 2]
    print(xs[0], xs[1] - xs[2])
    print(sorted(xs)[0])
    d = {big: "a"}
    print(d[big])
    print(float(big))
    print(big % 2 == 1, (big + 1) % 2 == 0)


main()
