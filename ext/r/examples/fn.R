# ext/r/examples/fn.R —— 用户函数：形参与返回类型是从**调用点**推出来的
#
# R 的函数没有类型标注，而方言那一层不推导只检查 —— 所以"`f` 的形参装什么、回什么"
# 必须在 adapter 里答完，而答案只有一处来源：**调用点**。
# `half <- function(x) x / 2` 里 `x` 是什么？看 `half(3)` 传的是什么。
#
# 这一遍（`inferFns()`）扫全程序的调用点、把实参类型并进形参，转三轮到不动点：
# 一轮定住"顶层直接调的"、二轮定住"函数里调函数"、三轮让返回类型跟上。
# 形参只往宽走（int → real → 向量），所以一定停。
#
# 从前这一格是"形参一律 int、回值一律 int"，于是 `addone(c(1,2,3))` 当场报
# "第 1 个形参是 int，给的是 real*"，而 `f <- function(x) x > 2` 之后 `cat(f(1))`
# 印的是方言自己那套 `false`。
#
# 还没做的：**同一个形参在不同调用点装不同东西**（一会儿数一会儿串）——
# 那要运行期的类型标签（R 的 `SEXPTYPE`），这一档没有；两边对不上时留先来的那个。
# 形参默认值（`function(x, b = 2)`）也没做 —— 那是 promise 那一层。

half <- function(x) x / 2
cat(half(3), "\n")
cat(half(5), "\n")

area <- function(r) pi * r^2
cat(area(2), "\n")

# 向量进向量出（形参被推成向量）
addone <- function(v) v + 1
cat(addone(c(1, 2, 3)), "\n")
scale2 <- function(v, k) v * k
cat(scale2(c(1, 2, 3), 2), "\n")
first <- function(v) v[1]
cat(first(c(9, 8)), "\n")
tot <- function(v) sum(v)
cat(tot(c(1.5, 2.5)), "\n")
srt <- function(v) sort(v)
cat(srt(c(3, 1, 2)), "\n")
lenof <- function(v) length(v)
cat(lenof(c(1, 2, 3)), "\n")
mk <- function(n) rep(1, n)
cat(mk(3), "\n")

# 回三态逻辑（那个记号要留住，不然印 1 / 0）
isbig <- function(x) x > 10
cat(isbig(20), "\n")
cat(isbig(2.5), "\n")
print(isbig(20))

# 函数调函数（第二轮才定得住）
twice <- function(x) 2 * x
comp <- function(x) half(twice(x))
cat(comp(5), "\n")

# 串
greet <- function(s) paste("hi", s)
cat(greet("bob"), "\n")

# 递归与循环照旧
fib <- function(n) if (n < 2) n else fib(n - 1) + fib(n - 2)
cat(fib(10), "\n")
count <- function(n) {
  s <- 0
  for (i in 1:n) s <- s + i
  s
}
cat(count(10), "\n")

# 顶层自动印也管用户函数的调用 —— 回 void 的那些不印（下面 `hush` 那一句）
half(3)
hush <- function(x) cat("")
hush(1)

# 形参默认值与命名实参（默认值在**调用点**填 —— 见 SPEC 第四节第 3 条）
pow <- function(x, k = 2) x^k
cat(pow(3), "\n")
cat(pow(3, 3), "\n")
cat(pow(k = 3, x = 2), "\n")
cat(pow(2, k = 4), "\n")

greet2 <- function(name, greeting = "hi", punct = "!") paste0(greeting, ", ", name, punct)
cat(greet2("bob"), "\n")
cat(greet2("ann", "hello"), "\n")
cat(greet2("cat", punct = "?"), "\n")

atol <- function(x, eps = 1e-8) x > eps
cat(atol(0.5), "\n")
cat(atol(1e-9), "\n")

scaleby <- function(v, k = 2) v * k
cat(scaleby(c(1, 2, 3)), "\n")
cat(scaleby(c(1, 2, 3), 10), "\n")

# `is.function(f)` 在这一档是**编译期常量**：名字在"这一段定义过的函数"表里、或者在
# 内建/nmath 那两张表里就是 TRUE，就地写的匿名函数也是 —— 与 `is.numeric` 那三问同一条路
isf <- function(x) x
print(is.function(isf))
print(is.function(sum))
print(is.function(sqrt))
print(is.function(function(x) x))
notf <- 5
print(is.function(notf))
# `Sys.getenv(name)` 落方言的 `(getenv …)` —— 没设回空串（与 R 同解）
print(nchar(Sys.getenv("HOME")) > 0)
print(Sys.getenv("OMNI_NO_SUCH_VAR_XYZ"))
print(nchar(Sys.getenv("OMNI_NO_SUCH_VAR_XYZ")))
print(Sys.getenv("HOME") == Sys.getenv("HOME"))

# **R 的实参是值语义**（copy-on-modify，2026-09-26 接了）：函数里改形参改的是自己那一份，
# 调用方那条向量一个字节都不动。这一层的向量是一块 `(ptr real)`、按指针交进去，所以
# 从前 `x[1] <- 99` 直接写到了调用方的内存上 —— 静默答错，而且是"过后才发现自己的数据
# 变了"那一种。现在形参里**被写过元素**的那几格一进来就抄一份（`r_copyv` /
# `r_copy_str`）；只是重绑（`x <- 别的`）的不抄 —— 那本来就看不见。
setfirst <- function(x) { x[1] <- 99; x }
vv <- c(1, 2)
print(setfirst(vv))
print(vv)
growit <- function(x) { x[5] <- 9; x }
print(growit(vv))
print(vv)
setstr <- function(s) { s[1] <- "z"; s }
ww <- c("a", "b")
print(setstr(ww))
print(ww)
rebind <- function(x) { x <- c(7); x }
print(rebind(vv))
print(vv)
# 真写起来最常见的形状：函数里就地排一遍（调用方那条不动）
bub <- function(v) {
  n <- length(v)
  for (i in 1:(n - 1)) {
    for (j in 1:(n - i)) {
      if (v[j] > v[j + 1]) {
        t <- v[j]
        v[j] <- v[j + 1]
        v[j + 1] <- t
      }
    }
  }
  v
}
zz <- c(3, 1, 2)
print(bub(zz))
print(zz)

# **体尾是 `print(…)` 那种"做事"的也算不交值**（2026-09-26 接了）。R 里 `print(x)` 交的是
# "不可见的那格 x"，而这一档没有"可见性"这一层 —— 所以按 void 算，印出来的东西一字不差。
# 从前只有 `cat` 在这张单子上，于是**整份**源码只要有一个函数以 `print(…)` 收尾就退到 libR。
# 拿它的值用（`y <- shout(v)`，R 里 y 就是 v）照旧**当场报** —— 报了才退得回去。
shout <- function(v) print(v)
shout(c(1, 2, 3))
shout(c(9))
banner <- function(s) {
  cat("== ")
  print(s)
}
banner("hi")
maybe <- function(x) if (x > 0) print("pos") else print("neg")
maybe(1)
maybe(-1)

# **默认值里提到本函数的形参**（`function(s, n = nchar(s))`）—— R 那边默认值是个 promise、
# 在**被调方**求值，所以 `s` 指的是这一趟传进来的 `s`。这一档在**调用点**填默认值，
# 那儿没有 `s` 这个名字 —— 但那一格实参的树就在手上，换进去就是同一件事。
# 两条闸门：换进去的树只许是**字面量或者一个名字**（R 的 promise 只算一次，而换进去是
# 照抄一份 —— 算出来的表达式会算两遍），提到的形参这一趟得**已经有值**。
d1 <- function(a, b = a * 2) a + b
cat(d1(3), d1(3, 1), "\n")
d2 <- function(s, n = nchar(s)) substr(s, 1, n)
cat(d2("hello"), d2("hello", 2), "\n")
dw <- "world"
cat(d2(dw), "\n")
d3 <- function(v, k = length(v)) sum(v[1:k])
dv <- c(1, 2, 3)
cat(d3(dv), d3(dv, 2), "\n")
d4 <- function(x, y = x, z = y) x + y + z
cat(d4(2), d4(2, 3), d4(2, 3, 4), "\n")
d5 <- function(a = 1, b = 2) a * 10 + b
cat(d5(), d5(5), d5(5, 6), d5(b = 9), "\n")
## 体尾是 invisible(…) 的函数：顶层调一次什么都不印，拿它的值用照旧是那格值
ivf <- function(x) invisible(x)
ivf(3)
ivy <- ivf(4)
print(ivy)
ivh <- function(x) return(invisible(x + 1))
ivh(1)
print(ivh(1))
## 被印的那一格自己的副作用在 `[1] ` **前头**（先算值、再写前缀）
ivg <- function(x) { cat("in\n"); x * 2 }
print(ivg(3))
