;;; ext/sbcl/examples/dict.lisp —— 与 go / V / awk / nim / lua / Scheme 那几份 dict **同一件事**
;;;
;;; 期望输出逐行相同：1 / 3 / 4 / yes。
;;; CL 的记号有两处与别人都不同，而两处都**只是记号**：
;;;   * 键写在表**前面**（`(gethash k m)`），别的门是 `m[k]`；
;;;   * "在不在"是 `gethash` 的**第二格返回值**（`(nth-value 1 …)`）——
;;;     go 写 comma-ok、V 写 `in`、nim 写 `hasKey`、Scheme 写 `hashtable-contains?`。
;;; 七种写法落到的是同一批 map 节点。键是**值**（这儿是符号），不是名字。
;;;
;;; 用符号当键而不是串：`make-hash-table` 默认的比较是 `eql`，串在 CL 里要
;;; `:test #'equal` 才认得出同值 —— 例子不许写"在真 CL 上跑不对"的代码。

(defparameter m (make-hash-table))
(setf (gethash 'a m) 1)
(setf (gethash 'b m) 3)
(princ (gethash 'a m))
(princ (gethash 'b m))
(setf (gethash 'c m) 4)
(princ (gethash 'c m))
(if (nth-value 1 (gethash 'a m)) (princ "yes"))
