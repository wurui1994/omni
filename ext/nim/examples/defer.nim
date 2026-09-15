## ext/nim/examples/defer.nim —— 与 go / sbcl / vlang 那三份 defer 例子**同一件事**
##
## 期望输出逐行相同：in / b / a / out。
## 到这儿 scope-exit 那一格已经有**四门语言、四种语法**落在同一格节点上了 ——
## G5 那条"提供者名单 ≥ 4 才算一台机器"（ADR-0033 §3.7）在这一格上成立。

proc demo() =
  defer: echo "a"
  defer: echo "b"
  echo "in"
  return

demo()
echo "out"
