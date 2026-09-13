# jancy 的 位置 × 要素 矩阵（机械枚举，ADR-0029 的 Phase 0）

这一份是 `node tests/lib/jnc-matrix.js` **跑出来**的，不是手写的。每一格是"把那种要素
塞进那个位置、合成一小段源码、跑一遍 `sx`"的结果：

- `✓` 降得下来（一条诊断都没有）
- `·` 语法就不认 —— 那是**规格**（这门语言里写不出来），不是洞
- `N…` 前端自己说的边界（"还不收"）
- `E…` 普通错 —— **这一栏是下一刀的料**：话对不对、认不认错人，都在这儿看

位置 9 × 要素 60 = 540 格：✓ 253、N 232、E 32、· 23、炸 0

| 要素 | module | namespace | class-body | struct-body | union-body | opaque-class-body | fn-body | property-body | extension-body |
|---|---|---|---|---|---|---|---|---|---|
| field-int | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N7 | N33 |
| field-string | ✓ | ✓ | ✓ | ✓ | N23 | ✓ | ✓ | N7 | N33 |
| field-array | ✓ | ✓ | ✓ | ✓ | N23 | ✓ | ✓ | N7 | N33 |
| field-static | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N29 | N33 |
| field-const | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N29 | N33 |
| field-bitfield | N1 | N1 | N1 | ✓ | N1 | N1 | N1 | N7 | N33 |
| field-bigendian | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N29 | N33 |
| field-class-value | ✓ | ✓ | ✓ | E16 | N23 | ✓ | ✓ | N7 | N33 |
| field-class-ptr | ✓ | ✓ | ✓ | ✓ | N23 | ✓ | ✓ | N7 | N33 |
| struct | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| union-named | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| union-anon | · | · | · | ✓ | N24 | · | · | N30 | N33 |
| struct-anon | · | · | · | · | ✓ | · | · | N30 | N33 |
| class | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| enum | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| enum-anon | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| enum-bitflag | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| typedef | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| typedef-fn | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| typedef-fnptr | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| alias-method | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N31 | N33 |
| method-body | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | N25 | N30 | ✓ |
| method-proto | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N26 | N7 | N33 |
| method-static | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | N25 | N30 | ✓ |
| method-errorcode | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N26 | N29 | N33 |
| construct | E3 | E3 | ✓ | ✓ | N24 | ✓ | N25 | N30 | ✓ |
| construct-args | E3 | E3 | ✓ | ✓ | N24 | ✓ | N25 | N30 | ✓ |
| static-construct | E3 | E3 | ✓ | N17 | N24 | ✓ | N25 | N30 | ✓ |
| destruct | N4 | N4 | N4 | N17 | N24 | N4 | N25 | N30 | N4 |
| operator-add | N5 | N5 | N5 | N5 | N24 | N5 | N25 | N30 | N5 |
| operator-assign | E6 | E6 | ✓ | ✓ | N24 | ✓ | N25 | N30 | ✓ |
| property-simple | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N27 | N7 | N33 |
| property-full | N7 | N7 | N7 | N7 | N24 | N7 | N25 | N30 | N7 |
| property-bindable | ✓ | ✓ | ✓ | N18 | ✓ | ✓ | N27 | N7 | N33 |
| event | ✓ | ✓ | ✓ | N19 | ✓ | ✓ | N26 | N7 | N33 |
| reactor | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | N25 | N30 | ✓ |
| local-var | ✓ | ✓ | ✓ | N20 | · | ✓ | ✓ | N7 | N33 |
| import | ✓ | ✓ | N13 | N21 | N24 | N13 | N25 | N30 | N33 |
| pragma | ✓ | ✓ | N13 | N21 | N24 | N13 | N25 | N30 | N33 |
| using-namespace | ✓ | ✓ | N13 | N21 | N24 | N13 | N28 | N30 | N33 |
| extension | ✓ | ✓ | N13 | N21 | N24 | N13 | N25 | N30 | N33 |
| namespace | ✓ | ✓ | N13 | N21 | N24 | N13 | N25 | N30 | N33 |
| class-opaque | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| method-virtual | E8 | E8 | ✓ | N22 | N24 | ✓ | N25 | N30 | ✓ |
| method-abstract | E8 | E8 | ✓ | E8 | E8 | ✓ | N26 | N29 | N33 |
| field-fnptr | ✓ | ✓ | ✓ | ✓ | N23 | ✓ | ✓ | N29 | N33 |
| field-multicast | ✓ | ✓ | ✓ | N19 | ✓ | ✓ | N26 | N7 | N33 |
| method-override | E8 | E8 | E14 | N22 | N24 | E14 | N25 | N30 | E14 |
| enum-typed | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| property-indexed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N27 | N29 | N33 |
| dylib | ✓ | ✓ | N13 | N21 | N24 | N13 | N25 | N30 | N33 |
| field-thin-ptr | ✓ | ✓ | ✓ | ✓ | N23 | ✓ | ✓ | N29 | N33 |
| field-array-dyn | E9 | E9 | E15 | E15 | N23 | E15 | E9 | N7 | N33 |
| template-ctor-expr | N10 | N10 | N10 | N20 | · | N10 | ✓ | N7 | N33 |
| friend | · | · | · | · | · | · | · | · | · |
| field-static-init | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | N29 | N33 |
| event-args | ✓ | ✓ | ✓ | N19 | ✓ | ✓ | N26 | N32 | N33 |
| alias-field-path | N11 | N11 | ✓ | ✓ | N11 | ✓ | N11 | N31 | N33 |
| class-multi-base | ✓ | ✓ | ✓ | ✓ | N24 | ✓ | ✓ | N30 | N33 |
| disposable-class | E12 | E12 | E12 | E12 | N24 | E12 | N25 | N30 | E12 |

## 名字落在哪（`escapes`）

带体的那几种要素还有第二问：**声明出来的名字，在写它的那层作用域外面认不认得**。
量法是把"用一下那个名字"塞进后面一个函数体里再编一遍 —— 编得过就是漏出去了。
这一列就是 ADR-0016 第 219/250/260 刀那笔代价（T-005）的清单。

漏到外面那层：20 格；留在原处：41 格。

- `module|struct` —— 漏到外面那层
- `module|union-named` —— 漏到外面那层
- `module|class` —— 漏到外面那层
- `module|enum` —— 漏到外面那层
- `module|enum-anon` —— 漏到外面那层
- `module|enum-bitflag` —— 漏到外面那层
- `module|typedef` —— 漏到外面那层
- `module|typedef-fn` —— 漏到外面那层
- `module|typedef-fnptr` —— 漏到外面那层
- `module|alias-method` —— 漏到外面那层
- `fn-body|struct` —— 漏到外面那层
- `fn-body|union-named` —— 漏到外面那层
- `fn-body|class` —— 漏到外面那层
- `fn-body|enum` —— 漏到外面那层
- `fn-body|enum-anon` —— 漏到外面那层
- `fn-body|enum-bitflag` —— 漏到外面那层
- `fn-body|typedef` —— 漏到外面那层
- `fn-body|typedef-fn` —— 漏到外面那层
- `fn-body|typedef-fnptr` —— 漏到外面那层
- `fn-body|alias-method` —— 漏到外面那层

## 理由表

1. 这个位置上的位域（`: 位数` 只在结构体的字段上）
2. 语法不认
3. '…' 只能是类或结构体的成员（写在体里，或写成 '…'）
4. '…' —— jancy 那边它是 GC 在**不确定的时刻**调的（disposable.rst:17），要确定时机得先有 dispose/nestedscope 那一套
5. 算符重载 '…'
6. '…' 只能是类或结构体的成员（写在体里）
7. 这种类型说明符（**没位置**）
8. '…' 只能写在类的方法上（type_class.rst:178）
9. '…' 的长度得从花括号初值数出来
10. '…' 是一格类型，`类型(实参…)` 是 jancy 的**构造式转换**（要按目标类型挑一条转换，与 `(类型)值` 那种写法同一件事）—— 这一层只收 `(类型)值` 那一种
11. alias '…' 的目标 '…'（收的是一格类型名、一格函数、这个类里的一格方法、或者这个类 / 结构体里逐段解得开的一串字段）
12. `disposable` 只能写在**局部量**上（jancy 那边这个词只在那一档收，jnc_ct_Parser.cpp:2050-2068 —— 类自己的"可弃"是靠有一格 `dispose` 方法，disposable.rst 那句 "usually aliased to close/disconnect/…"）
13. 类里除字段以外的成员
14. 覆盖不了 '…'：基类里没有方法 '…'（jancy 那句 "cannot override '…': method not found"）（**没位置**）
15. 字段 '…' 的长度得写出来
16. 结构体 '…' 里放不下类 '…' 的一格值（jancy 那边这一句就是错：`class … cannot be a struct member`，jnc_ct_StructType.cpp:303-307 —— 内嵌的对象只有类里才有）
17. 结构体里的 '…'
18. 结构体的成员属性 '…' 上的 '…'（那一格要往结构体里加一格字段 / 一格事件，而属性这一遍排在字段表定下来之后）
19. 结构体里的事件 '…'（那一格要在造出来的时候把单子建起来，而这一层的结构体没有构造那条路）
20. 结构体字段的默认值
21. 结构体里除字段以外的成员
22. 结构体的方法 '…' 上写 '…'（虚派发要对象头那一格类型标签，结构体没有）
23. union 里的成员 '…'（只收整数 / 实数 / 布尔 / 枚举 / 另一个结构体 —— 指针、string 与数组那几种旁边还挂着表，重叠之后说不清归谁）
24. union 体里除字段与匿名 struct 以外的成员
25. 语句 '…'
26. 函数体里的这一条 '…'：要么是一格**函数原型**（jancy 的函数体里写不了原型 —— 那要一层"块作用域也是命名空间"），要么是"局部量后面挂构造实参"（`T v(a, b)`，那一种只有类与结构体的变量收得下）
27. 函数体里的属性声明（属性指针要一格"属性指针"类型）
28. 写在函数体里的 `using namespace X;` —— 它的作用域是这个块，要一张跟着作用域一起进出的表（写在命名空间那一层的那一格收了，见 ADR-0016 第二百一十七刀）
29. 完整声明式的属性 '…' 体里的这一条 —— 字段要写 `autoget`、事件要写 `bindable event`（prop_full.rst:34）
30. 完整声明式的属性 '…' 体里的这一条 —— 只收带体的 get / set 与`autoget` 的字段 / `bindable` 的事件（prop_full.rst:34）
31. 完整声明式的属性 '…' 里那条 alias 上既没有 '…' 也没有 '…'（属性体里的 alias 只有这两种意思，jnc_ct_Parser.cpp:1354-1361）
32. 完整声明式的属性 '…' 里的事件 '…' 带着实参（属性的那一格是 `multicast ()`）
33. extension 体里除带体的方法以外的成员

## 怎么读它

- **E 那一栏**是优先级最高的：普通错意味着"这一层认为你写错了"，而语料里写着的东西
  多半没错 —— 第 248/251/253 刀那三条"认错人"就长这样。
- **同一行里 ✓ 与 N 混着**说明这件事与位置有关，那正是位置代数该管的；
  同一列里大片 N 说明那个位置本身还欠一套机器。
- 这张表**不替代**语料榜（`tests/lib/jnc-sweep.js`）：榜量"语料里真写了什么"，
  这张表量"规格里可能写什么"。两张一起才知道"下一刀值不值"。

