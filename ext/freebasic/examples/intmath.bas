' ext/freebasic/examples/intmath.bas —— 与另外六门那几份 intmath **同一件事**
'
' 期望输出逐行相同：15 / 120。
' `If n = 0` 里那个 `=` 是比较、`acc = acc + i` 里那个是赋值 —— 同一个记号，
' 按**位置**分（语句位置上顶着 `=` 的是赋值）。那一条在映射里，不在语法里。

Function sumto(n As Integer) As Integer
  Dim acc As Integer = 0
  For i As Integer = 1 To n
    acc = acc + i
  Next
  Return acc
End Function

Function fact(n As Integer) As Integer
  If n = 0 Then Return 1
  Return n * fact(n - 1)
End Function

Print sumto(5)
Print fact(5)
