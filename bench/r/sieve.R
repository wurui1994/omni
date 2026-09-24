# bench/r/sieve.R —— 向量上的随机写：筛法把 1..n 的那格向量当标记位用
n <- 1000000
m <- 1:n
for (i in 1:n) m[i] <- 1
i <- 2
while (i * i <= n) {
  if (m[i] == 1) {
    j <- i * i
    while (j <= n) {
      m[j] <- 0
      j <- j + i
    }
  }
  i <- i + 1
}
c1 <- 0
for (i in 2:n) c1 <- c1 + m[i]
cat(c1, "\n")
