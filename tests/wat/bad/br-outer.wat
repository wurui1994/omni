;; OIR 只有 break/continue，跳非最内层的标签翻不出来
(module
  (func $main (export "main")
    (block $out
      (loop $in
        (br $out)))))
