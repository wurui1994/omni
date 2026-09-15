;; 跳外层的标签：`br` 到非最内层。这一格原来在 bad/ 里（当时的理由写着 "OIR has no
;; labeled break"），那句话是**错的** —— OIR 的 Break / Continue 本来就带一格 `level`
;; （1 = 最内层），四条腿全认：interp 的 `BREAK + OUTER*(level-1)`、MIR 的 `levelOf`、
;; C 与 js 的带标签 jump。而 WAT 前端把 `block` 与 `loop` **都**降成一格 `While(true)`，
;; 所以标签的距离就是循环的层数：`level = depth + 1`。
;;
;; 两格各压一条：
;;   $brk  —— `block` 的 br 跳两层 = break level 3（不然会在内层原地打转）
;;   $cont —— `loop` 的 br 从内层回外层 = continue level 2（不然外层的 i 加不上去）
(module
  (import "omni" "print_i64" (func $p (param i64)))

  (func $brk
    (block $out
      (loop $a
        (loop $b
          (call $p (i64.const 1))
          (br $out)))))

  (func $cont (result i64)
    (local $i i64)
    (loop $o
      (if (i64.lt_s (local.get $i) (i64.const 3))
        (then
          (local.set $i (i64.add (local.get $i) (i64.const 1)))
          (loop $in
            (br $o)))))
    (local.get $i))

  (func $main
    (call $brk)
    (call $p (i64.const 2))
    (call $p (call $cont)))

  (export "main" (func $main)))
