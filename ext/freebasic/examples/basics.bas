' ext/freebasic/examples/basics.bas —— 与前六门那几份**同一件事**
'
' 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
' 这一门在语法上离前六门最远（行导向、块靠 `end function` / `next` 收尾），
' 可它落到的还是那 13 格 —— "语法难 ≠ 节点多"的可跑证据。
'
' 它独有的一格坑在图这一层解决：**`=` 既是赋值也是比较**（同一个记号）。
' 语法层刻意不分（分了就 113 份文件两个解），所以"哪一种"按位置判：
' 语句位置上顶着 `=` 的表达式是赋值 —— 那正是"留给语义层"该落的地方。
'
' 要素对照：
'   function + 形参表   -> bind + func
'   dim … as … = …      -> bind（类型丢掉：它是端口的 sort）
'   acc = acc + i        -> set（语句位置上的 `=`）
'   for i = a to b … next -> region + bind + loop + set
'   if / else / end if   -> branch
'   return               -> ret
'   print                -> prim print

function sumto(n as integer) as integer
  dim acc as integer = 0
  for i as integer = 1 to n
    acc = acc + i
  next
  return acc
end function

function fact(n as integer) as integer
  if n = 0 then
    return 1
  end if
  return n * fact(n - 1)
end function

function max2(a as integer, b as integer) as integer
  if a > b then
    return a
  else
    return b
  end if
end function

print sumto(5)
print fact(5)
print max2(3, 7)

dim tag as string = "ok"
print tag
