;;; ext/sbcl/examples/values.lisp —— **多值**那两格的第三、四个提供者（第十个例子家族）
;;;
;;; 期望输出（家族里所有语言、所有后端逐行相同）：3 / 7。
;;;
;;; CL 是四门语言里**唯一有专门形式**的：`values` 与 `multiple-value-bind`。
;;; go / lua 靠 `return a, b`、nim 靠元组 —— 落到的是同一对节点
;;; （生产侧一格 `values`、消费侧一格临时 bind + 一串 `pick`）。
;;;
;;; 与 `examples/multi.*` 那个家族的差别：那一份还压了"实参表里只有最后一格展开"
;;; （`print(f())`），而 CL 的 `princ` 遇到多值只印第一格、nim 的 `echo` 印的是元组 ——
;;; 硬凑成同一份输出就是替它们编语义，所以这一格单开一个家族，只压产生与消费。

(defun minmax (a b)
  (if (< a b) (values a b) (values b a)))

(multiple-value-bind (lo hi) (minmax 7 3)
  (princ lo)
  (princ hi))
