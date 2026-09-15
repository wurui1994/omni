;;; ext/sbcl/examples/intmath.lisp —— 与另外七门那几份 intmath **同一件事**
;;;
;;; 期望输出逐行相同：15 / 120。
;;; 与 chez 那一份对着看：树的形状一样、词汇不同（defun / princ vs define / display），
;;; 落到的节点完全相同 —— 连"`if` 出值要物化成一格临时量"那一步也是同一步。

(defun sum-go (i n acc)
  (if (> i n) acc (sum-go (+ i 1) n (+ acc i))))

(defun sumto (n) (sum-go 1 n 0))

(defun fact (n)
  (if (= n 0) 1 (* n (fact (- n 1)))))

(princ (sumto 5))
(princ (fact 5))
