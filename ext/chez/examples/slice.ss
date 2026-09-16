;; ext/chez/examples/slice.ss —— 与 go / V / nim / mojo / CL 那几份 slice **同一件事**
;;
;; 期望输出逐行相同：20 / 30。
;; Scheme 的写法是一格**函数调用**（`(vector-copy v 1 3)`），go 写 `xs[1:3]` ——
;; 落的是**同一格 slice 节点**。R6RS/R7RS 的规矩与图上一模一样：**上界不含、0 起**，
;; 所以这一门的映射一格都不用调（nim 的 `..` 含上界，那 +1 归 nim 自己）。

(define xs (vector 10 20 30 40))
(define ys (vector-copy xs 1 3))
(display (vector-ref ys 0))
(display (vector-ref ys 1))
