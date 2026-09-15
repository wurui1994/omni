;; 宿主面的第四条：`print_str`。它是唯一一条**要读内存**的导入 —— wasm 侧没有字符串
;; 类型，字符串就是内存里的一块：**前 8 字节是长度，正文从 +8 起，一字节一格**。
;; 这份约定和图那侧的 wat 后端（src/core/graph/backend-wat.js）共用一份，所以这条测试
;; 同时钉住了两边。
;;
;; 三格：data 段里躺着的、运行期一字节一字节存出来的、长度为 0 的。
;; 期望值是手算的（node 跑不了 .wat，这条轴没有外部参照）。
(module
  (import "omni" "print_str" (func $ps (param i32)))
  (import "omni" "print_i64" (func $pl (param i64)))

  (memory 2)
  ;; 第 0 页保留，段落在 65536。长度 2 写成 8 个字节（小端），正文 "hi" 跟在后面。
  (data (i32.const 65536) 2 0 0 0 0 0 0 0)
  (data (i32.const 65544) "hi")

  (func $main (export "main")
    (call $ps (i32.const 65536))

    ;; 运行期拼一格："Omni!" —— 长度先写，正文逐字节写
    (i64.store (i32.const 65600) (i64.const 5))
    (i32.store8 (i32.const 65608) (i32.const 79))   ;; O
    (i32.store8 (i32.const 65609) (i32.const 109))  ;; m
    (i32.store8 (i32.const 65610) (i32.const 110))  ;; n
    (i32.store8 (i32.const 65611) (i32.const 105))  ;; i
    (i32.store8 (i32.const 65612) (i32.const 33))   ;; !
    (call $ps (i32.const 65600))

    ;; 长度 0 = 空串。那一格 while 一次都不转，印出来是一行空行
    (i64.store (i32.const 65700) (i64.const 0))
    (call $ps (i32.const 65700))

    ;; 读串不动内存：长度那 8 个字节还在
    (call $pl (i64.load (i32.const 65536)))
  )
)
