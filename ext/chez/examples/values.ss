;; ext/chez/examples/values.ss —— 与 CL / nim / V 那几份 values 例子**同一件事**
;;
;; 期望输出逐行相同：3 / 7。
;; Scheme 的多值是**语言里的一格**（`values` + `let-values`），go / V 写成多返回值、
;; CL 写成 `(values …)` + `multiple-value-bind`、nim 写成元组 —— 生产侧落一格 `values`、
;; 消费侧落一串 `pick`，四门共用同一对节点。

(define (two) (values 3 7))

(let-values (((a b) (two)))
  (display a)
  (display b))
