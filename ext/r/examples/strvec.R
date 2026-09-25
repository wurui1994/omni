# ext/r/examples/strvec.R —— 字符向量（`c("a", "bb")` 那一条）
#
# 前面那些例子里的"串"都是**一格**串（`paste` / `substr` / `sprintf`）。这一份立的是
# **一条装串的向量**：造、取、写、长度、`cat`、`print`、`for … in`、`paste(collapse=)`、
# `rev`、`seq_along`，以及"混着数写 `c()` 时 R 会把整条收成字符向量"那一条。
#
# 存法与数值向量**不一样**：数值向量是 `(ptr real)` + 槽 0 装长度（为了 `NA` 那个 NaN
# 载荷），字符向量是方言的 `(arr string)` —— 自带长度、`apush` 还能现长，于是
# `out <- c(out, s)` 那种攒法不必先算总长。账在 `ext/r/adapter.js` 的 `RSTRV` 那一段。
#
# `print` 的两处与数值不同（都是 R 自己的规矩，量出来的）：元素**带引号**、
# 宽度按"最长那格 + 两个引号"取、而且**左对齐** —— 所以 R 印出来的行尾真的有空格。

labels <- c("a", "bb", "ccc")
print(labels)
cat(labels, "\n")
cat(labels, sep = "|")
cat("\n")
cat("第二格:", labels[2], "长度:", length(labels), "\n")

# 遍历
for (s in labels) cat("<", s, ">\n")
for (i in seq_along(labels)) cat(i, labels[i], "\n")

# 80 列折行：最长那格 19 个字符 + 两个引号 = 21，一行摆得下三格
words <- c("alpha", "b", "gamma-delta-epsilon", "z")
print(words)

# 零长与"先开好再填"
print(character(0))
buf <- character(3)
buf[1] <- "x"
buf[3] <- "zzz"
print(buf)

# 攒结果：`c(out, 新的一格)`（R 里最常见的那种写法）
tag <- function(s, k) paste0("[", s, "#", k, "]")
collect <- function(n) {
  out <- c("start")
  for (i in 1:n) out <- c(out, tag("item", i))
  out
}
r <- collect(3)
print(r)
cat("攒了", length(r), "格\n")

# 当实参、当返回值、当顶层的名字（函数看得见它）
gl <- c("g1", "g2")
useg <- function(k) gl[k]
cat(useg(2), "\n")
first <- function(v) v[1]
cat(first(labels), "\n")
print(rev(labels))
cat(paste(labels, collapse = ", "), "\n")

# 混着数写：R 把整条收成字符向量，数按 `as.character` 的 15 位有效数字转
mixed <- c("n=", 3, 1 / 3)
print(mixed)

# 逐元素那一层：出另一条向量（`nchar` 出数值，`toupper` / `tolower` / `paste0` 出字符）
print(nchar(words))
print(toupper(labels))
print(tolower(c("Ab", "cDe")))
cat(tolower("MiXeD 123!"), "\n")
print(paste0("#", 1:3))
print(paste("id", 1:3, sep = "-"))
print(paste0(c("a", "b"), 1:4))        # 回收：长的那边说话
print(paste0("x", character(0)))       # 零长收成空串，不是零长
cat(paste0("#", 1:3, collapse = "+"), "\n")

# 下标也能是向量：按位置挑、按掩码挑
print(labels[c(1, 3)])
print(words[nchar(words) > 2])
print(labels[c(TRUE, FALSE)])

# 切开一行文本：R 那边 `strsplit` 回的是一张**表**，这一层没有"表里装向量"，所以只接
# 真代码里那两种形状 —— `strsplit(s, sep)[[1]]` 与 `unlist(strsplit(s, sep))`。
# `split=` 在 R 里默认是**正则**，所以只收"没有正则元字符的串字面量"或明写 `fixed = TRUE`。
row <- "alice,30,nyc"
fld <- strsplit(row, ",")[[1]]
print(fld)
cat(fld[1], "住在", fld[3], "\n")
stopifnot(length(fld) == 3)
print(unlist(strsplit("a b c", " ")))
print(strsplit("a,b,", ",")[[1]])      # 末尾那格空串 R 不给
print(strsplit("a,,b", ",")[[1]])      # 中间的空串要
print(strsplit("abc", "")[[1]])        # 空 sep 是"一格一个字符"
print(strsplit("a.b", ".", fixed = TRUE)[[1]])
for (w in strsplit("x y z", " ")[[1]]) cat("<", w, ">", sep = "")
cat("\n")

# `rep` 在串上也接了（`(arr string)` 那一侧另一格辅助函数，见 adapter 的 `r_rep_str`）
print(rep("ab", 3))
print(rep(c("a", "b"), 2))
print(rep(c("a", "b"), each = 2))
cat(paste(rep("-", 5), collapse = ""), "\n")

# `ifelse(test, "y", "n")` —— 两支是串时出一条字符向量（R 的常用写法）
v <- c(-1, 0, 3)
print(ifelse(v > 0, "pos", "non-pos"))
print(ifelse(c(TRUE, FALSE), "y", "n"))
cat(ifelse(TRUE, "a", "b"), ifelse(1 > 2, "a", "b"), "\n")
# test 里有 NA 时 R 挑出一格 NA_character_，这一档没有那种值 —— 当场停下来，不静默印 "NA"

# 负下标在字符向量上也是"丢掉那几格"（与数值那一侧同三条规矩，见 `r_pick_str`）
ss <- c("a", "b", "c", "d")
print(ss[-2])
print(ss[-c(1, 4)])
print(ss[c(2, 0, 3)])

# 串那一族在**字符向量**上逐元素（每一格转给标量那一版，见 `r_substr_v` 那几个）
w2 <- c("apple", "be", "cherry")
print(substr(w2, 1, 3))
print(substring(w2, 2))
print(substr(w2, 2, 2))
print(startsWith(w2, "a"))
print(endsWith(w2, "e"))
print(trimws(c("  a ", "b  ")))
cat(sum(startsWith(w2, "a")), "\n")
# `startsWith(v, c("a","b"))` 那种两边都回收的没接 —— 当场报

# base 那四条**字符向量常量**（`letters` / `LETTERS` / `month.name` / `month.abb`）。
# 它们在 R 那边是普通变量（能被盖掉），所以这一档也按变量办：每用一次现造一条
print(letters)
print(LETTERS)
print(month.name)
print(month.abb)
print(letters[1])
print(LETTERS[3])
print(month.abb[12])
cat(letters[1], LETTERS[26], "\n")
print(length(letters))
print(toupper(letters[5]))
# `strrep(x, times)`：接起来 times 遍（方言的 `(srep …)`）；次数只接一格标量
print(strrep("ab", 3))
print(strrep("-", 5))
print(strrep("x", 0))
print(strrep(c("a", "bc"), 2))
print(nchar(strrep("ab", 4)))
# `casefold(x, upper = FALSE)` 是 `tolower` / `toupper` 的别名（S 兼容）
print(casefold("AbC"))
print(casefold("AbC", upper = TRUE))
print(casefold(c("Ab", "cD"), upper = TRUE))
# `trimws(x, which)`：`which=` 只接串字面量（"both" 默认 / "left" / "right"）
print(trimws("  ab  "))
print(trimws("  ab  ", which = "left"))
print(trimws("  ab  ", which = "right"))
print(trimws("  ab  ", which = "both"))
print(trimws(c("  a ", " b"), which = "left"))
cat("[", trimws("\t x \n", which = "left"), "]\n", sep = "")
# `nchar(x, type)`：只认 "bytes" 与 "chars"（这一档数字节，非 ASCII 在上头就报了）
print(nchar("hello", type = "bytes"))
print(nchar("hello", type = "chars"))
print(nchar(c("ab", "cde"), type = "bytes"))
# `chartr(old, new, x)`：old 里第 k 个字符换成 new 里第 k 个，表外的原样留下
print(chartr("ab", "xy", "aabb"))
print(chartr("abc", "xyz", "cab"))
print(chartr("a", "A", "banana"))
print(chartr("ab", "xy", c("ab", "ba")))
print(chartr("z", "Z", "abc"))
# `as.character(向量)` 出一条字符向量（**15 位有效数字** —— 与 `paste` 同一条口径，
# 而 `cat` / `print` 是 7 位）。里头有 `NA` 的那一趟**当场报**：R 出的是 `NA_character_`
# （印出来不带引号），而这一档没有带缺失的串（第四节第 11 条）
print(as.character(c(1, 2, 3)))
print(as.character(c(1.5, -2.25)))
print(as.character(c(0.1, 1 / 3)))
print(as.character(1:3))
print(as.character(c(1e6, 1e-5)))
print(as.character(c(TRUE, FALSE)))
print(rev(as.character(c(1, 2))))
print(nchar(as.character(c(10, 200))))
print(paste(as.character(c(1, 2)), collapse = "-"))
print(as.character(123))

# **只要"相等"、不要 collation** 那一族在字符向量上接了（`sort` / `order` 还是当场报 ——
# 排序要 R 的 locale 排序规则，见文件头）。"两个串是不是同一个"是逐字节的、与 locale 无关
ww <- c("b", "a", "b", "c")
print(unique(ww))
print(duplicated(ww))
print(match(c("a", "z"), ww))
print(c("a", "z") %in% ww)
print("a" %in% ww)
print("z" %in% ww)
print(match("c", ww))
print(unique(c("x")))
print(duplicated(c("x", "x", "x")))
print(match(c(""), c("", "a")))
print(length(unique(ww)))
cat(sum(ww %in% c("a", "c")), "\n")
print(union(c("a", "b"), c("b", "c")))
print(intersect(c("a", "b"), c("b", "c")))
print(setdiff(c("a", "b"), c("b")))
print(head(ww, 2))
print(tail(ww, 2))

# 排序那两格**只接 `method = "radix"`**：R 自己明说 radix 是在 **C locale** 下比的
# （`?sort`），量出来正是按字节 —— `sort(c("pear","apple","Banana"), method="radix")` 出
# `Banana apple pear`，而默认那一档按 locale 排（这台机器是 `zh_CN`，出 `apple Banana pear`）。
# 默认那一档要 ICU 那一套，照旧当场报
print(sort(c("pear", "apple", "Banana"), method = "radix"))
print(order(c("pear", "apple", "Banana"), method = "radix"))
print(sort(c("b", "a", "c"), method = "radix"))
print(sort(c("B", "a", "C"), method = "radix"))
print(sort(c("a10", "a9", "a1"), method = "radix"))
print(sort(c("", "a"), method = "radix"))
print(sort(c("ab", "a"), method = "radix"))
print(sort(c("b", "a", "b"), method = "radix"))
print(sort(c("b", "a"), decreasing = TRUE, method = "radix"))
print(order(c("b", "a", "b"), method = "radix"))
