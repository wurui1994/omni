;; br 跳到函数体那一层等于 return，但带值的形式在折叠写法里会和 br_if 的条件抢位置
(module
  (func $main (export "main") (result i32)
    (block $b
      (br 1))
    (i32.const 0)))
