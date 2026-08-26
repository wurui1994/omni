;; f32 不认：OIR 只有 double，硬塞会在舍入上撒谎
(module (func $main (export "main") (param $x f32)))
