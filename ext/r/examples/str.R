# ext/r/examples/str.R —— 串那一族，以及 R 的**两套有效数字**
#
# 同一个 double，R 有两个文本形式：
#
#   cat(1/3)             `0.3333333`          7 位（`options(digits)`）
#   as.character(1/3)    `0.333333333333333`  **15 位**（`coerce.c` 里写死的）
#   paste(1/3)           同上（`paste` 就是先 `as.character`）
#   sprintf("%s", 1/3)   同上
#
# 挑法是同一条（定点与科学记数按哪个短挑，见 `numfmt.R`），只有位数不同 ——
# 所以 `as.character(1e5)` 是 `1e+05` 而不是 `100000`。这件事在 adapter 里就是
# `asStr(…, dig)` 那一个参数。
#
# `sprintf` 的格式串**在编译期就拆开**：R 的格式串在真代码里几乎总是字面量，而方言里
# 没有"运行期解析格式串"那一格。认的是 `%[-][宽][.精度]{d,i,s,f,e,g}` 与 `%%`；
# 位数那几格落方言的 `(sfix …)` / `(ssci …)` / `(sgen …)`，也就是 C 的 `%.Nf` / `%.Ne` /
# `%.Ng` —— "印出来什么"这件事仍然只有一份实现。
#
# `tolower` **没接**：方言里只有 `(supper …)`，没有反过来的那一格，补它要给核心方言加一格
# 算子（五条腿都要动）—— 那不属于 R 这一刀。

# 两套位数
cat(1 / 3, "\n")
cat(as.character(1 / 3), "\n")
cat(paste(1 / 3), "\n")
cat(as.character(1e5), "\n")
cat(as.character(0.1 + 0.2), "\n")
cat(paste("三分之一是", 1 / 3), "\n")

# 串上那几格
cat(nchar("hello"), "\n")
cat(toupper("hello"), "\n")
cat(substr("hello", 2, 3), "\n")
cat(substr("hello", 0, 99), "\n")      # 越界是截断，不是报错
cat(substr("hello", 4, 2), "\n")       # 反过来是空串
cat(startsWith("hello", "he"), "\n")
cat(startsWith("hello", "x"), "\n")
cat(endsWith("hello", "lo"), "\n")
cat(endsWith("hello", "hello!"), "\n")
cat(paste0("a", 1, "b"), "\n")
cat(paste("x", 1.5, TRUE), "\n")
cat(paste("a", "b", sep = "-"), "\n")

# sprintf
cat(sprintf("%d-%s", 3, "x"), "\n")
cat(sprintf("%5.2f|", 3.14159), "\n")
cat(sprintf("%-6s|%6s|", "ab", "cd"), "\n")
cat(sprintf("%3d|%-3d|", 5, 5), "\n")
cat(sprintf("%e", 1234.5), "\n")
cat(sprintf("%g", 1234.5), "\n")
cat(sprintf("%s%%", 50), "\n")
cat(sprintf("%s", 1 / 3), "\n")
cat(sprintf("%.0f / %.3f", 2.5, 2.5), "\n")
