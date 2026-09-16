;;; ext/sbcl/examples/conv.lisp —— 与 go / V / nim / mojo / FB / cpp 那几份 conv **同一件事**
;;;
;;; 期望输出逐行相同：2 / 3.5。
;;; CL 的转换也是一族函数名（`truncate` / `float`），落的是同一格 `conv`（目标是附属）。
;;;
;;; 明说一格：`(truncate x)` 在 CL 里**回两格值**（商与余），而这儿只落第一格 ——
;;; 那正是单值上下文里 CL 自己的规矩（`(princ (truncate …))` 印的就是商）。
;;; 要第二格得写 `(nth-value 1 …)`，那一格另有判据（`dict.lisp` 里那条）。

(princ (truncate (/ 7.0 3.0)))
(princ (/ (float 7) 2))
