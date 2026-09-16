;; 函数表 + `call_indirect`。这一格原来在 bad/ 的边界里（"表、call_indirect、br_table
;; 一律不认"），而那条边界的价钱**记错过三遍**：先是"OIR 没有按值调用"（错，有 CallFn），
;; 再是"欠按函数号调用，要动四个文件"（`CALLI` 收的是**MIR 的**函数号 + 1，让前端假设
;; 那个编号就是把隐藏契约埋在两个模块之间）。
;;
;; 真正的办法用掉了这一层已经知道的事实：**表是常量**（`table.set` 不认，`(elem …)`
;; 是静态的）。于是 `call_indirect` 在这儿就化得开 —— 按签名合成一格「按下标选一个
;; 直接调用」的函数，每格签名对得上的表项一条 `if (t == i) return f(a…)`。
;; OIR / MIR 一格都没动，所以四条腿（interp / omni-js / omni-c / V8）自动都认。
;;
;; 这一份压住四件事：
;;   * 下标**从形参来**（`$apply`）—— 编译期看不出走的是哪一格；
;;   * 同一张表上**两种元数**（一元的 `$un`、二元的 `$bin`）各一格选择函数；
;;   * **不出值**的那种签名（`$show`）在语句位置调用 —— 而它与 `$un` 是**不同的签名**，
;;     所以 0/1 两格不进它的链（wasm 的签名检查就是这么回事）；
;;   * 内联签名写法（`(param i64)` 直接写在 `call_indirect` 上，不引 `(type …)`）。
(module
  (import "omni" "print_i64" (func $p (param i64)))

  (type $un (func (param i64) (result i64)))
  (type $bin (func (param i64) (param i64) (result i64)))

  (table 4 funcref)
  (elem (i32.const 0) $inc $ten $show $add)

  (func $inc (param $x i64) (result i64)
    (return (i64.add (local.get $x) (i64.const 1))))

  (func $ten (param $x i64) (result i64)
    (return (i64.mul (local.get $x) (i64.const 10))))

  ;; 不出值的那一格：印一行就完
  (func $show (param $x i64)
    (call $p (local.get $x)))

  (func $add (param $a i64) (param $b i64) (result i64)
    (return (i64.add (local.get $a) (local.get $b))))

  ;; 函数值 = 表下标，从形参传进来
  (func $apply (param $f i64) (param $x i64) (result i64)
    (return (call_indirect (type $un) (local.get $x) (i32.wrap_i64 (local.get $f)))))

  (func $main
    (local $i i64)
    (local.set $i (i64.const 0))
    (call $p (call $apply (local.get $i) (i64.const 7)))
    (local.set $i (i64.const 1))
    (call $p (call $apply (local.get $i) (i64.const 7)))
    ;; 语句位置 + 内联签名（不出值）：走第 2 格
    (call_indirect (param i64) (i64.const 5) (i32.const 2))
    ;; 二元那一格
    (call $p (call_indirect (type $bin) (i64.const 3) (i64.const 4) (i32.const 3))))

  (export "main" (func $main)))
