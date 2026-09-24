# ext/r/rt/bootstrap-meta.R —— 自举那一格：**只用 base** 给每个包写出 `Meta/package.rds`。
#
# 为什么要它：`loadNamespace()` 读 `Meta/package.rds`（`pkgInfo`），而那份 rds 在 R 自己的
# 构建里是 `tools:::.vinstall_package_descriptions_as_RDS` 写的 —— 可那个函数在 tools 包里，
# 而加载 tools 又要先有它的 `package.rds`。R 自己的 Makefile 把这一格叫
# "bootstrapping problem here: tools uses tools to dump its namespace"。
#
# 我们这一版的解法是把**第一轮**自己做掉：`read.dcf` 就在 base 里，
# `saveRDS` 也在 base 里，所以这一份脚本不 `library()` 任何东西。
# 写完之后 tools 就加载得动了，再让 R 自己那两个函数重写一遍（那一份才是正本）。
#
# 只写 `package.rds`，**不写 `nsInfo.rds`** —— 后者缺了 `loadNamespace` 会退回去现场解析
# `NAMESPACE`（base 的 `parseNamespaceFile`），那条路是对的、只是慢一点。
#
# 用法：R --vanilla --no-echo -f bootstrap-meta.R --args <library 目录> <包名> ...

args <- commandArgs(trailingOnly = TRUE)
lib <- args[1L]
pkgs <- args[-1L]

## "pkg (>= 1.2), other" -> 一个**带名字**的表。名字要紧：`loadNamespace` 拿
## `names(pkgInfo$Depends)` 判断要不要顺带加载 methods。
parse_deps <- function(field) {
    if (is.na(field) || !nzchar(field)) return(list())
    parts <- strsplit(field, ",")[[1L]]
    parts <- trimws(parts)
    parts <- parts[nzchar(parts)]
    nms <- sub("[ (].*$", "", parts)
    out <- vector("list", length(nms))
    names(out) <- nms
    out
}

for (p in pkgs) {
    dir <- file.path(lib, p)
    dcf <- file.path(dir, "DESCRIPTION")
    if (!file.exists(dcf)) {
        cat("bootstrap-meta: 没有 DESCRIPTION：", dir, "\n", sep = "")
        next
    }
    d <- read.dcf(dcf)[1L, ]
    get <- function(k) if (k %in% names(d)) d[[k]] else NA_character_
    info <- list(
        DESCRIPTION = d,
        Built = list(R = paste(R.version$major, R.version$minor, sep = "."),
                     Platform = R.version$platform,
                     Date = format(Sys.time()),
                     OStype = .Platform$OS.type),
        Rdepends = NULL,
        Rdepends2 = list(),
        Depends = parse_deps(get("Depends")),
        Suggests = parse_deps(get("Suggests")),
        Imports = parse_deps(get("Imports"))
    )
    dir.create(file.path(dir, "Meta"), showWarnings = FALSE, recursive = TRUE)
    saveRDS(info, file.path(dir, "Meta", "package.rds"))
    ## 带 `libs/` 的包还要一份 `features.rds`：里头的 `internalsID` 与当前这个 R 的
    ## `.Internal(internalsID())` 一样，`loadNamespace` 才肯加载那份 `.so`
    ## （不然报的是"installed by an R version with different internals"）。
    ## 这一格正是"我们自己编的 R 装我们自己编的包"—— 两边的内部表示本来就是同一份。
    if (dir.exists(file.path(dir, "libs"))) {
        saveRDS(list(internalsID = .Internal(internalsID())),
                file.path(dir, "Meta", "features.rds"))
    }
    ## `nsInfo.rds`：解析过的 NAMESPACE。`parseNamespaceFile` 就在 base 里
    ## （`tools:::.vinstall_package_namespaces_as_RDS` 用的也是它），所以这一格也能自举。
    ##
    ## **不能省**：少了它 `loadNamespace` 会退回去现场解析 NAMESPACE，而那条路上
    ## `useDynLib` 的 `.so` 加载与 R 代码的 source 次序与正装不同 —— tools 的 `zzz.R`
    ## 有一句顶层的 `getDLLRegisteredRoutines("tools")`，DLL 还没加载时它拿到的是 NULL，
    ## 症状是 `.Call(PS_sigs, 1L)` 报"第一个参数得是字符串或本机符号"。
    if (file.exists(file.path(dir, "NAMESPACE"))) {
        ok <- tryCatch({
            saveRDS(parseNamespaceFile(p, lib), file.path(dir, "Meta", "nsInfo.rds"))
            TRUE
        }, error = function(e) {
            cat("bootstrap-meta: ", p, " 的 NAMESPACE 解析不了（", conditionMessage(e),
                "）—— 这一格先留空，loadNamespace 会现场解析\n", sep = "")
            FALSE
        })
        invisible(ok)
    }
}
cat("bootstrap-meta: 写了", length(pkgs), "份 package.rds\n")
