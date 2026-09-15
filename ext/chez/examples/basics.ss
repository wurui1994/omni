;; ext/chez/examples/basics.ss —— **含全部基础要素的一份完整例子**（第一批节点的语料）
;;
;; 十门语言各有一份同名的例子，形状随各自的写法，但**输出必须逐行相同**：
;;
;;   15
;;   120
;;   7
;;   ok
;;
;; 判据就是这四行（`tests/graph/run.js`）。它检的不是"我们收得下这门语言"，
;; 而是**同一张节点清单能承载不同语言的同一件事** —— 前端不同、图不同、eval 的输出相同。
;;
;; 要素对照（左边是这门语言的写法，右边是落到的节点）：
;;   define + 形参表        -> bind + func（decl 没有自己的节点）
;;   if / else              -> branch（两支是 lazy 端口，只算一支）
;;   递归（Scheme 的循环）   -> call（`loop` 那一格留给 lua / go 那种有 while 的语言）
;;   let                    -> region + bind
;;   + - * > =              -> binop / prim
;;   display                -> prim print（**print 不是节点**）

(define (sumto n)
  (define (go i acc)
    (if (> i n) acc (go (+ i 1) (+ acc i))))
  (go 1 0))

(define (fact n)
  (if (= n 0) 1 (* n (fact (- n 1)))))

(define (max2 a b)
  (if (> a b) a b))

(display (sumto 5))
(display (fact 5))
(display (max2 3 7))

(let ((tag "ok"))
  (display tag))
