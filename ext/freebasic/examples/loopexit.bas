' ext/freebasic/examples/loopexit.bas —— 与 go / lua / V / nim / mojo / cpp / awk 那几份**同一件事**
'
' 期望输出逐行相同：12 / 6 / 8。
' FB 把两格早退写成 `Exit <块>` 与 `Continue <块>` —— 落的是**同一格 loop-exit**
' （差的只有一格附属 kind）。第二个循环压的是 **continue 与步进的关系**：
' `For` 的步进在 `loop` 的 `post` 端口上，`Continue For` 跳过体的剩下部分却**照跑步进**。

Dim s As Integer = 0
Dim i As Integer = 0
Do
    i = i + 1
    If i > 5 Then Exit Do
    If i = 3 Then Continue Do
    s = s + i
Loop
Print s
Print i

Dim t As Integer = 0
For j As Integer = 0 To 4
    If j = 2 Then Continue For
    t = t + j
Next
Print t
