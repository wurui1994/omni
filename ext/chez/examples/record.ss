;;; ext/chez/examples/record.ss —— 与 go / lua / V / nim / cpp / CL 那六份 record **同一件事**
;;;
;;; 期望输出逐行相同：1 / 5 / 6。
;;;
;;; Scheme 在记录那一格上的难处与 CL 一样：字段名不写在使用处，而是
;;; `(define-record-type point (fields x y))` **一句话生成一族名字** ——
;;; `make-point` / `point-x` / `point-x-set!`（R6RS 的生成规则，Chez 自带的就是这一套）。
;;;
;;; 落到图上仍然只有现成的三格（record-new / field-get / field-set），一格新节点都没加：
;;; 那一族名字由映射登记（`ext/chez/tograph.js` 的 `RECORDS`）。
;;; R7RS 那种"名字写在形式里"的写法同一份映射也收 —— 两种写法在同一门语言里都合法。

(define-record-type point (fields x y))

(define p (make-point 1 2))
(display (point-x p))
(point-y-set! p 5)
(display (point-y p))
(display (+ (point-x p) (point-y p)))
