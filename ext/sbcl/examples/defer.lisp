;;; ext/sbcl/examples/defer.lisp —— 与 ext/go/examples/defer.go **同一件事**
;;;
;;; 期望输出逐行相同：in / b / a / out。
;;; CL 这一份用 `unwind-protect`，go 那一份用 `defer` —— **同一格 scope-exit 节点**。
;;; 逆序在这儿写成嵌套：里层的 `b` 先跑、外层的 `a` 后跑，与 go 的两条 defer 一样。

(defun demo ()
  (unwind-protect
      (unwind-protect
          (princ "in")
        (princ "b"))
    (princ "a")))

(demo)
(princ "out")
