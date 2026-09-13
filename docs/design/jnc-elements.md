# jancy 的 位置 × **乘出来的**要素（发现器，ADR-0029）

这一份是 `node tests/lib/jnc-gen.js` 跑出来的。要素不是手数的，是从 `src/lang/jnc/syntax.js`
（照 jancy 的 .llk 抄的词汇表）**乘出来**的 —— 见 `src/lang/jnc/elements.js`。

位置 1 × 要素 301 = 301 格：✓ 101、N 148、E 25、· 27、炸 0

| 要素 | 组 | 上下文 | fn-body |
|---|---|---|---|
| `dcl:plain` | declarator | local | ✓ |
| `dcl:init` | declarator | local | ✓ |
| `dcl:ptr` | declarator | local | ✓ |
| `dcl:array` | declarator | local | ✓ |
| `dcl:bitfield` | declarator | local | N |
| `dcl:fn-proto` | declarator | local | N |
| `dcl:fn-body` | declarator | local | N |
| `dcl:fn-args` | declarator | local | N |
| `dcl:fn-ptr` | declarator | local | ✓ |
| `dcl:prop-simple` | declarator | local | ✓ |
| `dcl:prop-indexed` | declarator | local | N |
| `dcl:prop-full` | declarator | local | N |
| `mod:unsigned×plain` | modifier | local | ✓ |
| `mod:unsigned×init` | modifier | local | ✓ |
| `mod:unsigned×ptr` | modifier | local | ✓ |
| `mod:unsigned×array` | modifier | local | ✓ |
| `mod:unsigned×bitfield` | modifier | local | N |
| `mod:unsigned×fn-ptr` | modifier | local | ✓ |
| `mod:bigendian×plain` | modifier | local | ✓ |
| `mod:bigendian×init` | modifier | local | ✓ |
| `mod:bigendian×ptr` | modifier | local | ✓ |
| `mod:bigendian×array` | modifier | local | ✓ |
| `mod:bigendian×bitfield` | modifier | local | N |
| `mod:bigendian×fn-ptr` | modifier | local | ✓ |
| `mod:const×plain` | modifier | local | ✓ |
| `mod:const×init` | modifier | local | ✓ |
| `mod:const×ptr` | modifier | local | ✓ |
| `mod:const×array` | modifier | local | ✓ |
| `mod:const×bitfield` | modifier | local | N |
| `mod:const×fn-proto` | modifier | local | N |
| `mod:const×fn-body` | modifier | local | N |
| `mod:const×fn-args` | modifier | local | N |
| `mod:const×fn-ptr` | modifier | local | ✓ |
| `mod:const×prop-simple` | modifier | local | ✓ |
| `mod:const×prop-indexed` | modifier | local | N |
| `mod:const×prop-full` | modifier | local | N |
| `mod:maybeconst×plain` | modifier | local | · |
| `mod:maybeconst×init` | modifier | local | · |
| `mod:maybeconst×ptr` | modifier | local | · |
| `mod:maybeconst×array` | modifier | local | · |
| `mod:maybeconst×bitfield` | modifier | local | · |
| `mod:maybeconst×fn-proto` | modifier | local | · |
| `mod:maybeconst×fn-body` | modifier | local | · |
| `mod:maybeconst×fn-args` | modifier | local | · |
| `mod:maybeconst×fn-ptr` | modifier | local | · |
| `mod:maybeconst×prop-simple` | modifier | local | · |
| `mod:maybeconst×prop-indexed` | modifier | local | · |
| `mod:maybeconst×prop-full` | modifier | local | · |
| `mod:autoconst×plain` | modifier | local | ✓ |
| `mod:autoconst×init` | modifier | local | ✓ |
| `mod:autoconst×ptr` | modifier | local | ✓ |
| `mod:autoconst×array` | modifier | local | ✓ |
| `mod:autoconst×bitfield` | modifier | local | N |
| `mod:autoconst×fn-proto` | modifier | local | N |
| `mod:autoconst×fn-body` | modifier | local | N |
| `mod:autoconst×fn-args` | modifier | local | N |
| `mod:autoconst×fn-ptr` | modifier | local | ✓ |
| `mod:autoconst×prop-simple` | modifier | local | ✓ |
| `mod:autoconst×prop-indexed` | modifier | local | N |
| `mod:autoconst×prop-full` | modifier | local | N |
| `mod:readonly×plain` | modifier | local | ✓ |
| `mod:readonly×init` | modifier | local | ✓ |
| `mod:readonly×ptr` | modifier | local | ✓ |
| `mod:readonly×array` | modifier | local | ✓ |
| `mod:readonly×bitfield` | modifier | local | N |
| `mod:readonly×fn-proto` | modifier | local | N |
| `mod:readonly×fn-body` | modifier | local | N |
| `mod:readonly×fn-args` | modifier | local | N |
| `mod:readonly×fn-ptr` | modifier | local | ✓ |
| `mod:readonly×prop-simple` | modifier | local | ✓ |
| `mod:readonly×prop-indexed` | modifier | local | N |
| `mod:readonly×prop-full` | modifier | local | N |
| `mod:volatile×plain` | modifier | local | ✓ |
| `mod:volatile×init` | modifier | local | ✓ |
| `mod:volatile×ptr` | modifier | local | ✓ |
| `mod:volatile×array` | modifier | local | ✓ |
| `mod:volatile×bitfield` | modifier | local | N |
| `mod:volatile×fn-ptr` | modifier | local | ✓ |
| `mod:weak×plain` | modifier | local | N |
| `mod:weak×init` | modifier | local | N |
| `mod:weak×ptr` | modifier | local | N |
| `mod:weak×array` | modifier | local | N |
| `mod:weak×bitfield` | modifier | local | N |
| `mod:weak×fn-ptr` | modifier | local | N |
| `mod:thin×plain` | modifier | local | N |
| `mod:thin×init` | modifier | local | N |
| `mod:thin×ptr` | modifier | local | ✓ |
| `mod:thin×array` | modifier | local | N |
| `mod:thin×bitfield` | modifier | local | N |
| `mod:thin×fn-ptr` | modifier | local | ✓ |
| `mod:safe×plain` | modifier | local | ✓ |
| `mod:safe×init` | modifier | local | ✓ |
| `mod:safe×ptr` | modifier | local | ✓ |
| `mod:safe×array` | modifier | local | ✓ |
| `mod:safe×bitfield` | modifier | local | N |
| `mod:safe×fn-ptr` | modifier | local | ✓ |
| `mod:unsafe×plain` | modifier | local | ✓ |
| `mod:unsafe×init` | modifier | local | ✓ |
| `mod:unsafe×ptr` | modifier | local | ✓ |
| `mod:unsafe×array` | modifier | local | ✓ |
| `mod:unsafe×bitfield` | modifier | local | N |
| `mod:unsafe×fn-proto` | modifier | local | N |
| `mod:unsafe×fn-body` | modifier | local | N |
| `mod:unsafe×fn-args` | modifier | local | N |
| `mod:unsafe×fn-ptr` | modifier | local | ✓ |
| `mod:cdecl×plain` | modifier | local | ✓ |
| `mod:cdecl×init` | modifier | local | ✓ |
| `mod:cdecl×ptr` | modifier | local | ✓ |
| `mod:cdecl×array` | modifier | local | ✓ |
| `mod:cdecl×bitfield` | modifier | local | N |
| `mod:cdecl×fn-proto` | modifier | local | N |
| `mod:cdecl×fn-body` | modifier | local | N |
| `mod:cdecl×fn-args` | modifier | local | N |
| `mod:cdecl×fn-ptr` | modifier | local | ✓ |
| `mod:stdcall×plain` | modifier | local | ✓ |
| `mod:stdcall×init` | modifier | local | ✓ |
| `mod:stdcall×ptr` | modifier | local | ✓ |
| `mod:stdcall×array` | modifier | local | ✓ |
| `mod:stdcall×bitfield` | modifier | local | N |
| `mod:stdcall×fn-proto` | modifier | local | N |
| `mod:stdcall×fn-body` | modifier | local | N |
| `mod:stdcall×fn-args` | modifier | local | N |
| `mod:stdcall×fn-ptr` | modifier | local | ✓ |
| `mod:thiscall×plain` | modifier | local | ✓ |
| `mod:thiscall×init` | modifier | local | ✓ |
| `mod:thiscall×ptr` | modifier | local | ✓ |
| `mod:thiscall×array` | modifier | local | ✓ |
| `mod:thiscall×bitfield` | modifier | local | N |
| `mod:thiscall×fn-proto` | modifier | local | N |
| `mod:thiscall×fn-body` | modifier | local | N |
| `mod:thiscall×fn-args` | modifier | local | N |
| `mod:thiscall×fn-ptr` | modifier | local | ✓ |
| `mod:jnccall×plain` | modifier | local | N |
| `mod:jnccall×init` | modifier | local | N |
| `mod:jnccall×ptr` | modifier | local | N |
| `mod:jnccall×array` | modifier | local | N |
| `mod:jnccall×bitfield` | modifier | local | N |
| `mod:jnccall×fn-proto` | modifier | local | N |
| `mod:jnccall×fn-body` | modifier | local | N |
| `mod:jnccall×fn-args` | modifier | local | N |
| `mod:jnccall×fn-ptr` | modifier | local | N |
| `mod:array×plain` | modifier | local | N |
| `mod:array×init` | modifier | local | N |
| `mod:array×ptr` | modifier | local | N |
| `mod:array×array` | modifier | local | N |
| `mod:array×bitfield` | modifier | local | N |
| `mod:array×fn-ptr` | modifier | local | N |
| `mod:function×plain` | modifier | local | E |
| `mod:function×init` | modifier | local | E |
| `mod:function×ptr` | modifier | local | E |
| `mod:function×array` | modifier | local | N |
| `mod:function×bitfield` | modifier | local | N |
| `mod:function×fn-proto` | modifier | local | N |
| `mod:function×fn-body` | modifier | local | N |
| `mod:function×fn-args` | modifier | local | N |
| `mod:function×fn-ptr` | modifier | local | ✓ |
| `mod:property×prop-simple` | modifier | local | N |
| `mod:property×prop-indexed` | modifier | local | N |
| `mod:property×prop-full` | modifier | local | N |
| `mod:bindable×prop-simple` | modifier | local | N |
| `mod:bindable×prop-indexed` | modifier | local | N |
| `mod:bindable×prop-full` | modifier | local | N |
| `mod:autoget×prop-simple` | modifier | local | E |
| `mod:autoget×prop-indexed` | modifier | local | E |
| `mod:autoget×prop-full` | modifier | local | N |
| `mod:indexed×prop-simple` | modifier | local | N |
| `mod:indexed×prop-indexed` | modifier | local | N |
| `mod:indexed×prop-full` | modifier | local | N |
| `mod:multicast×plain` | modifier | local | E |
| `mod:multicast×init` | modifier | local | E |
| `mod:multicast×ptr` | modifier | local | E |
| `mod:multicast×array` | modifier | local | E |
| `mod:multicast×bitfield` | modifier | local | E |
| `mod:multicast×fn-proto` | modifier | local | E |
| `mod:multicast×fn-body` | modifier | local | N |
| `mod:multicast×fn-args` | modifier | local | E |
| `mod:multicast×fn-ptr` | modifier | local | E |
| `mod:event×plain` | modifier | local | E |
| `mod:event×init` | modifier | local | E |
| `mod:event×ptr` | modifier | local | E |
| `mod:event×array` | modifier | local | E |
| `mod:event×bitfield` | modifier | local | E |
| `mod:event×fn-proto` | modifier | local | E |
| `mod:event×fn-body` | modifier | local | N |
| `mod:event×fn-args` | modifier | local | E |
| `mod:event×fn-ptr` | modifier | local | E |
| `mod:autoevent×plain` | modifier | local | · |
| `mod:autoevent×init` | modifier | local | · |
| `mod:autoevent×ptr` | modifier | local | · |
| `mod:autoevent×array` | modifier | local | · |
| `mod:autoevent×bitfield` | modifier | local | · |
| `mod:autoevent×fn-proto` | modifier | local | · |
| `mod:autoevent×fn-body` | modifier | local | · |
| `mod:autoevent×fn-args` | modifier | local | · |
| `mod:autoevent×fn-ptr` | modifier | local | · |
| `mod:reactor×plain` | modifier | local | ✓ |
| `mod:reactor×init` | modifier | local | ✓ |
| `mod:reactor×ptr` | modifier | local | ✓ |
| `mod:reactor×array` | modifier | local | ✓ |
| `mod:reactor×bitfield` | modifier | local | N |
| `mod:reactor×fn-proto` | modifier | local | N |
| `mod:reactor×fn-body` | modifier | local | N |
| `mod:reactor×fn-args` | modifier | local | N |
| `mod:reactor×fn-ptr` | modifier | local | ✓ |
| `mod:errorcode×plain` | modifier | local | ✓ |
| `mod:errorcode×init` | modifier | local | ✓ |
| `mod:errorcode×ptr` | modifier | local | ✓ |
| `mod:errorcode×array` | modifier | local | ✓ |
| `mod:errorcode×bitfield` | modifier | local | N |
| `mod:errorcode×fn-proto` | modifier | local | N |
| `mod:errorcode×fn-body` | modifier | local | N |
| `mod:errorcode×fn-args` | modifier | local | N |
| `mod:errorcode×fn-ptr` | modifier | local | ✓ |
| `mod:async×plain` | modifier | local | N |
| `mod:async×init` | modifier | local | N |
| `mod:async×ptr` | modifier | local | N |
| `mod:async×array` | modifier | local | N |
| `mod:async×bitfield` | modifier | local | N |
| `mod:async×fn-proto` | modifier | local | N |
| `mod:async×fn-body` | modifier | local | N |
| `mod:async×fn-args` | modifier | local | N |
| `mod:async×fn-ptr` | modifier | local | N |
| `sto:static×plain` | storage | local | ✓ |
| `sto:static×fn-proto` | storage | local | N |
| `sto:static×fn-body` | storage | local | N |
| `sto:static×prop-full` | storage | local | N |
| `sto:threadlocal×plain` | storage | local | N |
| `sto:threadlocal×fn-proto` | storage | local | N |
| `sto:threadlocal×fn-body` | storage | local | N |
| `sto:threadlocal×prop-full` | storage | local | N |
| `sto:abstract×plain` | storage | local | E |
| `sto:abstract×fn-proto` | storage | local | N |
| `sto:abstract×fn-body` | storage | local | N |
| `sto:abstract×prop-full` | storage | local | N |
| `sto:virtual×plain` | storage | local | E |
| `sto:virtual×fn-proto` | storage | local | N |
| `sto:virtual×fn-body` | storage | local | N |
| `sto:virtual×prop-full` | storage | local | N |
| `sto:override×plain` | storage | local | E |
| `sto:override×fn-proto` | storage | local | N |
| `sto:override×fn-body` | storage | local | N |
| `sto:override×prop-full` | storage | local | N |
| `sto:mutable×plain` | storage | local | ✓ |
| `sto:mutable×fn-proto` | storage | local | N |
| `sto:mutable×fn-body` | storage | local | N |
| `sto:mutable×prop-full` | storage | local | N |
| `sto:disposable×plain` | storage | local | N |
| `sto:disposable×fn-proto` | storage | local | N |
| `sto:disposable×fn-body` | storage | local | N |
| `sto:disposable×prop-full` | storage | local | N |
| `sto:dynamicfield×plain` | storage | local | · |
| `sto:dynamicfield×fn-proto` | storage | local | · |
| `sto:dynamicfield×fn-body` | storage | local | · |
| `sto:dynamicfield×prop-full` | storage | local | · |
| `sto:typedef×type` | storage | local | ✓ |
| `sto:typedef×fn` | storage | local | ✓ |
| `sto:typedef×fnptr` | storage | local | ✓ |
| `sto:alias×fn` | storage | local | ✓ |
| `sto:alias×self` | storage | local | ✓ |
| `type:struct` | named-type | local | ✓ |
| `type:union` | named-type | local | ✓ |
| `type:class` | named-type | local | ✓ |
| `type:opaque-class` | named-type | local | ✓ |
| `type:enum` | named-type | local | ✓ |
| `type:enum-bitflag` | named-type | local | ✓ |
| `type:enum-typed` | named-type | local | ✓ |
| `type:enum-anon` | named-type | local | ✓ |
| `type:struct-anon` | named-type | local | · |
| `type:union-anon` | named-type | local | · |
| `type:dylib` | named-type | local | N |
| `spec:construct` | special | local | N |
| `spec:construct-args` | special | local | N |
| `spec:static-construct` | special | local | N |
| `spec:destruct` | special | local | N |
| `spec:operator-add` | special | local | N |
| `spec:operator-assign` | special | local | N |
| `spec:operator-call` | special | local | N |
| `spec:operator-index` | special | local | N |
| `spec:operator-cast` | special | local | N |
| `common:using` | common | local | N |
| `common:pragma` | common | local | N |
| `common:attribute-block` | common | local | ✓ |
| `only:namespace` | context-only | local | N |
| `only:extension` | context-only | local | N |
| `only:friend` | context-only | local | N |
| `only:access-label` | context-only | local | N |
| `only:statement` | context-only | local | E |
| `only:catch-label` | context-only | local | ✓ |
| `only:finally-label` | context-only | local | N |
| `only:nested-scope-label` | context-only | local | N |
| `ty:void` | type-spec | local | N |
| `ty:class` | type-spec | local | N |
| `ty:anydata` | type-spec | local | N |
| `ty:bool` | type-spec | local | ✓ |
| `ty:char` | type-spec | local | ✓ |
| `ty:short` | type-spec | local | ✓ |
| `ty:long` | type-spec | local | ✓ |
| `ty:float` | type-spec | local | ✓ |
| `ty:double` | type-spec | local | ✓ |
| `ty:intptr` | type-spec | local | ✓ |
| `ty:property-template` | type-spec | local | N |

## 理由榜

- **52** `N` 语句 '…'
- **30** `N` 函数体里的这一条 '…'：要么是一格**函数原型**（jancy 的函数体里写不了原型 —— 那要一层"块作用域也是命名空间"），要么是"局部量后面挂构造实参"（`T v(a, b)`，那一种只有类与结构体的变量收得下）
- **27** `syn` 语法不认
- **16** `E` 多播的处理函数只能回 void（jancy 那句 "Multicasts must return void"），这里写的是 int
- **14** `N` 这个位置上的位域（`: 位数` 只在结构体的字段上）
- **14** `N` 修饰符 '…'
- **8** `N` `async` 函数 —— jancy 那儿它换掉返回类型（写出来的那个挪去 m_asyncReturnType，函数真正回一格 `std.Promise*`，jnc_ct_TypeMgr.cpp:664-672），体还要拆成一台能在 await 处停下再接着跑的状态机
- **6** `N` `weak` 指针 —— jancy 那儿它是另一种指针（ClassPtrKind_Weak / FunctionPtrKind_Weak / PropertyPtrKind_Weak，jnc_ct_DeclTypeCalc.cpp:667/676/688），GC 收了对象之后它自己变 null；这一层没有 GC，收下不看会让 `if (p)` 永远为真
- **4** `N` `thin` 用在不是指针的类型上
- **4** `N` 函数体里的属性声明（属性指针要一格"属性指针"类型）
- **3** `E` '…' 是函数指针，后面要一对形参表
- **3** `E` '…' 只能写在类的方法上（type_class.rst:178）
- **2** `N` fnty0 的局部量不写初值
- **2** `E` `autoget` 只能写在属性上（prop_autoget.rst:15；完整声明式里它写在属性体内那格字段上，同处:34）
- **2** `N` `indexed` 属性 —— jancy 那儿它让取/存那两个函数带下标形参（jnc_ct_DeclTypeCalc.cpp:565 与 :614），于是 `p[i]` 接的是属性那两个函数、不是一格内存
- **2** `N` `threadlocal`（要线程本地存储）
- **2** `N` `disposable` 的局部量 —— jancy 那儿它给这一格开一个可弃作用域、出去的时候（正常出去与抛出去都算）调它的 `dispose`（jnc_ct_Parser.cpp:2050-2068），要作用域出口那一套钩子
- **2** `N` 这种类型说明符
- **1** `N` 函数指针的数组（要方言能把函数值当元素搬）
- **1** `N` 函数指针上的声明符后缀 '…'
- **1** `N` 写在函数体里的 `using namespace X;` —— 它的作用域是这个块，要一张跟着作用域一起进出的表（写在命名空间那一层的那一格收了，见 ADR-0016 第二百一十七刀）
- **1** `E` 未声明的变量 '…'
- **1** `N` `finally:`（不管走哪条路都要跑一遍 —— 连 `return` 也得先绕过去，jancy 为它专门开了一格 `finallyRouteIdx` 变量，jnc_ct_ControlFlowMgr_Eh.cpp:41-50）
- **1** `N` `nestedscope:` —— 它把后面那一段变成一格嵌套的可弃作用域（disposable.rst:17 那句"要确定时机就用 dispose / nestedscope"），要作用域出口那一套钩子 —— 与 `disposable` 记同一笔账（第二百一十二刀）
- **1** `N` 类型 '…'
