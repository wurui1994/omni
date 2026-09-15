;;; ext/sbcl/examples/index.lisp —— 与另外五门那几份 index 例子**同一件事**
;;;
;;; 期望输出逐行相同：10 / 30 / 45。
;;; CL 这一份多压一格别的语言没有的：**`setf` 的广义位置** ——
;;; `(setf (aref xs 1) 5)` 的左边是一格形式，不是名字。图上它就是 `index-set`
;;; （与 go 的 `xs[1] = 5`、lua 的 `xs[2] = 5` 同一格节点）。

(defparameter xs (vector 10 20 30))
(princ (aref xs 0))
(princ (aref xs 2))
(setf (aref xs 1) 5)

(defparameter s 0)
(dotimes (i 3)
  (setq s (+ s (aref xs i))))
(princ s)
