# jancy 的 位置 × 要素 矩阵（机械枚举，ADR-0029 的 Phase 0）

这一份是 `node tests/lib/jnc-matrix.js` **跑出来**的，不是手写的。每一格是"把那种要素
塞进那个位置、合成一小段源码、跑一遍 `sx`"的结果：

- `✓` 降得下来（一条诊断都没有）
- `·` 语法就不认 —— 那是**规格**（这门语言里写不出来），不是洞
- `N…` 前端自己说的边界（"还不收"）
- `E…` 普通错 —— **这一栏是下一刀的料**：话对不对、认不认错人，都在这儿看

位置 9 × 要素 41 = 369 格：✓ 188、N 160、E 9、· 12、炸 0

| 要素 | module | namespace | class-body | struct-body | union-body | opaque-class-body | fn-body | property-body | extension-body |
|---|---|---|---|---|---|---|---|---|---|
| field-int | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N7 | N24 |
| field-string | ✓ | ✓ | ✓ | ✓ | N15 | ✓ | ✓ | N7 | N24 |
| field-array | ✓ | ✓ | ✓ | ✓ | N15 | ✓ | ✓ | N7 | N24 |
| field-static | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N21 | N24 |
| field-const | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N21 | N24 |
| field-bitfield | N1 | N1 | N1 | ✓ | N1 | N1 | N1 | N7 | N24 |
| field-bigendian | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N21 | N24 |
| field-class-value | ✓ | ✓ | ✓ | E9 | N15 | ✓ | ✓ | N7 | N24 |
| field-class-ptr | ✓ | ✓ | ✓ | ✓ | N15 | ✓ | ✓ | N7 | N24 |
| struct | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| union-named | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| union-anon | · | · | · | ✓ | N16 | · | · | N22 | N24 |
| struct-anon | · | · | · | · | ✓ | · | · | N22 | N24 |
| class | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| enum | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| enum-anon | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| enum-bitflag | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| typedef | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| typedef-fn | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| typedef-fnptr | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | ✓ | N22 | N24 |
| alias-method | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N23 | N24 |
| method-body | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | N17 | N22 | ✓ |
| method-proto | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N18 | N7 | N24 |
| method-static | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | N17 | N22 | ✓ |
| method-errorcode | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N18 | N21 | N24 |
| construct | E3 | E3 | ✓ | ✓ | N16 | ✓ | N17 | N22 | ✓ |
| construct-args | E3 | E3 | ✓ | ✓ | N16 | ✓ | N17 | N22 | ✓ |
| static-construct | E3 | E3 | ✓ | N10 | N16 | ✓ | N17 | N22 | ✓ |
| destruct | N4 | N4 | N4 | N10 | N16 | N4 | N17 | N22 | N4 |
| operator-add | N5 | N5 | N5 | N5 | N16 | N5 | N17 | N22 | N5 |
| operator-assign | E6 | E6 | ✓ | ✓ | N16 | ✓ | N17 | N22 | ✓ |
| property-simple | ✓ | ✓ | ✓ | N11 | ✓ | ✓ | N19 | N7 | N24 |
| property-full | N7 | N7 | N7 | N7 | N16 | N7 | N17 | N22 | N7 |
| property-bindable | ✓ | ✓ | ✓ | N11 | ✓ | ✓ | N19 | N7 | N24 |
| event | ✓ | ✓ | ✓ | N12 | ✓ | ✓ | N18 | N7 | N24 |
| reactor | ✓ | ✓ | ✓ | ✓ | N16 | ✓ | N17 | N22 | ✓ |
| local-var | ✓ | ✓ | ✓ | N13 | · | ✓ | ✓ | N7 | N24 |
| import | ✓ | ✓ | N8 | N14 | N16 | N8 | N17 | N22 | N24 |
| pragma | ✓ | ✓ | N8 | N14 | N16 | N8 | N17 | N22 | N24 |
| using-namespace | ✓ | ✓ | N8 | N14 | N16 | N8 | N20 | N22 | N24 |
| extension | ✓ | ✓ | N8 | N14 | N16 | N8 | N17 | N22 | N24 |

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
8. 类里除字段以外的成员
9. 结构体 '…' 里放不下类 '…' 的一格值（jancy 那边这一句就是错：`class … cannot be a struct member`，jnc_ct_StructType.cpp:303-307 —— 内嵌的对象只有类里才有）
10. 结构体里的 '…'
11. 结构体的成员属性 '…' 上的 '…'（那一格要往结构体里加一格字段 / 一格事件，而属性这一遍排在字段表定下来之后）
12. 结构体里的事件 '…'（那一格要在造出来的时候把单子建起来，而这一层的结构体没有构造那条路）
13. 结构体字段的默认值
14. 结构体里除字段以外的成员
15. union 里的成员 '…'（只收整数 / 实数 / 布尔 / 枚举 / 另一个结构体 —— 指针、string 与数组那几种旁边还挂着表，重叠之后说不清归谁）
16. union 体里除字段与匿名 struct 以外的成员
17. 语句 '…'
18. 函数体里的这一条 '…'：要么是一格**函数原型**（jancy 的函数体里写不了原型 —— 那要一层"块作用域也是命名空间"），要么是"局部量后面挂构造实参"（`T v(a, b)`，那一种只有类与结构体的变量收得下）
19. 函数体里的属性声明（属性指针要一格"属性指针"类型）
20. 写在函数体里的 `using namespace X;` —— 它的作用域是这个块，要一张跟着作用域一起进出的表（写在命名空间那一层的那一格收了，见 ADR-0016 第二百一十七刀）
21. 完整声明式的属性 '…' 体里的这一条 —— 字段要写 `autoget`、事件要写 `bindable event`（prop_full.rst:34）
22. 完整声明式的属性 '…' 体里的这一条 —— 只收带体的 get / set 与`autoget` 的字段 / `bindable` 的事件（prop_full.rst:34）
23. 完整声明式的属性 '…' 里那条 alias 上既没有 '…' 也没有 '…'（属性体里的 alias 只有这两种意思，jnc_ct_Parser.cpp:1354-1361）
24. extension 体里除带体的方法以外的成员

## 怎么读它

- **E 那一栏**是优先级最高的：普通错意味着"这一层认为你写错了"，而语料里写着的东西
  多半没错 —— 第 248/251/253 刀那三条"认错人"就长这样。
- **同一行里 ✓ 与 N 混着**说明这件事与位置有关，那正是位置代数该管的；
  同一列里大片 N 说明那个位置本身还欠一套机器。
- 这张表**不替代**语料榜（`tests/lib/jnc-sweep.js`）：榜量"语料里真写了什么"，
  这张表量"规格里可能写什么"。两张一起才知道"下一刀值不值"。

