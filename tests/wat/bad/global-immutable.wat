;; 不可变的全局写不得 —— 这是 wasm 校验器的规则，不是我们加的限制
(module
  (global $k i32 (i32.const 7))
  (func $main (export "main")
    (global.set $k (i32.const 8))))
