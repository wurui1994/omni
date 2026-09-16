;;; ext/sbcl/examples/slice.lisp —— 与 go / V / nim / mojo 那四份 slice **同一件事**
;;;
;;; 期望输出逐行相同：20 / 30。
;;; CL 的写法是一格**函数调用**（`(subseq v 1 3)`），go 写 `xs[1:3]`、nim 写 `xs[1 .. 2]`
;;; —— 落的是**同一格 slice 节点**。而且 CL 这一条的规矩与图上一模一样：
;;; **上界不含、下标 0 起**，所以这一门的映射一格都不用调（nim 那门要 +1）。

(defparameter xs (vector 10 20 30 40))
(defparameter ys (subseq xs 1 3))
(princ (aref ys 0))
(princ (aref ys 1))
