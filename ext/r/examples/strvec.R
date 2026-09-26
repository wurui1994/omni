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
# **负的 `n` 是"去掉那么多格"**（2026-09-26 补的一刀）：从前字符向量这一侧少了那一步，
# `k` 是负数时被"小于 0 就当 0"抹平，于是 `head(ww, -1)` 答 `character(0)` 而 R 答前 n-1 格
# —— 静默答错。带名字的向量更绕：名字那一条走的就是这一格，短了之后 `print` 会退回
# 不带名字的那一行（连名字一起不见）。数那一侧本来就是对的。
print(head(ww, -1))
print(tail(ww, -1))
print(head(ww, -99))

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

# **字符向量上的 `==` / `!=`**（2026-09-26 接了）：逐元素比，出一条逻辑向量。
# 这一格不碰 locale —— `==` 比的是串本身，而 `<` / `>` 才要那套排序规则（所以还没接）。
# 长度不一样时短的那条从头再来（R 的回收规矩），有一条零长时结果零长。
# 从前这儿一格都不认：`v == "a"` 落成一格裸的 `(bin "==" (arr string) (str "a"))`，
# 发到公共层才报"两边要同型" —— 那时已经过了换档那道门。
eqw <- c("a", "b", "a", "c")
print(eqw == "a")
print(eqw != "a")
print("a" == eqw)
print(sum(eqw == "a"))
print(which(eqw == "b"))
print(eqw[eqw == "a"])
print(c("a", "b") == c("a", "c"))
print(c("a", "b", "c", "d") == c("a", "b"))
print(character(0) == "a")
print(c("x") == character(0))
print(any(eqw == "z"))
print(all(eqw == "a"))
print(!(eqw == "a"))
print(ifelse(eqw == "a", "yes", "no"))
print(eqw == "")
print(c("", "a") == "")

# **`out <- c()` 之后攒的是串**（2026-09-26 修的）：`c()` 不带实参落成零长向量，而那一条
# 从前一律是**数值**的 —— 于是 `out` 整条被推成数值向量，`for (s in out)` 的循环量是
# double，接着 `s %in% c("+")` 报"一边是串一边是数"，整份退到 libR。
# 三处一起改：`rank` 认出字符向量（串赢）、`forNames` 让串盖掉 double、
# `c()` 的零长跟着上游那格 `want` 走（要串就出零长的字符向量）。
grab <- function(s) {
  out <- c()
  i <- 1
  while (i <= nchar(s)) {
    ch <- substr(s, i, i)
    if (ch != " ") out <- c(out, ch)
    i <- i + 1
  }
  out
}
gv <- grab("a b+c")
print(gv)
print(length(gv))
for (s in gv) cat(s, if (s %in% c("+", "-")) "op" else "ch", "\n")
print(gv %in% c("+", "a"))
print(sum(gv %in% c("+", "a")))
print(paste(gv, collapse = ""))
print(rev(gv))
print(sort(gv, method = "radix"))
print(nchar(gv))

# **带名字的字符向量**：`sapply(字符向量, 出串的函数)` 在 R 那儿出的就是这个 —— 名字是
# 被遍历的那条向量本身。印法跟不带名字的字符向量不一样：两行共用一个宽度
# （`max(最长的名字, 最长的带引号的值)`），而且**两行都是右对齐**（不带名字的那条是左对齐）。
nsv <- c(a = "x", bb = "yyy", ccc = "z")
print(nsv)
print(names(nsv))
print(unname(nsv))
print(length(nsv))
print(unname(nsv)[2])
nsw <- setNames(c("p", "q"), c("k1", "k2"))
print(nsw)
print(c(a = "x"))
print(c(aaaa = "z"))
print(sapply(c("ab", "c"), function(x) paste0("<", x, ">")))
nsu <- sapply(c("ab", "c"), function(x) toupper(x))
print(nsu)
print(names(nsu))
print(unname(nsu))
print(setNames(character(0), character(0)))
nsz <- c(a = "1", b = "22")
print(nsz)
print(nchar(unname(nsz)))
for (ns in unname(nsv)) cat(ns, "")
cat("\n")

## 字符向量的元素写：下标是运行期算出来的那几趟（越界/0/负下标当场报，见 SPEC 4.12）
wv <- c("a", "b", "c", "d")
wi <- 2L
wv[wi] <- "B"
wv[wi + 1L] <- toupper(wv[1])
wv[length(wv)] <- paste0(wv[2], "!")
cat(wv, "\n")
print(nchar(wv))
for (wk in seq_along(wv)) wv[wk] <- paste0(wk, wv[wk])
print(wv)
wv[2.9] <- "trunc"
cat(wv[2], wv[3], "\n")

## rep(字符向量, times = 一条向量)：与数值那一侧同一条账（落在 (arr string) 上）
cat(rep(c("a", "b"), times = c(2, 3)), "\n")
print(rep(c("x", "y"), c(1, 2)))
cat(rep("z", times = c(3)), length(rep(c("a", "b"), c(0, 0))), "\n")
cat(nchar(rep(c("ab", "c"), c(2, 1))), "\n")
cat(paste(rep(c("-", "="), c(3, 2)), collapse = ""), "\n")

## 带名字的字符向量：逐元素那一族把名字带过去（startsWith / grepl 那几格 R 自己也丢）
knv <- c(x = "p", y = "qq")
print(nchar(knv))
print(toupper(knv))
print(trimws(knv))
print(strrep(knv, 2))
kab <- c(x = "ab", y = "cd")
print(substr(kab, 1, 1))
print(gsub("a", "A", kab))
print(chartr("a", "A", kab))
print(startsWith(knv, "p"))
print(grepl("p", knv, fixed = TRUE))
cat(nchar(knv), names(nchar(knv)), "\n")
## `[[i]]` 在字符向量上出一格串（与 `[i]` 同一格值，只是不带名字）
kdv <- c("ab", "cd")
print(kdv[[2]])
print(kdv[2])
cat(kdv[[1]], kdv[[2]], "\n")
