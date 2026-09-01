;; 访存要先有一块内存 —— 这是第四刀之后的新边界（内存本身已经认了）
(module
  (import "omni" "print_i32" (func $pi (param i32)))
  (func $main (export "main")
    (call $pi (i32.load (i32.const 0)))))
