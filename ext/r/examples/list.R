# ext/r/examples/list.R —— `list(名字 = 值, …)`：一上来就带内容的那张表
#
# `dict.R` 那一份是"先 `list()` 造空的、再一格一格 `[[…]] <-` 填"（十一门语言同一件事）。
# 这一份压的是 R 里更常见的写法：**造的时候就把内容写上**（配置 / 一条记录）。
#
# 落法：方言里"造"与"写"是两件事（`dnew` 是值、`dset` 是语句），所以这一格落成
# 一格 `block-expr` —— 先 `dnew`、再一格一格 `dset`、最后拿那格临时量当值。
#
# 两处要紧的账：
#   * **值类型是整张表一起推的**：`list(n = 10, tol = 0.5)` 里有一格 double，整张表就装
#     double，于是后面 `cfg[["extra"]] <- 3` 那个 3 要先加宽 —— 不加宽方言那侧会报
#     "dset 的值要是 real，这里是 int"（量出来的）。
#   * **位置实参当场报**：R 的 `list(1, 2)` 是按位置存的，而这一层的表只有"按名字取"
#     （`m[["k"]]`）。假装接住就是静默答错，所以那一格报。
#
# `names(m)` / `print(m)` / `m$n` 都还没接（要属性与"表里装向量"那两层，见 SPEC §4 第 4 条）。

cfg <- list(n = 10, tol = 0.5)
cat(cfg[["n"]], cfg[["tol"]], "\n")
cat(length(cfg), "\n")

# 缺键回 NULL —— R 里问"有没有这个键"就是这么写的
cat(is.null(cfg[["zz"]]), is.null(cfg[["n"]]), "\n")

# 造好之后照样能往里写
cfg[["extra"]] <- 3
cat(cfg[["extra"]], length(cfg), "\n")

# 一张装串的表（一格是串，整张表就装串）
who <- list(name = "alice", city = "nyc")
cat(who[["name"]], "住在", who[["city"]], "\n")

# 拿表里的数接着算
tot <- cfg[["n"]] * 2 + cfg[["tol"]]
cat(tot, "\n")

# `m$k` 与 `m[["k"]]` 是同一件事（R 里 `$` 就是按名字取）—— 读、写、问有没有都接了。
# R 的 `$` 还会**部分匹配**（`cfg$to` 能取到 `tol`）：这儿不做，写全名。
cat(cfg$n, cfg$tol, "\n")
cfg$more <- 4
cat(cfg$more, length(cfg), "\n")
cat(is.null(cfg$zz), is.null(cfg$n), "\n")
who$city <- "sf"
cat(who$name, "搬到", who$city, "\n")
cat(cfg[["n"]] + cfg$tol, "\n")

# **表上的 `names()`**：键那一条摆在影子变量里（`d__ks`，与带名字的向量的 `v__nm` 同一个
# 办法），每写一格新键就 `apush` 一次 —— 于是次序是**插入序**，与 R 同解。
# 空表那一格 R 交的是 `NULL`（"没有 names 属性"就是 NULL），所以 `print` 那儿单独印 NULL。
cat(names(cfg), "\n")
print(names(cfg))
cat(length(names(cfg)), "\n")
for (k in names(cfg)) cat(k, cfg[[k]], "\n")
cfg[["zz"]] <- 7
cat(names(cfg), "\n")
cfg[["zz"]] <- 8
cat(names(cfg), length(names(cfg)), "\n")
cat("tol" %in% names(cfg), "zzz" %in% names(cfg), "\n")
cat(nchar(names(cfg)), "\n")
cat(rev(names(cfg)), "\n")
cat(sort(names(cfg), method = "radix"), "\n")
cat(names(who), "\n")
tally <- list()
for (w in c("b", "a", "b", "c", "a")) {
  if (is.null(tally[[w]])) tally[[w]] <- 0
  tally[[w]] <- tally[[w]] + 1
}
for (k in names(tally)) cat(k, tally[[k]], "\n")
cat(length(names(tally)), "\n")
blank <- list()
cat(length(names(blank)), "\n")
print(names(blank))

# **`unlist(表)`**：R 交的是一条**带名字**的向量 —— 值按插入序、名字就是键。
# 键那一条已经在影子变量里了，所以这一格就是"顺着键走一趟、逐格 dget"。
# 空表那一格 R 交的是 `NULL`（与 `names(空表)` 同一条）。
cat(unlist(tally), "\n")
print(unlist(tally))
cat(sum(unlist(tally)), length(unlist(tally)), "\n")
cat(max(unlist(tally)), min(unlist(tally)), "\n")
cat(names(unlist(tally)), "\n")
cat(sort(unlist(tally), decreasing = TRUE), "\n")
print(unlist(blank))
sv <- list()
sv[["x"]] <- "p"
sv[["y"]] <- "qq"
print(unlist(sv))
cat(unlist(sv), "\n")
cat(nchar(unname(unlist(sv))), "\n")

# **`u <- unlist(d)` 之后 `u[["a"]]` 也接了**（从前这一格把 `u` 推成一张表 ——
# `dictNames` 一看见 `[[…]]` 就那么认，而 R 里 `[[` 对**原子向量**同样合法）。
# 现在"一望而知造向量"的那几格调用（`VEC_MAKERS`）把名字从那张表里摘出来。
ud <- list(a = 1, b = 2)
uu <- unlist(ud)
print(uu)
cat(names(uu), "\n")
cat(uu[["a"]], uu["a"], sum(uu), "\n")
cat(sort(uu), "\n")
us <- sort(c(3, 1, 2))
cat(us[[1]], us[[3]], "\n")
ur <- rev(c(1, 2, 3))
cat(ur[[1]], "\n")
