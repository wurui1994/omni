;;; ext/sbcl/examples/record.lisp —— 与 go / lua / V / nim / cpp 那五份 record **同一件事**
;;;
;;; 期望输出逐行相同：1 / 5 / 6。
;;;
;;; 这一份的看点是 CL（与 Scheme）在记录那一格上**唯一的难处**：字段名不写在使用处，
;;; 而是 `(defstruct point x y)` **一句话生成一族名字** —— 构造器 `make-point`、
;;; 访问器 `point-x` / `point-y`，还有 `(setf (point-y p) …)` 那个位置。
;;;
;;; 落到图上仍然只有现成的三格（record-new / field-get / field-set），一格新节点都没加：
;;; 那一族名字是**映射**登记下来的（`ext/sbcl/tograph.js` 的 `STRUCTS`）。
;;; 所以这一份同时是 `nodes.js` 里 record 那三格头一句"与类型无关"的又一份证据 ——
;;; CL 的 defstruct 有类型、lua 的表没有，两边落的是同一格。

(defstruct point x y)

(defvar p (make-point :x 1 :y 2))
(princ (point-x p))
(setf (point-y p) 5)
(princ (point-y p))
(princ (+ (point-x p) (point-y p)))
