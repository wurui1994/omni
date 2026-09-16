' ext/freebasic/examples/index.bas —— **列表与下标**那一批（第五个例子家族）
'
' 期望输出（家族里所有语言、所有后端逐行相同）：10 / 30 / 45。
'
' 这一份补上的是 list-new 那格账上 FB 欠的那一条：**数组字面量绑在声明上**
' （`Dim xs(2) As Integer = {10, 20, 30}`），不像别人那样是一格独立的表达式。
' 还有一处 FB 独有的难处：`xs(0)` 与函数调用**同形** —— 靠声明分（映射登记数组名，
' 见 ext/freebasic/tograph.js 的 ARRAYS）。
'
' 下标起点：`Dim xs(2)` 是 0…2（0 起），与图上的 index-get 一致，不用像 lua 那样减一格。

Dim xs(2) As Integer = {10, 20, 30}
Print xs(0)
Print xs(2)
xs(1) = 5
Dim s As Integer = 0
For i As Integer = 0 To 2
  s = s + xs(i)
Next
Print s
