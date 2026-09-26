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
# 没有"运行期解析格式串"那一格。认的是 `%[-+0 ][宽][.精度]{d,i,s,f,e,E,g,G,x,X,o}` 与 `%%`；
# 位数那几格落方言的 `(sfix …)` / `(ssci …)` / `(sgen …)`，也就是 C 的 `%.Nf` / `%.Ne` /
# `%.Ng` —— "印出来什么"这件事仍然只有一份实现。进制那几格落 `(sbase …)`。
#
# `tolower` **只管 ASCII**：方言里只有 `(supper …)`，没有反过来的那一格 —— 所以它是拿两张
# 26 个字母的表查出来的（`(sfind 大写表 这个字符)` 给位置）。表里查不到的字符原样留下。

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

# sprintf 的旗子：`0` 补零（符号留最前）、`+` 与空格只在非负时补、`x`/`X`/`o` 是进制
cat(sprintf("%05.2f|%08.3f|%05d", 3.14159, -1.5, -42), "\n")
cat(sprintf("%+d|% d|%+.2f", 42, 7, -2.5), "\n")
cat(sprintf("%x|%X|%o", 255, 255, 8), "\n")
cat(sprintf("%E", 12345.6789), "\n")

# 串上再几格
cat(tolower("MiXeD 123!"), "\n")
cat("[", trimws("  hi there \t"), "]\n", sep = "")
cat(substring("hello world", 7), "\n")
cat(substring("hello", 2, 3), "\n")

# "这是什么东西"那三问（类型是推出来的，所以答案是编译期常量）
cat(is.character("a"), is.character(1), "\n")
cat(is.numeric(1), is.numeric(1.5), is.numeric(TRUE), is.numeric("a"), "\n")
cat(is.logical(TRUE), is.logical(1 > 0), is.logical(2), "\n")

# `as.numeric` / `as.integer` —— 只在答得准的那几格上答。**串转数没接**：核心方言里没有
# "串 → 数"那一格算子，自己写一圈按位累加在 15 位有效数字之外与 strtod 的舍入对不上，
# 所以当场报。`as.integer` 是**朝零截**（不是四舍五入）；向量上逐元素、缺失原样留着
# （这一档的"整数向量"底下还是 double，所以 NA 跟得住）。
cat(as.numeric(1.5), as.numeric(2L), as.numeric(TRUE), "\n")
cat(as.integer(2.7), as.integer(-2.7), as.integer(TRUE), "\n")
cat(as.numeric(NA), "\n")
print(as.numeric(c(1L, 2L)))
print(as.numeric(c(TRUE, FALSE, NA)))
print(as.integer(c(1.7, -2.7, NA)))
print(as.integer(c(10, 20)))

# `sprintf` 在向量上**出一整条字符向量**（R 的常用写法）。落法是"摊成元素、再套一遍同一条
# 排版"：拿一格合成的 `sprintf(fmt, 那几格标量临时量)` 递归下来 —— 旗子 / 宽度 / 精度 /
# 进制那一大段只有一份实现。长度按回收取最长的那一格；有一格零长就整条零长。
ns <- c("a", "b", "c")
print(sprintf("%d: %s", 1:3, ns))
print(sprintf("x%d", 1:2))
print(sprintf("%d-%d", 1:2, 1:4))
print(sprintf("%5.2f|", c(1.5, 22.25)))
print(sprintf("%d%%", 1:2))
print(sprintf("%s", c(1.5, 2)))
print(sprintf("%s", c(TRUE, FALSE)))
print(sprintf("%d", integer(0)))
print(sprintf("[%-4s]", ns))
cat(sprintf("%03d", 7), "\n")

# `formatC(x, format=, digits=, width=, flag=)`（2026-09-26 接了）——
# **改写成一格 `sprintf`**（R 的 `formatC` 本来就是"照 C 的 sprintf 排版"），所以旗子 /
# 宽度 / 精度那一大段只有一份实现。缺省值是量出来的（`?formatC` 的 "Default: 2 for
# integer, 4 for real numbers"）：double 缺省 `format="g"` + `digits=4`、整数缺省
# `format="d"`、串缺省 `format="s"`。
cat(formatC(3.14159, digits = 3, format = "f"), "|\n")
cat(formatC(3.14159, format = "f"), "|\n")
cat(formatC(3.14159, digits = 2, format = "e"), "|\n")
cat(formatC(3.14159, digits = 3, format = "g"), "|\n")
cat(formatC(42, width = 8), "|\n")
cat(formatC(42, width = 8, flag = "0"), "|\n")
cat(formatC(42, width = 8, flag = "-"), "|\n")
cat(formatC("ab", width = 5), "|\n")
cat(formatC("ab", width = 5, flag = "-"), "|\n")
cat(formatC(42L, format = "d"), "|\n")
cat(formatC(3.14159, width = 10, digits = 2, format = "f"), "|\n")
cat(formatC(0.000123, format = "e", digits = 1), "|\n")
cat(formatC(c(1, 10, 100), width = 5), "|\n")
cat(formatC(42), "|\n")
cat(formatC(3.14159), "|\n")
cat(formatC(-2.5, digits = 1, format = "f"), "|\n")
cat(formatC(1e10, format = "g", digits = 3), "|\n")
cat(formatC(c(1.5, 2.25), format = "f", digits = 1), "|\n")
print(formatC(c("a", "bb"), width = 4))
cat(formatC(7L, width = 3, flag = "0"), "|\n")
cat(nchar(formatC(42, width = 8)), "\n")
# `format = "d"` 收一格 double 时**当场报**（R 那儿是四舍到整数，而这一层的 `%d` 朝零截）
# —— 所以要整数得先 `as.integer(…)`。`big.mark=` / `mode=` 也还没接。
cat(formatC(as.integer(2.7), format = "d"), "|\n")
# `%*d` 那一格宽度从实参里取（R 也收）—— 格式串是**编译期**拆开的，所以那一格只认
# **整数字面量**；不是字面量就当场报（不给一个"宽度当 0"的答案）。
cat(sprintf("[%*d]", 6, 42L), "\n")
cat(sprintf("[%*s]", 8, "ab"), "\n")
cat(sprintf("[%-*d]", 6, 42L), "\n")
cat(sprintf("[%*.2f]", 9, 3.14159), "\n")
cat(sprintf("[%0*d]", 5, 7L), "\n")
cat(sprintf("%*d %*d", 3, 1L, 4, 22L), "\n")

# **`substring(s, first, last)` 的起止可以是向量**：R 把三条**一起回收**，出来的长度是
# 三者里最长的那个（量出来 `substring("abcdef", 1:3, 3:5)` 是 `abc bcd cde`）。
# 截断与"起点比终点大就出空串"那两条不在这儿重写 —— 每一格照旧走标量那份，一定同解。
# `substr` **不**这么回收（量出来 `substr("abcdef", 1:3, 3:5)` 只出 `abc`），所以那一格照旧报。
cat(substring("abcdef", 1:3, 3:5), "\n")
cat(substring("abcdef", 1:3), "\n")
cat(substring("abcdef", 2, 3:5), "\n")
cat(substring("abc", 1:5, 1:5), "|", "\n")
cat(length(substring("abcdef", 1:3, 3:5)), "\n")
cat(substring("abcdef", 4:2, 5), "\n")
print(substring("abcdef", 1:3, 3:5))
cat(nchar(substring("abcdef", 1:3, 3:5)), "\n")
cat(rev(substring("abcdef", 1:3, 3:5)), "\n")
cat(toupper(substring("abcdef", 1:2, 2:3)), "\n")

# **`strtoi(x, base)`** —— 核心方言里没有"串 → 数"，这一格按字符自己解一遍（一张 36 位的
# 数字表 + `sfind`，跟 `tolower` 同一条路）。整串必须吃完：后头多一个字符就 NA。
# **`base` 的默认是 `0L` 不是 10**（`args(strtoi)` 印的就是），那一档照 `strtol` 认前缀 ——
# `0x` → 16、前导 `0` → 8、别的 → 10，所以 `strtoi("011")` 是 9 而 `strtoi("011", 10L)` 是 11。
cat(strtoi("ff", 16L), strtoi("FF", 16L), "\n")
cat(strtoi("777", 8L), strtoi("101", 2L), strtoi("z", 36L), strtoi("Z", 36L), "\n")
cat(strtoi("0x1f", 16L), strtoi("0X1f", 16L), strtoi("-ff", 16L), "\n")
cat(strtoi("10", 10L), strtoi("-10", 10L), strtoi("+5", 10L), strtoi(" 12", 10L), "\n")
cat(strtoi("zz", 16L), strtoi("", 16L), strtoi(" 12 ", 10L), strtoi("12abc", 10L), "\n")
cat(strtoi("1.5", 10L), strtoi("-", 10L), strtoi("0x1f", 10L), "\n")
# 出了 int 的范围就 NA —— 连 INT_MIN 也是（R 拿那一格当 NA_INTEGER）。
cat(strtoi("2147483647", 10L), strtoi("2147483648", 10L), strtoi("-2147483648", 10L), "\n")
cat(strtoi("011"), strtoi("11"), strtoi("08"), "\n")
cat(strtoi("0x11"), strtoi("0X11"), strtoi("-0x11"), "\n")
cat(strtoi("0"), strtoi("00"), strtoi("0x"), strtoi("007"), "\n")
cat(strtoi("011", 10L), strtoi("011", 8L), "\n")
cat(strtoi("ff", base = 16L) + 1, "\n")
cat(is.na(strtoi("zz", 16L)), strtoi("7fffffff", 16L), "\n")

## as.numeric(串) / as.integer(串)：<= 11 位有效数字那一段（超了当场报，见 SPEC 第四节）
cat(as.numeric("3.5") + 1, "\n")
cat(as.numeric("42"), as.numeric("-0.125"), as.numeric("1e3"), as.numeric("1E-2"), "\n")
cat(as.numeric(" 7 "), as.numeric("0.00123"), as.numeric("+8"), "\n")
cat(as.numeric("12345678901"), as.numeric("0"), as.numeric("-0"), "\n")
cat(as.numeric("abc"), as.numeric("3.5x"), as.numeric(""), "\n")
print(is.na(as.numeric("abc")))
print(as.numeric("2.5") == 2.5)
cat(as.integer("42") + 1L, as.integer("42.9"), as.integer("-7.9"), "\n")
sn <- "12.5"; cat(as.numeric(sn) * 2, "\n")
sv2 <- c("1.5", "2.5"); cat(as.numeric(sv2[1]) + as.numeric(sv2[2]), "\n")
