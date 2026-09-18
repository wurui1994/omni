## ext/nim/examples/caserange.nim —— **`of 1 .. 5:` 是一段区间**（nim 独一份）
##
## 期望输出：bad / ok / great / ?
##
## nim 的区间是**中缀算符**（`..` 含上界、`..<` 不含），所以 `case` 的分支左边也能是它。
## 从前这一支跟着走 `==`，那格 `..` 掉进 `binOf` 里当场报"这个算子还没接：.." ——
## 三份文件卡在这儿。落成**两格比较用 and 串起来**（`n >= lo and n <= hi`），
## 图上一格新节点也没加；`for` 那一格早就是这么认区间的，这儿只是把同一条认法搬过来。
##
## 印的是**串**：那一格从前挡着 wasm 那条腿（"返回值上还接不住字符串"），现在通了 ——
## 每个函数返回的是数还是串由 emitWat 那趟定点算出来（`kinds` 那张表），调用点问得着。

proc grade(n: int): string =
  case n
  of 0 .. 59:
    return "bad"
  of 60 .. 89:
    return "ok"
  of 90 .. 100:
    return "great"
  else:
    return "?"

echo grade(42)
echo grade(75)
echo grade(99)
echo grade(-1)
