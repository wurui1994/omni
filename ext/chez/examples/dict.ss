;; ext/chez/examples/dict.ss —— 与 go / V / awk / nim / lua 那几份 dict **同一件事**
;;
;; 期望输出逐行相同：1 / 3 / 4 / yes。
;; R6RS 的写法与别的门差得最远：**四个函数名**（`make-eqv-hashtable` /
;; `hashtable-set!` / `hashtable-ref` / `hashtable-contains?`），go 是字面量 + comma-ok、
;; V 是 `in` 算子、nim 是 `hasKey` 方法、lua 是"用过串当键就算 map" ——
;; 六种记号，落到的是同一批 map 节点。键是**值**（这儿是符号），不是名字。
;;
;; 明说一格：`hashtable-ref` 的第三个实参是**默认值**，图上没有那一格（缺键就是错误），
;; 所以映射把它丢掉 —— 这份例子不缺键，两家的可观察行为一致。

(define m (make-eqv-hashtable))
(hashtable-set! m 'a 1)
(hashtable-set! m 'b 3)
(display (hashtable-ref m 'a #f))
(display (hashtable-ref m 'b #f))
(hashtable-set! m 'c 4)
(display (hashtable-ref m 'c #f))
(if (hashtable-contains? m 'a) (display "yes"))
