## ext/nim/examples/member.nim —— **`x in xs` 落一格内建 `contains`**（与 V 同一族）
##
## 期望输出：true / false / true / false。
##
## nim 这一份与 V 那一份差两处，都归映射，不归图：
##   * `in` / `notin` 在 nim 里是**普通的中缀算符**（`notin` 是一个词，不是 `!in` 两个符号）；
##   * 两格实参的**次序与内建相反** —— 源码里写的是 `元素 in 容器`，而内建收的是
##     `contains(容器, 元素)`。所以这一格不能顺着 `binOf` 走（那条路照原样把 a、b 递下去），
##     要在 `bin` 那儿截住、把两格调个头。
##
## nim 的 `x in s`（s 是串）要 char 那一格，而 char 还没接 —— 所以内建只认列表，
## 串找子串那一支**故意没写**（没有判据的代码不留）。

let xs = @[10, 20, 30]
echo 20 in xs
echo 7 in xs
echo 7 notin xs
echo 20 notin xs
