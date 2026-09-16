;;; ext/sbcl/examples/blockret.lisp —— **CL 独有的那一格：早退是"从带名字的块里返回"**
;;;
;;; 期望输出逐行相同：15 / 6 / 7。
;;;
;;; 单开一个家族的理由与 `deferarg`（go 独有）同一条：**别的九门写不出这个形状**。
;;; 而这一份要证的正好相反 —— 形状独一门，落到的节点**一格新的都没加**：
;;;   `(return)`（= `(return-from nil)`）在循环里  -> loop-exit break（与 go 的 break 同一格）
;;;   `(return-from max2 a)` 在 defun 里          -> ret（与 go 的 return 同一格）
;;; CL 的两种块（函数那格、循环那格 `nil`）图上本来都有，所以不需要"带标签的早退"。
;;; 跨层的早退（从里层块跳到外层）当场报 —— 那才是真要标签的形状，不猜。

(defparameter s 0)
(defparameter i 0)
(dotimes (k 100)
  (setq i (+ i 1))
  (if (> i 5) (return))
  (setq s (+ s i)))
(princ s)
(princ i)

(defun max2 (a b)
  (if (> a b) (return-from max2 a))
  b)
(princ (max2 3 7))
