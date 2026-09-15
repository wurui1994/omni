;; ext/chez/examples/intmath.ss —— 与另外七门那几份 intmath **同一件事**
;;
;; 期望输出逐行相同：15 / 120。
;; Scheme 这一份压的是别人没有的一格：**`if` 是表达式**（函数体最后一格就是返回值）。
;; wasm 那边 block 不带 result，所以那一格落成"一格临时量 + 两支各赋值" ——
;; 临时量本来就是调度器算出来的四样之一（ADR-0033 §3.5），不是新语义。
;;
;; 循环还是递归（Scheme 没有 while），而且**只用顶层 define** ——
;; 嵌套的 define 是闭包，那一格 wasm 还没接（缺口清单上有名字）。

(define (sum-go i n acc)
  (if (> i n) acc (sum-go (+ i 1) n (+ acc i))))

(define (sumto n) (sum-go 1 n 0))

(define (fact n)
  (if (= n 0) 1 (* n (fact (- n 1)))))

(display (sumto 5))
(display (fact 5))
