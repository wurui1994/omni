# bench/r/nmath.R —— **对我们最不利的一格**：每一格元素都要过一次 FFI。
# R 这边 `dnorm(xs)` 是 C 里的一趟循环（一次 .Call），我们这边是 n 次 `ccall`
# —— 原生腿上那是一次普通函数调用，JS 腿上那是 n 次过 N-API。量的就是这个差。
n <- 200000
xs <- 1:n
s <- 0
for (k in 1:20) s <- s + sum(dnorm(xs / n))
cat(round(s) %% 1000000, "\n")
