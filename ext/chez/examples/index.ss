;; ext/chez/examples/index.ss —— 与 lua / go / V / nim 那四份 index 例子**同一件事**
;;
;; 期望输出逐行相同：10 / 30 / 45。
;; Scheme 的 `(vector …)` / `vector-ref` / `vector-set!` 写起来像三个函数调用，
;; 落到的却是 `list-new` / `index-get` / `index-set` 那三格 —— **内建不是调用**
;; （与 `display` 落 `prim print` 同一条：语法的形状 ≠ 节点的格数）。
;;
;; 这一份没有 `while`：Scheme 的循环是递归，所以求和那一段用 `go`。

(define xs (vector 10 20 30))
(display (vector-ref xs 0))
(display (vector-ref xs 2))
(vector-set! xs 1 5)

(define (sum i acc)
  (if (< i 3) (sum (+ i 1) (+ acc (vector-ref xs i))) acc))
(display (sum 0 0))
