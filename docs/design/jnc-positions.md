# jancy 的 位置 × 要素 矩阵（机械枚举，ADR-0029 的 Phase 0）

这一份是 `node tests/lib/jnc-matrix.js` **跑出来**的，不是手写的。每一格是"把那种要素
塞进那个位置、合成一小段源码、跑一遍 `sx`"的结果：

- `✓` 降得下来（一条诊断都没有）
- `·` 语法就不认 —— 那是**规格**（这门语言里写不出来），不是洞
- `N…` 前端自己说的边界（"还不收"）
- `E…` 普通错 —— **这一栏是下一刀的料**：话对不对、认不认错人，都在这儿看

位置 9 × 要素 66 = 594 格：✓ 268、N 272、E 32、· 22、炸 0

| 要素 | module | namespace | class-body | struct-body | union-body | opaque-class-body | fn-body | property-body | extension-body |
|---|---|---|---|---|---|---|---|---|---|
| field-int | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N7 | N37 |
| field-string | ✓ | ✓ | ✓ | ✓ | N26 | ✓ | ✓ | N7 | N37 |
| field-array | ✓ | ✓ | ✓ | ✓ | N26 | ✓ | ✓ | N7 | N37 |
| field-static | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N32 | N37 |
| field-const | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N32 | N37 |
| field-bitfield | N1 | N1 | N1 | ✓ | N1 | N1 | N1 | N7 | N37 |
| field-bigendian | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N32 | N37 |
| field-class-value | ✓ | ✓ | ✓ | E19 | N26 | ✓ | ✓ | N7 | N37 |
| field-class-ptr | ✓ | ✓ | ✓ | ✓ | N26 | ✓ | ✓ | N7 | N37 |
| struct | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| union-named | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| union-anon | · | · | · | ✓ | N27 | · | · | N33 | N37 |
| struct-anon | · | · | · | · | ✓ | · | · | N33 | N37 |
| class | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| enum | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| enum-anon | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| enum-bitflag | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| typedef | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| typedef-fn | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| typedef-fnptr | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| alias-method | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N34 | N37 |
| method-body | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| method-proto | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N29 | N7 | N37 |
| method-static | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| method-errorcode | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N29 | N32 | N37 |
| construct | E3 | E3 | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| construct-args | E3 | E3 | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| static-construct | E3 | E3 | ✓ | N20 | N27 | ✓ | N28 | N33 | ✓ |
| destruct | N4 | N4 | N4 | N20 | N27 | N4 | N28 | N33 | N4 |
| operator-add | N5 | N5 | N5 | N5 | N27 | N5 | N28 | N33 | N5 |
| operator-assign | E6 | E6 | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| property-simple | ✓ | ✓ | ✓ | N21 | N27 | ✓ | N30 | N7 | N37 |
| property-full | N7 | N7 | N7 | N7 | N27 | N7 | N28 | N33 | N7 |
| property-bindable | ✓ | ✓ | ✓ | N21 | N27 | ✓ | N30 | N7 | N37 |
| event | ✓ | ✓ | ✓ | N22 | ✓ | ✓ | N29 | N7 | N37 |
| reactor | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| local-var | ✓ | ✓ | ✓ | N23 | · | ✓ | ✓ | N7 | N37 |
| import | ✓ | ✓ | N16 | N24 | N27 | N16 | N28 | N33 | N37 |
| pragma | ✓ | ✓ | N16 | N24 | N27 | N16 | N28 | N33 | N37 |
| using-namespace | ✓ | ✓ | N16 | N24 | N27 | N16 | N31 | N33 | N37 |
| extension | ✓ | ✓ | N16 | N24 | N27 | N16 | N28 | N33 | N37 |
| namespace | ✓ | ✓ | N16 | N24 | N27 | N16 | N28 | N33 | N37 |
| class-opaque | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| method-virtual | E8 | E8 | ✓ | N25 | N27 | ✓ | N28 | N33 | ✓ |
| method-abstract | E8 | E8 | ✓ | E8 | E8 | ✓ | N29 | N32 | N37 |
| field-fnptr | ✓ | ✓ | ✓ | ✓ | N26 | ✓ | ✓ | N32 | N37 |
| field-multicast | ✓ | ✓ | ✓ | N22 | ✓ | ✓ | N29 | N7 | N37 |
| method-override | E8 | E8 | E17 | N25 | N27 | E17 | N28 | N33 | E17 |
| enum-typed | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| property-indexed | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | N30 | N32 | N37 |
| dylib | ✓ | ✓ | N16 | N24 | N27 | N16 | N28 | N33 | N37 |
| field-thin-ptr | ✓ | ✓ | ✓ | ✓ | N26 | ✓ | ✓ | N32 | N37 |
| field-array-dyn | E9 | E9 | E18 | E18 | N26 | E18 | E9 | N7 | N37 |
| template-ctor-expr | N10 | N10 | N10 | N23 | · | N10 | ✓ | N7 | N37 |
| friend | · | · | · | · | · | · | · | · | · |
| field-static-init | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N32 | N37 |
| event-args | ✓ | ✓ | ✓ | N22 | ✓ | ✓ | N29 | N35 | N37 |
| alias-field-path | N11 | N11 | ✓ | ✓ | N11 | ✓ | N11 | N34 | N37 |
| class-multi-base | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | ✓ | N33 | N37 |
| disposable-class | E12 | E12 | E12 | E12 | N27 | E12 | N28 | N33 | E12 |
| method-const | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| property-static | N13 | N13 | N13 | N13 | N27 | N13 | N30 | N36 | N37 |
| field-weak-ptr | N14 | N14 | N14 | N14 | N14 | N14 | N14 | N32 | N37 |
| fn-async | N15 | N15 | N15 | N15 | N27 | N15 | N28 | N33 | N15 |
| fn-unsafe | ✓ | ✓ | ✓ | ✓ | N27 | ✓ | N28 | N33 | ✓ |
| attribute-decl | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N33 | N37 |

## 修饰词留痕了吗（`trace`）

带修饰词的那几种要素还有第三问：**把那几个词去掉再降一遍，两份 sx 一样吗**。一样就说明
这一层把它们丢了。丢了不一定是错（`const` / `unsafe` 只在编译期管事），所以期望写在规格里 ——
这一问是"`ok` 只说明没诊断、不说明降对了"那条界的补救（ADR-0029 第 10.21 节）。

没留下痕迹的：28 格。

- `module|field-static` —— 那几个词降出来没留痕
- `module|field-const` —— 那几个词降出来没留痕
- `module|field-bigendian` —— 那几个词降出来没留痕
- `module|method-const` —— 那几个词降出来没留痕
- `module|fn-unsafe` —— 那几个词降出来没留痕
- `namespace|field-static` —— 那几个词降出来没留痕
- `namespace|field-const` —— 那几个词降出来没留痕
- `namespace|field-bigendian` —— 那几个词降出来没留痕
- `namespace|method-const` —— 那几个词降出来没留痕
- `namespace|fn-unsafe` —— 那几个词降出来没留痕
- `class-body|field-const` —— 那几个词降出来没留痕
- `class-body|field-bigendian` —— 那几个词降出来没留痕
- `class-body|method-const` —— 那几个词降出来没留痕
- `class-body|fn-unsafe` —— 那几个词降出来没留痕
- `struct-body|field-const` —— 那几个词降出来没留痕
- `struct-body|field-bigendian` —— 那几个词降出来没留痕
- `struct-body|method-const` —— 那几个词降出来没留痕
- `struct-body|fn-unsafe` —— 那几个词降出来没留痕
- `union-body|field-const` —— 那几个词降出来没留痕
- `union-body|field-bigendian` —— 那几个词降出来没留痕
- `opaque-class-body|field-const` —— 那几个词降出来没留痕
- `opaque-class-body|field-bigendian` —— 那几个词降出来没留痕
- `opaque-class-body|method-const` —— 那几个词降出来没留痕
- `opaque-class-body|fn-unsafe` —— 那几个词降出来没留痕
- `fn-body|field-const` —— 那几个词降出来没留痕
- `fn-body|field-bigendian` —— 那几个词降出来没留痕
- `extension-body|method-const` —— 那几个词降出来没留痕
- `extension-body|fn-unsafe` —— 那几个词降出来没留痕

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
13. `static` 写在属性上
14. `weak` 指针 —— jancy 那儿它是另一种指针（ClassPtrKind_Weak / FunctionPtrKind_Weak / PropertyPtrKind_Weak，jnc_ct_DeclTypeCalc.cpp:667/676/688），GC 收了对象之后它自己变 null；这一层没有 GC，收下不看会让 `if (p)` 永远为真
15. `async` 函数 —— jancy 那儿它换掉返回类型（写出来的那个挪去 m_asyncReturnType，函数真正回一格 `std.Promise*`，jnc_ct_TypeMgr.cpp:664-672），体还要拆成一台能在 await 处停下再接着跑的状态机
16. 类里除字段以外的成员
17. 覆盖不了 '…'：基类里没有方法 '…'（jancy 那句 "cannot override '…': method not found"）（**没位置**）
18. 字段 '…' 的长度得写出来
19. 结构体 '…' 里放不下类 '…' 的一格值（jancy 那边这一句就是错：`class … cannot be a struct member`，jnc_ct_StructType.cpp:303-307 —— 内嵌的对象只有类里才有）
20. 结构体里的 '…'
21. 结构体的成员属性 '…' 上的 '…'（那一格要往结构体里加一格字段 / 一格事件，而属性这一遍排在字段表定下来之后）
22. 结构体里的事件 '…'（那一格要在造出来的时候把单子建起来，而这一层的结构体没有构造那条路）
23. 结构体字段的默认值
24. 结构体里除字段以外的成员
25. 结构体的方法 '…' 上写 '…'（虚派发要对象头那一格类型标签，结构体没有）
26. union 里的成员 '…'（只收整数 / 实数 / 布尔 / 枚举 / 另一个结构体 —— 指针、string 与数组那几种旁边还挂着表，重叠之后说不清归谁）
27. union 体里除字段与匿名 struct 以外的成员
28. 语句 '…'
29. 函数体里的这一条 '…'：要么是一格**函数原型**（jancy 的函数体里写不了原型 —— 那要一层"块作用域也是命名空间"），要么是"局部量后面挂构造实参"（`T v(a, b)`，那一种只有类与结构体的变量收得下）
30. 函数体里的属性声明（属性指针要一格"属性指针"类型）
31. 写在函数体里的 `using namespace X;` —— 它的作用域是这个块，要一张跟着作用域一起进出的表（写在命名空间那一层的那一格收了，见 ADR-0016 第二百一十七刀）
32. 完整声明式的属性 '…' 体里的这一条 —— 字段要写 `autoget`、事件要写 `bindable event`（prop_full.rst:34）
33. 完整声明式的属性 '…' 体里的这一条 —— 只收带体的 get / set 与`autoget` 的字段 / `bindable` 的事件（prop_full.rst:34）
34. 完整声明式的属性 '…' 里那条 alias 上既没有 '…' 也没有 '…'（属性体里的 alias 只有这两种意思，jnc_ct_Parser.cpp:1354-1361）
35. 完整声明式的属性 '…' 里的事件 '…' 带着实参（属性的那一格是 `multicast ()`）
36. `static` 写在属性上（**没位置**）
37. extension 体里除带体的方法以外的成员

## 怎么读它

- **E 那一栏**是优先级最高的：普通错意味着"这一层认为你写错了"，而语料里写着的东西
  多半没错 —— 第 248/251/253 刀那三条"认错人"就长这样。
- **同一行里 ✓ 与 N 混着**说明这件事与位置有关，那正是位置代数该管的；
  同一列里大片 N 说明那个位置本身还欠一套机器。
- 这张表**不替代**语料榜（`tests/lib/jnc-sweep.js`）：榜量"语料里真写了什么"，
  这张表量"规格里可能写什么"。两张一起才知道"下一刀值不值"。

