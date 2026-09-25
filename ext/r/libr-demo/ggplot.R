# ext/r/libr-demo/ggplot.R —— libR 那一档的例子：装进来的 CRAN 包 + R 自己的设备
#
# 跑法：`omni run ext/r/libr-demo/ggplot.R` —— 编译器那一档接不住（`library(ggplot2)`），
# `omni run` 自己换到 libR 那一档（`ext/r/libr-run.js`），不用手敲 R_HOME 与那串旗子。
# 前提是先 `node ext/r/build-libR.js` 与 `node ext/r/install-cran.js`。
#
# 这一份**不进 `tests/r/oracle.js`**（那一轴是编译器那一档、逐字节对 Rscript，而这儿用的
# 是 ggplot2）。它的判据在 `tests/r/libr.js` 里。

library(ggplot2)

d <- data.frame(
  x = 1:20,
  y = c((1:10)^2, rev((1:10)^2)),
  g = rep(c("up", "down"), each = 10)
)

p <- ggplot(d, aes(x, y, colour = g)) +
  geom_point(size = 2.5) +
  geom_smooth(method = "loess", formula = y ~ x, se = TRUE, alpha = 0.15) +
  labs(
    title = "ggplot2 on a libR we built ourselves",
    subtitle = sprintf("ggplot2 %s / %s", packageVersion("ggplot2"), R.version.string),
    x = "x", y = "y", colour = NULL
  ) +
  theme_minimal(base_size = 11)

out <- file.path(tempdir(), "omni-libr-ggplot.pdf")
ggsave(out, p, width = 6, height = 4)
cat("PDF:", out, file.size(out), "字节\n")

# `quartz()` 那一档是**真窗口**（R 自己的 Cocoa 设备：`devQuartz.c` + `qdCocoa.m`，
# 它自己建 NSWindow、靠 `ptr_R_ProcessEvents` 协作抽事件）。要开窗就把 OMNI_R_WINDOW 设上
# —— 没有窗口服务的场合（ssh / CI）开它会报错，所以默认不开。
if (nzchar(Sys.getenv("OMNI_R_WINDOW"))) {
  quartz(width = 6, height = 4, title = "omni libR")
  print(p)
  cat("设备:", paste(names(dev.list()), collapse = ","), "\n")
  Sys.sleep(as.numeric(Sys.getenv("OMNI_R_WINDOW_SECS", "3")))
  dev.off()
}
