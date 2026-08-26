;; 带 result 的 block 是表达式，不是语句
(module
  (func $main (export "main") (result i32)
    (block $b (result i32) (i32.const 1))))
