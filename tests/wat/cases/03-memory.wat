;; 线性内存与全局量（ADR-0017 第四刀）。同一套内存语义在第二刀里是从核心方言 sx
;; 长出来的；这一份用 wasm 自己的写法把它再走一遍 —— 于是那套语义有了第二个
;; 互不相干的前端来证。三个执行器（omni-js / omni-c / interp）的输出必须逐字节相同。
;;
;; 期望值是按 wasm 规范手算的（node 跑不了 .wat，这条轴没有外部参照）。
(module
  (import "omni" "print_i32" (func $pi (param i32)))
  (import "omni" "print_i64" (func $pl (param i64)))
  (import "omni" "print_f64" (func $pf (param f64)))

  (memory 2 4)
  ;; 第 0 页按约定保留（C 的空指针要能与它区分），所以段落在 65536。
  ;; 字节写成整数或字符串 —— WAT 的 \hh 转义不认，理由见 frontend-wat/lower.js。
  (data (i32.const 65536) 1 2 3 4)
  (data (i32.const 65552) "AB")

  (global $sp (mut i32) (i32.const 131072))
  (global $k i32 (i32.const 7))

  (func $main (export "main")
    ;; data 段进去了，而且读是小端：01 02 03 04 -> 0x04030201
    ;; align= 读了就丢（wasm 里它只是给引擎的优化提示，不改语义）
    (call $pi (i32.load align=4 (i32.const 65536)))
    ;; 逐字节读，第二个用 offset= 立即数
    (call $pi (i32.load8_u (i32.const 65536)))
    (call $pi (i32.load8_u offset=3 (i32.const 65536)))
    ;; 字符串段：'A' 'B'
    (call $pi (i32.load8_u (i32.const 65552)))
    (call $pi (i32.load8_u offset=1 (i32.const 65552)))

    ;; 写满 8 个字节的 -1，再窄读：_u 零扩展、_s 符号扩展
    (i64.store (i32.const 65600) (i64.const -1))
    (call $pi (i32.load8_u (i32.const 65600)))
    (call $pi (i32.load8_s (i32.const 65600)))
    ;; i64.load32_u 是唯一的满宽无符号读法（wasm 里没有 i32.load32_u）
    (call $pl (i64.load32_u (i32.const 65600)))
    (call $pl (i64.load32_s (i32.const 65600)))

    ;; 窄写只留低位：300 的低 8 位是 44
    (i32.store8 (i32.const 65608) (i32.const 300))
    (call $pi (i32.load8_u (i32.const 65608)))

    ;; f64 原样进出
    (f64.store (i32.const 65616) (f64.const 1.25))
    (call $pf (f64.load (i32.const 65616)))

    ;; 全局量：可变的读写、不可变的读
    (call $pi (global.get $sp))
    (global.set $sp (i32.sub (global.get $sp) (i32.const 16)))
    (call $pi (global.get $sp))
    (call $pi (global.get $k))
    ;; 影子栈就是这个形状：一个全局当栈指针，帧上的字节在线性内存里
    (i64.store (global.get $sp) (i64.const 42))
    (call $pl (i64.load (global.get $sp)))

    ;; 页数：声明 2 页；grow 回**旧**页数；新长出来的一页是清零的
    (call $pi (memory.size))
    (call $pi (memory.grow (i32.const 1)))
    (call $pi (memory.size))
    (call $pi (i32.load (i32.const 131072)))
    ;; 上界是 4 页，现在 3 页，再要 2 页 -> -1（不报错，wasm 的约定）
    (call $pi (memory.grow (i32.const 2)))
  )
)
