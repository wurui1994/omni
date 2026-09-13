# jancy 的 位置 × 要素 矩阵（机械枚举，ADR-0029 的 Phase 0）

这一份是 `node tests/lib/jnc-matrix.js` **跑出来**的，不是手写的。每一格是"把那种要素
塞进那个位置、合成一小段源码、跑一遍 `sx`"的结果：

- `✓` 降得下来（一条诊断都没有）
- `·` 语法就不认 —— 那是**规格**（这门语言里写不出来），不是洞
- `N…` 前端自己说的边界（"还不收"）
- `E…` 普通错 —— **这一栏是下一刀的料**：话对不对、认不认错人，都在这儿看

位置 1 × 要素 66 = 66 格：✓ 46、N 14、E 3、· 3、炸 0

| 要素 | class-body |
|---|---|
| field-int | ✓ |
| field-string | ✓ |
| field-array | ✓ |
| field-static | ✓ |
| field-const | ✓ |
| field-bitfield | N1 |
| field-bigendian | ✓ |
| field-class-value | ✓ |
| field-class-ptr | ✓ |
| struct | ✓ |
| union-named | ✓ |
| union-anon | · |
| struct-anon | · |
| class | ✓ |
| enum | ✓ |
| enum-anon | ✓ |
| enum-bitflag | ✓ |
| typedef | ✓ |
| typedef-fn | ✓ |
| typedef-fnptr | ✓ |
| alias-method | ✓ |
| method-body | ✓ |
| method-proto | ✓ |
| method-static | ✓ |
| method-errorcode | ✓ |
| construct | ✓ |
| construct-args | ✓ |
| static-construct | ✓ |
| destruct | N3 |
| operator-add | N4 |
| operator-assign | ✓ |
| property-simple | ✓ |
| property-full | N5 |
| property-bindable | ✓ |
| event | ✓ |
| reactor | ✓ |
| local-var | ✓ |
| import | N6 |
| pragma | N6 |
| using-namespace | N6 |
| extension | N6 |
| namespace | N6 |
| class-opaque | ✓ |
| method-virtual | ✓ |
| method-abstract | ✓ |
| field-fnptr | ✓ |
| field-multicast | ✓ |
| method-override | E7 |
| enum-typed | ✓ |
| property-indexed | ✓ |
| dylib | N6 |
| field-thin-ptr | ✓ |
| field-array-dyn | E8 |
| template-ctor-expr | N9 |
| friend | · |
| field-static-init | ✓ |
| event-args | ✓ |
| alias-field-path | ✓ |
| class-multi-base | ✓ |
| disposable-class | E10 |
| method-const | ✓ |
| property-static | N11 |
| field-weak-ptr | N12 |
| fn-async | N13 |
| fn-unsafe | ✓ |
| attribute-decl | ✓ |

## 修饰词留痕了吗（`trace`）

带修饰词的那几种要素还有第三问：**把那几个词去掉再降一遍，两份 sx 一样吗**。一样就说明
这一层把它们丢了。丢了不一定是错（`const` / `unsafe` 只在编译期管事），所以期望写在规格里 ——
这一问是"`ok` 只说明没诊断、不说明降对了"那条界的补救（ADR-0029 第 10.21 节）。

没留下痕迹的：4 格。

- `class-body|field-const` —— 那几个词降出来没留痕
- `class-body|field-bigendian` —— 那几个词降出来没留痕
- `class-body|method-const` —— 那几个词降出来没留痕
- `class-body|fn-unsafe` —— 那几个词降出来没留痕

## 名字落在哪（`escapes`）

带体的那几种要素还有第二问：**声明出来的名字，在写它的那层作用域外面认不认得**。
量法是把"用一下那个名字"塞进后面一个函数体里再编一遍 —— 编得过就是漏出去了。
这一列就是 ADR-0016 第 219/250/260 刀那笔代价（T-005）的清单。

漏到外面那层：0 格；留在原处：10 格。


## 理由表

1. 这个位置上的位域（`: 位数` 只在结构体的字段上）
2. 语法不认
3. '…' —— jancy 那边它是 GC 在**不确定的时刻**调的（disposable.rst:17），要确定时机得先有 dispose/nestedscope 那一套
4. 算符重载 '…'
5. 这种类型说明符（**没位置**）
6. 类里除字段以外的成员
7. 覆盖不了 '…'：基类里没有方法 '…'（jancy 那句 "cannot override '…': method not found"）（**没位置**）
8. 字段 '…' 的长度得写出来
9. '…' 是一格类型，`类型(实参…)` 是 jancy 的**构造式转换**（要按目标类型挑一条转换，与 `(类型)值` 那种写法同一件事）—— 这一层只收 `(类型)值` 那一种
10. `disposable` 只能写在**局部量**上（jancy 那边这个词只在那一档收，jnc_ct_Parser.cpp:2050-2068 —— 类自己的"可弃"是靠有一格 `dispose` 方法，disposable.rst 那句 "usually aliased to close/disconnect/…"）
11. `static` 写在属性上
12. `weak` 指针 —— jancy 那儿它是另一种指针（ClassPtrKind_Weak / FunctionPtrKind_Weak / PropertyPtrKind_Weak，jnc_ct_DeclTypeCalc.cpp:667/676/688），GC 收了对象之后它自己变 null；这一层没有 GC，收下不看会让 `if (p)` 永远为真
13. `async` 函数 —— jancy 那儿它换掉返回类型（写出来的那个挪去 m_asyncReturnType，函数真正回一格 `std.Promise*`，jnc_ct_TypeMgr.cpp:664-672），体还要拆成一台能在 await 处停下再接着跑的状态机

## 怎么读它

- **E 那一栏**是优先级最高的：普通错意味着"这一层认为你写错了"，而语料里写着的东西
  多半没错 —— 第 248/251/253 刀那三条"认错人"就长这样。
- **同一行里 ✓ 与 N 混着**说明这件事与位置有关，那正是位置代数该管的；
  同一列里大片 N 说明那个位置本身还欠一套机器。
- 这张表**不替代**语料榜（`tests/lib/jnc-sweep.js`）：榜量"语料里真写了什么"，
  这张表量"规格里可能写什么"。两张一起才知道"下一刀值不值"。

