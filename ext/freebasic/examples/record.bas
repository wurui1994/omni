' ext/freebasic/examples/record.bas —— 与 go / lua / V / nim / cpp / CL / Scheme 那七份 record **同一件事**
'
' 期望输出逐行相同：1 / 5 / 6。
'
' FB 在这一格上的形状与谁都不一样：**字段表在类型上**（`Type … End Type`），
' 而且它**没有记录字面量** —— `Dim p As Point` 先造出来（数值字段零起），再一格一格写进去。
'
' 落到图上仍然只有现成的三格（record-new / field-get / field-set）：
' 字段顺序从 `Type` 那一句登记（见 ext/freebasic/tograph.js 的 TYPES）。
' 所以 `nodes.js` 那格账上原来写的"要类型声明那一族"**记重了** ——
' 要的只是一张字段表，不是图里的类型层。

Type Point
  x As Integer
  y As Integer
End Type

Dim p As Point
p.x = 1
p.y = 2
Print p.x
p.y = 5
Print p.y
Print p.x + p.y
