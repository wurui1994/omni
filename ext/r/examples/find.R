# ext/r/examples/find.R —— 找与换：`grepl` / `grep` / `sub` / `gsub`
#
# R 这一族默认按 **POSIX 扩展正则**匹配，而正则那一层这一档没有。所以规矩与 `strsplit`
# 那一格同一条：pattern 只收**串字面量**，而且里头**没有正则元字符**（`. \ | ( ) [ ] { }
# ^ $ * + ?`）；真要按定串找就明写 `fixed = TRUE`。
#
# 为什么不是"照原样发、让它像正则一样工作"：不是字面量的时候连"它是不是一条正则"都不知道，
# 那时按定串找就是**静默答错**。而真代码里这一族的实参多半就是定串（`gsub(",", "", s)`），
# 所以这一半覆盖得住常用写法。没接的当场报：正则、`ignore.case=`、`\\1` 那种回引用、
# `regexpr`（R 那一格回的值上挂着 `match.length` 等属性，印出来是四段）。
#
# 落法：一格串上的 `grepl` 就是 `(sfind s p) >= 0`（不必发函数）；从某一处往后找是"把剩下
# 那段切出来再 `sfind`" —— 方言的 `sfind` 只从头找。换是**不重叠、从左往右**（R 的口径）。

x <- c("apple pie", "banana", "cherry apple")

# 有没有
print(grepl("apple", x))
print(grepl("apple", "apple"))
print(grepl("zz", "apple"))
cat(grepl("an", "banana"), "\n")

# 哪几格（回位置；一格都没有就是 integer(0)）
print(grep("apple", x))
print(grep("zz", x))
print(grep("apple", x, value = TRUE))
print(grep("zz", x, value = TRUE))

# 换：`sub` 只换第一处，`gsub` 全换
print(sub("a", "A", x))
print(gsub("a", "A", x))
print(sub("zz", "Q", x))
print(gsub("an", "", "banana"))
print(gsub("aa", "b", "aaaa"))
print(sub("a", "", "banana"))
print(gsub("a", "", "aaa"))
cat(nchar(gsub("a", "", "aaa")), "\n")

# 元字符要明写 fixed = TRUE
print(gsub(".", "_", "a.b.c", fixed = TRUE))
print(grepl("(x)", "f(x)", fixed = TRUE))
print(sub("$", "USD ", "$100", fixed = TRUE))

# 换成更长的一段、换到开头与末尾
print(gsub(",", " / ", "a,b,c"))
print(gsub("a", "aa", "abca"))

# 拿来算：把千分位去掉再数一数长度
amounts <- c("1,200", "35,000")
cat(nchar(gsub(",", "", amounts[1])), "\n")
for (s in amounts) cat(gsub(",", "", s), "")
cat("\n")
