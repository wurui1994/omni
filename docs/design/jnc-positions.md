# jancy 的 位置 × 要素 矩阵（机械枚举，ADR-0029 的 Phase 0）

这一份是 `node tests/lib/jnc-matrix.js` **跑出来**的，不是手写的。每一格是"把那种要素
塞进那个位置、合成一小段源码、跑一遍 `sx`"的结果：

- `✓` 降得下来（一条诊断都没有）
- `·` 语法就不认 —— 那是**规格**（这门语言里写不出来），不是洞
- `N…` 前端自己说的边界（"还不收"）
- `E…` 普通错 —— **这一栏是下一刀的料**：话对不对、认不认错人，都在这儿看

位置 9 × 要素 40 = 360 格：✓ 180、N 163、E 11、· 6、炸 0

| 要素 | module | namespace | class-body | struct-body | union-body | opaque-class-body | fn-body | property-body | extension-body |
|---|---|---|---|---|---|---|---|---|---|
| field-int | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N7 | N28 |
| field-string | ✓ | ✓ | ✓ | ✓ | N17 | ✓ | ✓ | N7 | N28 |
| field-array | ✓ | ✓ | ✓ | ✓ | N17 | ✓ | ✓ | N7 | N28 |
| field-static | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N25 | N28 |
| field-const | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N25 | N28 |
| field-bitfield | N1 | N1 | N1 | ✓ | N1 | N1 | N1 | N7 | N28 |
| field-bigendian | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N25 | N28 |
| field-class-value | ✓ | ✓ | ✓ | E11 | N17 | ✓ | ✓ | N7 | N28 |
| field-class-ptr | ✓ | ✓ | ✓ | ✓ | N17 | ✓ | ✓ | N7 | N28 |
| struct | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| union-named | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| union-anon | · | · | · | ✓ | N18 | · | · | N26 | N28 |
| class | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| enum | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| enum-anon | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| enum-bitflag | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| typedef | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| typedef-fn | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| typedef-fnptr | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N26 | N28 |
| alias-method | ✓ | ✓ | N9 | N9 | N9 | N9 | E19 | N27 | N28 |
| method-body | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | N20 | N26 | ✓ |
| method-proto | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N21 | N7 | N28 |
| method-static | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | N20 | N26 | ✓ |
| method-errorcode | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | E22 | N25 | N28 |
| construct | E3 | E3 | ✓ | ✓ | N18 | ✓ | N20 | N26 | ✓ |
| construct-args | E3 | E3 | ✓ | ✓ | N18 | ✓ | N20 | N26 | ✓ |
| static-construct | E3 | E3 | ✓ | N12 | N18 | ✓ | N20 | N26 | ✓ |
| destruct | N4 | N4 | N4 | N12 | N18 | N4 | N20 | N26 | N4 |
| operator-add | N5 | N5 | N5 | N5 | N18 | N5 | N20 | N26 | N5 |
| operator-assign | E6 | E6 | ✓ | ✓ | N18 | ✓ | N20 | N26 | ✓ |
| property-simple | ✓ | ✓ | ✓ | N13 | ✓ | ✓ | N23 | N7 | N28 |
| property-full | N7 | N7 | N7 | N7 | N18 | N7 | N20 | N26 | N7 |
| property-bindable | ✓ | ✓ | ✓ | N13 | ✓ | ✓ | N23 | N7 | N28 |
| event | ✓ | ✓ | ✓ | N14 | ✓ | ✓ | N21 | N7 | N28 |
| reactor | ✓ | ✓ | ✓ | ✓ | N18 | ✓ | N20 | N26 | ✓ |
| local-var | ✓ | ✓ | ✓ | N15 | · | ✓ | ✓ | N7 | N28 |
| import | N8 | N8 | N10 | N16 | N18 | N10 | N20 | N26 | N28 |
| pragma | ✓ | ✓ | N10 | N16 | N18 | N10 | N20 | N26 | N28 |
| using-namespace | ✓ | ✓ | N10 | N16 | N18 | N10 | N24 | N26 | N28 |
| extension | ✓ | ✓ | N10 | N16 | N18 | N10 | N20 | N26 | N28 |

## 理由表

1. 这个位置上的位域（`: 位数` 只在结构体的字段上）
2. 语法不认
3. '…' 只能是类或结构体的成员（写在体里，或写成 '…'）
4. '…' —— jancy 那边它是 GC 在**不确定的时刻**调的（disposable.rst:17），要确定时机得先有 dispose/nestedscope 那一套
5. 算符重载 '…'
6. '…' 只能是类或结构体的成员（写在体里）
7. 这种类型说明符（**没位置**）
8. import "imports/lib60.jnc"（在写这条 import 的那个文件旁边找不着它；jancy 那边还有 `-I` 给的目录表，这一趟一个都没给）
9. alias '…' 的目标 '…'（收的是一格类型名、一格函数、这个类里的一格方法、或者这个类 / 结构体里逐段解得开的一串字段）
10. 类里除字段以外的成员
11. 结构体 '…' 里放不下类 '…' 的一格值（jancy 那边这一句就是错：`class … cannot be a struct member`，jnc_ct_StructType.cpp:303-307 —— 内嵌的对象只有类里才有）
12. 结构体里的 '…'
13. 结构体的成员属性 '…' 上的 '…'（那一格要往结构体里加一格字段 / 一格事件，而属性这一遍排在字段表定下来之后）
14. 结构体里的事件 '…'（那一格要在造出来的时候把单子建起来，而这一层的结构体没有构造那条路）
15. 结构体字段的默认值
16. 结构体里除字段以外的成员
17. union 里的成员 '…'（只收整数 / 实数 / 布尔 / 枚举 / 另一个结构体 —— 指针、string 与数组那几种旁边还挂着表，重叠之后说不清归谁）
18. union 体里除字段与匿名 struct 以外的成员
19. 初值的类型是 int function*(int)，声明的是 void
20. 语句 '…'
21. 局部量上的形参表（`T v(a, b)` 那种构造实参只有类与结构体的变量收得下）
22. '…' 只能写在函数上（exceptions.rst:17）
23. 函数体里的属性声明（属性指针要一格"属性指针"类型）
24. 写在函数体里的 `using namespace X;` —— 它的作用域是这个块，要一张跟着作用域一起进出的表（写在命名空间那一层的那一格收了，见 ADR-0016 第二百一十七刀）
25. 完整声明式的属性 '…' 体里的这一条 —— 字段要写 `autoget`、事件要写 `bindable event`（prop_full.rst:34）
26. 完整声明式的属性 '…' 体里的这一条 —— 只收带体的 get / set 与`autoget` 的字段 / `bindable` 的事件（prop_full.rst:34）
27. 完整声明式的属性 '…' 里那条 alias 上既没有 '…' 也没有 '…'（属性体里的 alias 只有这两种意思，jnc_ct_Parser.cpp:1354-1361）
28. extension 体里除带体的方法以外的成员

## 怎么读它

- **E 那一栏**是优先级最高的：普通错意味着"这一层认为你写错了"，而语料里写着的东西
  多半没错 —— 第 248/251/253 刀那三条"认错人"就长这样。
- **同一行里 ✓ 与 N 混着**说明这件事与位置有关，那正是位置代数该管的；
  同一列里大片 N 说明那个位置本身还欠一套机器。
- 这张表**不替代**语料榜（`tests/lib/jnc-sweep.js`）：榜量"语料里真写了什么"，
  这张表量"规格里可能写什么"。两张一起才知道"下一刀值不值"。

