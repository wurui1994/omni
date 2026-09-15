;;; ext/sbcl/examples/basics.lisp —— 与 chez / lua / go 那三份**同一件事**
;;;
;;; 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
;;; 这一份与 chez 那份的价值在于**对照**：两门语言的树形状一样、词汇不同
;;; （defun / setq / princ vs define / set! / display），落到的节点完全相同。
;;; 而且它顺手压一格 chez 那份没压到的：`dotimes` —— CL 的计数循环，
;;; 落成 region + loop + set（`loop` 那一格因此在四门语言里都有语料）。
;;;
;;; 要素对照：
;;;   defun          -> bind + func
;;;   let            -> region + bind
;;;   dotimes        -> region + loop + set（不给它开节点）
;;;   setq           -> set
;;;   if             -> branch（两支是 lazy 端口）
;;;   + - * > =      -> prim
;;;   princ          -> prim print

(defun sumto (n)
  (let ((acc 0))
    (dotimes (i n)
      (setq acc (+ acc i 1)))
    acc))

(defun fact (n)
  (if (= n 0) 1 (* n (fact (- n 1)))))

(defun max2 (a b)
  (if (> a b) a b))

(princ (sumto 5))
(princ (fact 5))
(princ (max2 3 7))

(let ((tag "ok"))
  (princ tag))
