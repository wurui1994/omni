# ext/r/examples/bitw.R —— 位运算那一族（`bitwAnd` / `bitwOr` / `bitwXor` / `bitwNot` /
# `bitwShiftL` / `bitwShiftR`）
#
# 这一族真正难的只有一件事：**R 的整数是 32 位的，而这一档的 `int` 是 64 位。**
# 于是有三处不能照抄：
#
#   1. 右移是**补零的**（logical），不是算术移位 —— `bitwShiftR(-1L, 1L)` 是
#      `2147483647` 而不是 `-1`。所以要先 `& 0xFFFFFFFF` 取出那 32 位再移。
#   2. 左移完第 31 位是 1 的话那是个负数，要把符号铺回去（`bitwShiftL(-1L, 1L)` 是 `-2`）。
#   3. `NA_INTEGER` **就是** `INT_MIN` —— 所以 `bitwShiftL(1L, 31L)` 在 R 里印 `NA`
#      （算出来正好是那个位型），`bitwNot(2147483647L)` 同理。这一档还没有"带缺失的
#      整数"（见 ext/r/SPEC.md 第四节第 11 条），所以那几格**当场报**而不是给一个
#      R 不会给的数 —— 那种格子不在这把尺子里（尺子只量两边都有答案的地方）。
#
# 一元的 `~` 方言里没有（`un` 只有 `-` 与 `!`），`bitwNot` 借 `x ^ -1`。

print(bitwAnd(12L, 10L))
print(bitwOr(12L, 10L))
print(bitwXor(12L, 10L))
print(bitwNot(12L))
print(bitwNot(0L))
print(bitwNot(-1L))
# 负数那几格：按 32 位的补码办
print(bitwAnd(-1L, 255L))
print(bitwOr(-8L, 3L))
print(bitwXor(-1L, 1L))
# 移位
print(bitwShiftL(1L, 4L))
print(bitwShiftL(1L, 0L))
print(bitwShiftL(-1L, 1L))
print(bitwShiftR(16L, 2L))
print(bitwShiftR(-1L, 1L))
print(bitwShiftR(-16L, 2L))
# 实参按 `as.integer` 收（`bitwAnd(12, 10)` 在 R 里也是 8）
print(bitwAnd(12, 10))
cat(bitwAnd(6L, 3L), bitwOr(6L, 3L), "\n")
# 拿它们攒一格：把 0xDEAD 的两个字节拆出来再拼回去
w <- 57005L
print(bitwShiftR(w, 8L))
print(bitwAnd(w, 255L))
print(bitwOr(bitwShiftL(bitwShiftR(w, 8L), 8L), bitwAnd(w, 255L)))
