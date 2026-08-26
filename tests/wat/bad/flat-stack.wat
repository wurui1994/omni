;; 平铺的栈式写法这一阶段不认：只认折叠形式
(module
  (func $main (export "main") (result i32)
    i32.const 1
    i32.const 2
    i32.add))
