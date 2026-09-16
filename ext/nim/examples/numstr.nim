## ext/nim/examples/numstr.nim —— 与 ext/lua/examples/numstr.lua **同一件事**
##
## 期望输出逐行相同：n=7 / i=42。
## nim 要**显式**转（`$x`）—— 那一格落 `conv`（目标 `str`）；lua 是隐式的（`..` 直接混着数用），
## 落的是内建 `concat`。图上两格不同、印出来一样 —— "写法归语言"这一条在这儿是**两格节点
## 都得对**，不是一格节点两种写法。

echo "n=" & $7
let i = 42
echo "i=" & $i
