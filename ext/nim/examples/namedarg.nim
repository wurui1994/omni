## ext/nim/examples/namedarg.nim —— **对象构造 vs 命名实参**（第十五个例子家族，nim 独有）
##
## 期望输出：1 / 7。
##
## 这一份钉的是一笔**记错了的账**。文档与映射原来都写着："nim 的 `T(x: 1)` 与 `f(x = 1)`
## 在树上同形，分开它们要驱动器能回问'这个名字登记成类型了吗'"。量一遍就知道：
## **在调用实参这个位置上两者不同形** —— 语法里 `IDENT "=" expr` 出 `named`、
## `expr ":" expr` 出 `kv`，两条产生式两个标签。
##
## 剩下真要判的只有"这名字是类型还是函数"，而那句话**扫一遍 `type` 段就有答案**
## （与 map 那一族靠"造它的那一步自带标记"是同一条路子）。所以：
##   * `Point(x: 1, y: 2)` -> record-new（判据：Point 在 type 段里登记过）
##   * `addTo(a = 3, b = 4)` -> call（命名实参**按被调者的形参表排回位置** ——
##     图上只有位置实参；名字对不上、形参表不知道，都当场报，不猜）

type Point = object
  x: int
  y: int

proc addTo(a: int, b: int): int = a + b

let p = Point(x: 1, y: 2)
echo p.x
echo addTo(a = 3, b = 4)
