(; 词法与控制流的边角：块注释、十六进制字面量、数字下标、local.tee、if/else 嵌套。
   这份用例的重点不是算得对，是**读得对** —— 往返轴会把它读写读一遍。 ;)
(module
  (import "omni" "print_i64" (func $p (param i64)))

  ;; 数字下标：0 号是参数 $a，1 号是参数（匿名），2 号是局部量
  (func $mix (param $a i64) (param i64) (result i64)
    (local i64)
    (local.set 2 (i64.mul (local.get 0) (local.get 1)))
    (i64.add (local.get 2) (i64.const 0x10)))

  ;; local.tee：赋值同时留下值。刻意不在同一条指令里既 tee 又读同一个局部量 ——
  ;; 求值顺序在 OIR 里没有钉死（C 的实参顺序是 unspecified），见前端文件头的边界。
  (func $tee (result i64)
    (local $x i64)
    (local.set $x (i64.const 5))
    (i64.add (local.tee $x (i64.const 7)) (i64.const 1)))

  ;; if/else 嵌套 + 六个有符号比较
  (func $sign (param $n i64) (result i64)
    (if (i64.lt_s (local.get $n) (i64.const 0))
      (then (return (i64.const -1)))
      (else
        (if (i64.gt_s (local.get $n) (i64.const 0))
          (then (return (i64.const 1))))))
    (i64.const 0))

  (func $cmps (result i64)
    (local $c i64)
    (local.set $c (i64.extend_i32_s (i64.eq (i64.const 1) (i64.const 1))))
    (local.set $c (i64.add (local.get $c) (i64.extend_i32_s (i64.ne (i64.const 1) (i64.const 2)))))
    (local.set $c (i64.add (local.get $c) (i64.extend_i32_s (i64.le_s (i64.const 1) (i64.const 1)))))
    (local.set $c (i64.add (local.get $c) (i64.extend_i32_s (i64.ge_s (i64.const 1) (i64.const 1)))))
    (local.set $c (i64.add (local.get $c) (i64.extend_i32_s (i64.eqz (i64.const 0)))))
    (local.get $c))

  ;; 互递归：声明是两遍扫的，所以往前引用没问题
  (func $even (param $n i64) (result i64)
    (if (i64.eqz (local.get $n)) (then (return (i64.const 1))))
    (call $odd (i64.sub (local.get $n) (i64.const 1))))
  (func $odd (param $n i64) (result i64)
    (if (i64.eqz (local.get $n)) (then (return (i64.const 0))))
    (call $even (i64.sub (local.get $n) (i64.const 1))))

  (func $start
    (call $p (call $mix (i64.const 6) (i64.const 7)))
    (call $p (call $tee))
    (call $p (call $sign (i64.const -9)))
    (call $p (call $sign (i64.const 0)))
    (call $p (call $sign (i64.const 9)))
    (call $p (call $cmps))
    (call $p (call $even (i64.const 10)))
    (call $p (call $odd (i64.const 10))))

  ;; 入口用 start 段，不靠导出名
  (start $start)
)
