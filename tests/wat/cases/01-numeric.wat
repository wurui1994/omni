;; 数值与控制流的基本盘：i32/i64/f64 各一族，if/block/loop 各一次。
;; 这份文件同时是"折叠形式"的样例 —— 平铺的栈式写法这一阶段不认。
(module
  (import "omni" "print_i32" (func $pi (param i32)))
  (import "omni" "print_i64" (func $pl (param i64)))
  (import "omni" "print_f64" (func $pf (param f64)))

  ;; i32 的回绕：符号扩展的表示下，加法要压回 32 位
  (func $wrap (result i32)
    (i32.add (i32.const 2147483647) (i32.const 1)))

  ;; 无符号那一族靠零扩展：0xffffffff 就是 -1，无符号比较里它最大
  (func $unsigned (result i32)
    (i32.lt_u (i32.const -1) (i32.const 1)))

  (func $shifts (result i32)
    (i32.shr_u (i32.const -1) (i32.const 28)))

  (func $fib (param $n i64) (result i64)
    (if (i64.lt_s (local.get $n) (i64.const 2))
      (then (return (local.get $n))))
    (i64.add
      (call $fib (i64.sub (local.get $n) (i64.const 1)))
      (call $fib (i64.sub (local.get $n) (i64.const 2)))))

  ;; loop：br 回到开头，落到底就出去
  (func $sum (param $n i64) (result i64)
    (local $i i64) (local $acc i64)
    (loop $again
      (local.set $acc (i64.add (local.get $acc) (local.get $i)))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $again (i64.le_s (local.get $i) (local.get $n))))
    (local.get $acc))

  ;; block：br 是跳出去
  (func $first_multiple (param $n i32) (result i32)
    (local $i i32)
    (block $done
      (loop $next
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $next (i32.ne (i32.rem_s (local.get $i) (local.get $n)) (i32.const 0)))))
    (local.get $i))

  ;; 导出名里带转义（\61 = 'a'）：入口按解码后的 "main" 找，顺带把字符串解码那条路走一遍
  (func $main (export "m\61in")
    (call $pi (call $wrap))
    (call $pi (call $unsigned))
    (call $pi (call $shifts))
    (call $pl (call $fib (i64.const 20)))
    (call $pl (call $sum (i64.const 100)))
    (call $pi (call $first_multiple (i32.const 7)))
    (call $pi (i32.wrap_i64 (i64.const 4294967298)))
    (call $pl (i64.extend_i32_u (i32.const -1)))
    (call $pl (i64.extend_i32_s (i32.const -1)))
    (call $pf (f64.div (f64.convert_i64_s (i64.const 1)) (f64.const 3)))
    (call $pf (f64.neg (f64.const 2.5)))
    (call $pl (i64.trunc_f64_s (f64.const -7.9)))
    (call $pi (i32.div_u (i32.const -1) (i32.const 3)))
    (call $pi (i32.eqz (i32.const 0)))
    ;; WAT 允许把值写成无符号的：这两条都是 -1
    (call $pl (i64.const 0xffff_ffff_ffff_ffff))
    (call $pi (i32.const 0xffffffff)))
)
