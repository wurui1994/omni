## ext/nim/examples/strcat.nim —— 与 lua / go / V 那三份 strcat **同一件事**
##
## 期望输出逐行相同：ab / hi there。
## nim 的串接是 `&`（数的 `+` 与它是两个算符）—— 映射的算符表里 `&` 直接映到 `concat`
## 那格内建，所以图上与 lua 的 `..`、go 的 `+` 落在同一处。

echo "a" & "b"
let s = "hi"
echo s & " " & "there"
