;; i64 的无符号一族要真正的 64 位无符号，int64 表示不出来
(module
  (func $main (export "main") (result i64)
    (i64.div_u (i64.const -1) (i64.const 3))))
