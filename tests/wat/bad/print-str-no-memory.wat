;; 串那格宿主面**要读内存** —— 没有 (memory ...) 段就是模块写错了，明说
(module
  (import "omni" "print_str" (func $ps (param i32)))
  (func $main (export "main")
    (call $ps (i32.const 8))))
