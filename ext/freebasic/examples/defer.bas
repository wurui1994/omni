' ext/freebasic/examples/defer.bas —— 与 go / V / nim / CL / mojo 那五份 defer 例子**同一件事**
'
' 期望输出逐行相同：in / b / a / out。
'
' FB 没有 `defer`，它的出口动作写在**类型**上：`Declare Destructor()` 一句话说清
' "这个类型的量出了作用域要跑一段"。于是 `Dim s As Say` 落成
' **一格 bind + 一格 scope-exit** —— 与 go 的 `defer`、mojo 的 `with` 是同一格节点。
' 析构体自己是一格普通函数（形参就叫 `This`，FB 里本来就这么写）。
'
' 逆序（后声明的先析构）与"`Exit Sub` 早退也跑"都是 scope-exit 那一格本来的语义，
' 映射一句都不用多说。一个类型两个量（靠一格 tag 字段分谁是谁）—— 同名方法要类型
' 才分得开，那笔账明写在映射里，例子不绕过它。

Type Say
    tag As Integer
    Declare Destructor()
End Type

Destructor Say()
    If This.tag = 1 Then
        Print "a"
    Else
        Print "b"
    End If
End Destructor

Sub demo()
    Dim s1 As Say
    Dim s2 As Say
    s1.tag = 1
    s2.tag = 2
    Print "in"
    Exit Sub
End Sub

demo()
Print "out"
