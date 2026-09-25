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
