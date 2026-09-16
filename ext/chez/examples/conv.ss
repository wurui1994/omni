;; ext/chez/examples/conv.ss —— 与 go / V / nim / mojo / FB / cpp / CL 那几份 conv **同一件事**
;;
;; 期望输出逐行相同：2 / 3.5。
;; Scheme 的转换也是一族函数名（`exact` / `truncate` / `exact->inexact`），
;; 落的是同一格 `conv`（目标类型是一格附属，不是端口）。
;;
;; 明说一格：图上**没有精确/非精确这一格**（只有整数与实数），所以 `exact` 与 `truncate`
;; 都落 `conv to=int`。那个差别在 Scheme 里看得见（`(truncate 2.3)` 是 `2.0`、
;; `(exact 2.0)` 是 `2`），在图上看不见 —— 于是这份例子挑的是**两家印出来一样**的形状。

(display (exact (truncate (/ 7.0 3.0))))
(display (/ (exact->inexact 7) 2))
