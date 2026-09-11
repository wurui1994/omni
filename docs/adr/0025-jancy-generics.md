# ADR-0025：jancy 的泛型（模板）——要不要按实例单态化

- 状态：**只量墙**；S1 试过一趟又回退了（量到的三件事记在下面，判据一因此改过）
- 起因：换个口径排尺子之后，"每份文件只剩一条拦路项"的第一名是解析错 `unexpected "<"`，**12 份**
- 相关：ADR-0016（jancy 前端，第八十九刀刚把 `this_modifier_suffix` 那条读错的注修好）、
  ADR-0014（方言与四个后端）、ADR-0023（尺子与轴的增量）

## 背景：12 份文件就差一个 `<T>`

`.omni-cache/test/log/jnc-sweep.log`（655 份）里按"sole = 这份文件只剩这一条拦路项"排，
现在有 **102 份**只差一条。头三组**都不是语义，是解析错**：

- `unexpected "<"` **12 份** —— 全是 jancy 的模板容器：
  `src/jnc_ext/jnc_std/jnc/stdt_{Array,BinTree,BoxList,HashTable,Iterator,List,Map,Operator,RbTree}.jnc`、
  `test/jnc/{test157,test158,unit_stdt_List}.jnc`；
- `unexpected "thin"` 6 份 + `unexpected "?"` 2 份 —— **ADR-0016 第八十九刀已落**
  （`this_modifier_suffix` 收 `const` / `const?` / `thin` 三个，先前只写了 `const`）；
- `unexpected "int"` 4 份（`test/jnc/unit_stdt_{Array,BoxList,HashTable,RbTree}.jnc`）——
  那是**实例化那一侧**（`stdt.Array<int>`），与这一格是同一件事。

所以这一格的账面是 **12 + 4 = 16 份文件**，而「真降得下来」这个数字当时在 61 停了三刀（今天是 83，见本文末尾那一节的复量）。
它是现在最大的一格单点。

形状（`src/jnc_ext/jnc_std/jnc/stdt_Array.jnc:19-32`）：

```jnc
class Array<T> {
    T autoconst* readonly m_p;
    size_t readonly m_count;

    T get(size_t index) const {
        boundsCheck(index);
        return m_p[index];
    }

    bool errorcode set(size_t index, T e);
}
```

## jancy 那边是怎么做的（读源码读出来的）

**一、声明产出的不是一格类型，是一格"模板"，体是没解析的记号串。**

- 语法：`class_specifier` 的第二支 `template_decl_suffix (':' template_type_name_list)?
  declaration_body_pass1` -> `declareTemplate(TypeKind_Class, …, &$y.m_tokenList)`
  （`jnc_ct_NamedTypeSpecifier.llk:168-195`；`struct` 同 `:117-128`，`union` 同 `:149-159`，
  而 union 那一支传的基类表是**空的** —— 泛型的 union 不能有基类）；
- 参数表：`template_decl_suffix : '<' { openTemplateDeclNamespace() } template_arg
  (',' template_arg)* '>'`，而 `template_arg : ID ('=' type_name_declarator)?`
  （`jnc_ct_Declarator.llk:424-439`）—— **参数可以有默认类型**；
- 每个参数是一格 `TemplateArgType`（`TypeKind_TemplateArg`，`jnc_ct_TemplateType.h:34-97`），
  按名字登记进那格 `NamespaceKind_TemplateDeclaration` 作用域（`jnc_ct_Parser.cpp:1175-1191`）；
- 声明本身产出 `ModuleItemKind_Template`：`createTemplate(...)` + `setBody(templ, bodyTokenList)`
  （`jnc_ct_Parser.cpp:1249-1277`），`Template` 上挂着 `m_argArray` / `m_baseTypeArray` /
  `m_instanceMap`（`jnc_ct_Template.h:45-56`）。**声明时一个字都不检查**；
- 基类也不是类型：`template_type_name_list` 把每个基类包成一格 `TemplateDeclType`
  （`jnc_ct_Name.llk:244-258`，那是一份"声明符配方"，`jnc_ct_TemplateType.h:199-245`）。

**二、实例化是按实参签名记账的单态化（不是类型擦除）。**

`Template::instantiateImpl`（`jnc_ct_Template.cpp:139-261`）：

```cpp
sl::String signature;
for (size_t i = 0; i < argCount; i++) signature += argArray[i]->getSignature();
… m_instanceMap.visit(signature) …
if (instance->m_item) return instance->m_item;              // 命中就是同一格类型
if (instance->m_error) { err::setError(instance->m_error); return NULL; }   // 失败也记账
…
type = m_module->m_typeMgr.createClassType(m_name, …);       // 每份实参一格新类型
copyDecl(type);                                             // 体的记号串也抄一份
for (i…) { Typedef* tdef = createTypedef(m_argArray[i]->getName(), argArray[i]); type->addItem(tdef); }
for (i…) { Type* baseType = m_baseTypeArray[i]->instantiate(argArray); type->addBaseType(baseType); }
```

三件事要记住：**参数是以 typedef 的形式注进那格新类型里的**（所以体里的 `T` 就是普通的名字
查找）；**基类是按下标替换出来的**（`TemplateDeclType::instantiate`，
`jnc_ct_TemplateType.cpp:216-278`）；**失败也 memoise**（同一份实参不重报两遍）。

**三、实例化那一侧的语法允许空槽、按默认值补。**
`template_inst_type_name_list`（`jnc_ct_Name.llk:260-293`）是 nullable 的，`Foo<, int>` 里
那一格是 `NULL`，由 `Template::setDefaultArgs`（`jnc_ct_Template.cpp:105-137`）填 ——
没有默认类型就报 `"argument '%s' of template '%s' has no default type"`。
（与 ADR-0016 第八十八刀调用点的空槽是**同一个语法思路**，这一层已经有那一套。）

**四、pass1 只捕记号。**`'<' … '>'` 在 pass1 里只是被记下来
（`template_instantiate_operator_pass1`，`jnc_ct_Expr.llk:73-88`），后面再按
`SymbolKind_template_inst_type_name_list_save` 重解一遍（`jnc_ct_Template.cpp:88-103`）——
这正是它绕开 `a < b` 与 `A<B>` 那条歧义的办法。

## 墙在这一层的哪儿：四处，都在流水线的形状上

**一、语法两处都没有**：类/结构体头上的 `<T…>`，与类型位置上的 `名字<实参…>`。
后者是**真歧义**：`Array<T> x;` 与 `(Array < T) > x` 两条都能归约完。jancy 用 pass1 捕记号
绕开；这一层的 GLR 有 `(prefer N)`（`jnc.grammar` 的位域那一条就是这么写的），得量清偏哪一边、
偏了会不会把别的写法带歪。

**二、流水线是按遍走的，而实例化是"降到一半才发现的"。**`run()` 里的顺序（`lower.js`）：

```
typeName(1836) -> typedef/alias(1842) -> propName(1863/1869) -> classLayout(1873)
 -> reactorBody(1881) -> fnSig(1888) -> vtCheck(1892) -> emitAliases(1894)
 -> synthCtors(1923) -> gTaken(1928) -> globalDecl(2010) -> topItem 体(2020)
 -> emitFieldInitCtors(2025) -> emitReactors(2027)
```

一格新实例要**从第一遍开始**走一趟（名字要坐下、字段表要进 ownFields、整条链要进
classLayout、方法签名要登记、体要降）。所以实例化不能在"降类型名"的时候当场做 ——
**得先有一遍把所有实例化点找出来**，把实例当成合成的 `type-decl` 塞进 `items`，然后照常走。

**三、实例化是会传染的**：一格泛型的体里可以实例化另一格泛型
（`Map<K,V>` 里有 `List<Entry>`），所以那一遍是个**工作队列**：新造出来的实例体还要再扫一遍，
直到不再出新的。这也是单态化的老问题 —— 得有一道深度/个数的闸门，不然递归实例化会不收敛。

**四、体是共享的 AST，不能就地降两遍。**`this.sigs` 是**按 AST 节点**记的
（`lower.js:839` 那句 `this.sigs = new Map()`，`run` 里 `this.sigs.set(e.it, s)`）——
同一格 fn-def 节点在两个实例里各降一次就会互相盖掉。所以每格实例要**深拷一份体的子树**
（节点是纯数据：`kind` / `items` / `value` / `span`，抄的时候 span 照留 —— 诊断指回泛型那一行，
与 jancy 一样）。

## S1 落了：一条产生式接在 `qname` 上，**零条新冲突**

先前那一趟给"类头"与"类型位置"各接一条，类头那条添了 70 条冲突。这一版换成**一条** ——
`<实参…>` 接在 `qname` 自己身上。理由是量出来的：那四处 `<` 全都从 `qname` 来
（类头走 `named-type` 的 `agg-key qname base-list`、类型位置走 `type-spec -> (qname)`、
基类表走 `qname-list -> qname`、体外定义的 `Array<T>.set` 就是
`qname "<" … ">" "." ID` 落在这一条与 `qname "." ID` 的组合上）。

- `conflicts left` 1443 -> **1443（一条没涨）**，状态 654 -> 663，规则 363 -> 368；
- 所以先前那 **+70 是"另开一条类头产生式与 `type-spec` 的裸 `class` 打架"的利息**，
  不是 `<` 本身的。下面那一节写的"类头那条添了 70"要连这一句一起读。

声明的参数表与用的实参表在语法上是**同一条**（都是 `targs`）：`class Array<T>` 里的 `T` 与
`Array<int>` 里的 `int` 长得一样，分开靠位置（类头那一处的实参必须全是裸名字）。
带默认类型的参数也收（语料里 3 格泛型 4 个槽）。

### 验收那一条"解析结果不退"：查清了，**没退**

尺子上 `unexpected "<"` **12 -> 0**、`unexpected "int"` 4 -> 1，可诊断里多出三条单份文件的
解析错。逐份对了一遍 r117 与 r118 的每份文件清单，答案是**两份**，而且都是**新走到的**、
不是新引进的：

- `stdt_HashTable.jnc`：先前唯一的拦路项是 `unexpected "<"`，现在是 `unexpected "basetype"`
  （`:155:42`，`p.m_bucket.basetype.remove(…)` —— `.basetype.` 当取成员的左边，
  这一层的语法只在方法调用那一处收 `basetype`）；
- `unit_stdt_RbTree.jnc`：先前是 `unexpected "int"`，现在是 `unexpected "else"`。

**没有任何一份先前解析得动的文件现在解析不动**（逐份 diff 过，别的文件一条解析错都没多）。
这两格是新露出来的两处**别的**语法空档，各记一笔账，与这一格无关。

尺子那三个数：真降得下来 83（没动 —— S1 只是语法，S3 没落之前一份都编不过）、
没有还不收 164 -> 151、对数 7510 -> 7556。后两个往回走是第一百一十三刀记过的同一条口径：
一句早早挡住整份文件的 E 会把下游所有 N 藏起来。

于是 S1 收完了。那 16 份现在报的 N 也把 S3 要办的事排出来了：`这种类型说明符` 14
（泛型的 typedef）、`限定名或特殊名的声明符` 15（`Array<T>.set` 那种体外定义 ——
与 ADR-0016 第一百〇七刀的 extension 同形）、`认不出的基类名字` / `认不出的限定名` 各 1。

## S2/S3 落之前要定的那一个判据：**替换发生在哪一层节点上**

S1 收完之后翻了一遍 run() 那串遍的顺序与 `targ` 出来的节点形状，剩下的设计问题只有一个，
写清楚了 S2/S3 就是机械活。

**遍的位置定了**：`expandTemplates` 排在 `expandFullProps` **之后**、"类型的名字先坐下"
（typeName 那一遍）**之前**。理由与第一百〇七刀的 `expandExtensions` 是一对：
extension 要**查得着**目标类型所以排在 typeName 之后，而泛型声明**不能让 typeName 看见**
（它不产出类型），所以排在之前。这一遍做两件事：

1. 把 `type-decl` 里名字是 `tinst` 的那些**摘出名单**，记进 `this.templates`；
2. 工作队列扫剩下的名单找 `tinst` 用点，实例化，把合成的 `type-decl` **追加**回名单，
   再扫新加的那几格 —— 跑到不动点（嵌套实例化就是靠这一步自然解开的）。

**要定的那一个判据是替换的层次。** `targ` 出来的是一格 `type-name` 节点
（`(type-name specs ptrs)`，jnc.grammar 的 `type-name` 那条），而模板体里的参数是以
**`(name T)`** 的形状出现在 `type-spec` 位置上（`type-spec -> (qname) (prec DECL_ID)`）。
两者层次不同，所以"把 `(name T)` 整个换成那格 `type-name`"是**错的** —— 形状对不上，
而且 `Bucket*` 那种带 `*` 的实参里那个 `*` 会跑到错的地方去（`T m_p` 与 `T* m_p` 在
声明符那一层的 ptrs 是分开的）。

三条路，判据是"哪一条不会给出错答案"：

1. **只在 `type-spec` 那一层替**：实参**只收不带 `*` 的一格 type-spec**（`int` / `char` /
   一个 qname），把 `(name T)` 换成实参那格 type-spec 的子树。带 `*` 的、函数类型的、
   数组的实参当场拒。**量过：17 格落地实例里这一条覆盖 15 格**，拒掉的是
   `Array<Bucket*>`（`stdt_HashTable.jnc:69`）与嵌套的
   `Iterator<RbTreeNode<int,int> >`（`unit_stdt_RbTree.jnc:141`）；
2. 在声明符那一层替（把实参的 ptrs 并进用点的 ptrs）—— 覆盖得全，可"两处 ptrs 怎么并"
   要另立一条规矩，而并错了是**静默的错答案**（`T* m_p` 里的 T 是 `Bucket*` 时到底几颗星）；
3. 干脆在**词法**那一层替（照 jancy 那样存记号串、按实参重解一遍）—— 最贴近 jancy，
   可这一层没有"存记号回头再解"的机制（见上面那一节），要新造。

**选 1**，理由是这个仓库一贯的那条：一次只开一格、界写清。第 2 条那格账（两处 ptrs 怎么并）
单独一刀，等第 1 条落了、有了真实例可对照再定；第 3 条不做（要新造机制）。

于是 S5 那张"先不收"的单子上要加两条，各自都是**明说**而不是悄悄算错：

- 实参带 `*`（`Array<Bucket*>`）；
- 实参本身是一格实例化（`Iterator<RbTreeNode<int,int> >`）—— 这一条要等工作队列那一步
  与"实参也要先实例化"接上，不难，可它与上面那条 ptrs 的账是两件事，别混。

## 落法（建议的分步，S1 已落）

- **S1 语法**：类/结构体头上的 `<T…>`（带默认类型），与类型位置上的 `名字<实参…>`。
  验收原来写的是"`tests/glr` 的 jnc 表**冲突数不许涨**"。**试过一趟、量出来了，那条验收是错的**
  —— 见下面「S1 试了一趟，量到三件事」。
- **S2 登记**：泛型声明**不产出类型**，只在一张 `this.templates` 上记
  `{name, params: [{name, def}], bases, body}`（与 jancy 的 `Template` 一一对应）。
  这一层还要记它是 class 还是 struct。
- **S3 实例化那一遍**：扫全部 `items`（含类体里）找类型位置上的 `名字<实参…>`，
  实参按已知类型解出来、拼出实例名（`stdt$Array$int`，与 `mcFire` 那处按类型拼名字同一套），
  用一张 map memoise（**失败也记**，与 jancy 同）。每格实例：深拷体、把参数名以 alias 的形式
  绑进那格实例的命名空间（`this.aliases.set('stdt$Array$int$T', J_I32)` —— 第八十七刀那张表
  正好就是这个用途），造一格合成的 `type-decl` 塞进 `items`。**工作队列**跑到不动点。
- **S4 出错的话怎么说**：一格实例里报的错要能指回"哪一份实参把它压坏的"——
  诊断上补一句"（`stdt.Array<int>` 这一格实例）"，不然 span 指在泛型那一行会让人找不着北。
- **S5 界**：先不收的那几格要明说 —— 非类型参数（jancy 有没有另说，语料里没有）、
  参数当基类（`class MapImpl<T>: T` 那种，语料里有）、递归实例化超过闸门、
  函数模板的实参推导（`Template::deduceArgs`，`jnc_ct_Template.cpp:263-325`）。

## S1 试了一趟，量到三件事（改动已回退，表还是 1443）

试的那一版加了三条产生式：类头上的 `<tparams>`（新头 `agg-tmpl`）、类型位置上的
`qname "<" targs ">"`（新头 `type-inst`）、以及 `tparams` / `targs` / `tparam` / `targ` 四条辅助规则。

**一、`<` 一共有四个位置，不是两个。** 挡住那 12 份文件的不止类头与类型位置：

```jnc
bool errorcode Array<T>.set(size_t index, T e) { … }      // stdt_Array.jnc:82  —— 声明符里的限定名
struct BoxListEntry<T>: ListEntry<BoxListEntry> { … }     // test157.jnc:12     —— 基类表
typedef IteratorImpl<BoxIteratorBase<T> > BoxIterator<T>; // test157.jnc:32     —— **泛型的 typedef**
```

加上那两个就是四处：类头、类型位置、**基类表**（走的是 `qname-list`，不是 `type-spec`）、
**体外定义的限定声明符**（`Array<T>.set`）。第三种还带一格新形状：`typedef` 也能是泛型的。
所以 S1 不是"两条产生式"，是把 `<实参…>` 接到**四条路**上去。

**二、代价的方向与预想的相反，量出来的**（`omni glr table … --brief` 的 `conflicts left`）：

- 只加**类型位置**那一条：1443 -> **1443**（一条没涨，状态数 653 -> 661）；
- 只加**类头**那一条：1443 -> **1513**（+70，状态数 653 -> 667）。

也就是说我怕的那条（`a < b` 与 `A<B>` 的歧义）一条冲突都没添，而"看着无害"的类头那条添了 70。
原因看得见：`class` 光一个词就是"抽象类"那个类型（`type-spec` 那条 `(prefer -1) (abstract-class)`），
于是 `class Foo <` 之后 LR 分不清"这是模板声明"还是"抽象类类型 + 声明符 Foo + 一个 `<` 比较"。

**三、`(prefer …)` 治不了这一格。** 给类头那条挂 `(prefer 1)` 之后冲突数还是 1513 ——
那格偏好是**运行期**给 GLR 驱动器裁决用的，不改建表时留下的冲突数。

**所以判据一要改**：不能要求"冲突数不涨"。冲突不是错，GLR 会把两条都走、错的那条自己死；
该量的是**结果**：整份语料解析出来的树没有新的歧义报错、且解析时间不退。改成：

1. ~~表的冲突数不涨~~ -> **语料 655 份的解析结果与解析耗时都不退**（歧义报错 0 条），
   而 `+70` 这一格要在 ADR 里记成账：那是 `class` 兼作"抽象类类型"这条老规则的利息。

另外量到一件顺手的好事：语料里嵌套实例化一律写成 `Iterator<RbTreeNode<int, int> > it`
（**`>` 前面有空格**，C++98 那个写法），所以 `>>` 那个老问题这儿**不存在**。

## 又量到一条：整个 `std` 那一组，只差这一个 `<T>`

第九十三刀之后顺着尺子的一个盲点（见 ADR-0016 那一节"语料里有些文件本来就不是一份一份编的"）
拿"整目录一起编"的量法看了一眼 `src/jnc_ext/jnc_std/jnc`（19 份）：

```
/…/jnc_std/jnc/stdt_Array.jnc:19:12: error: unexpected "<" '<'; expected …
  class Array<T> {
             ^
```

**整组就这一条错。**别的 18 份（`std_Buffer` / `std_HashTable` / `std_List` /
`std_String` / `std_Map` …）一条都没有。这一格比上面"12 份文件差一个 `<T>`"那个数字更硬：
它说的是**这一层离一整个标准库只差这一件事** —— 而语料里 98 + 91 对
`import "std_HashTable.jnc"` / `import "std_Buffer.jnc"` 找不着的账，正是要靠这一组落地
才还得上（那两条 import 拦的不是路径，是"这一组还编不下来"）。

所以判据 3 上再加一条：

3'. `src/jnc_ext/jnc_std/jnc` 那 19 份用"整目录一起编"的壳量，错**归零**（现在是 1 条）。

## 判据

1. **语料 655 份的解析结果与解析耗时都不退**（歧义报错 0 条）—— 原来写的"表的冲突数不涨"
   已经量过是错的判据，见上面那一节；类头那条产生式的 +70 记成账；
2. `stdt_Array.jnc` 那一份能降下来，`unit_stdt_Array.jnc`（实例化那一侧）能**跑**，
   六条腿逐字节相同；
3. 尺子：`unexpected "<"` 那 12 对清零，`unexpected "int"` 那 4 对跟着清；
   「真降得下来」要动 —— 这是这一格的**唯一**理由（对数升降都可以解释，见 ADR-0016
   第八十七/八十八刀那两处口径的账）；
4. 同一份实参不重复造类型（memoise 生效）：拿一份实例化两次的源码量 decls 的条数；
5. 递归实例化撞到闸门时报的是一句**说得清**的话，不是栈溢出。

## 不做的

- 类型擦除那条路（方言的结构体字段是具体类型，擦不掉）；
- 泛型的 union（jancy 自己那一支也不给基类）；
- `jnc.AutoConst<T,C>` / `jnc.ReadOnly<T,C>` 那两格编译器内建的双 const 模板
  （`jnc_ct_TemplateMgr.cpp:57-75`）—— 它们在 `instantiateImpl:161-168` 就短路了，
  是可变性那一族的账，与这一格无关。

## 第一百一十七刀之后复量了一遍：这一节里三处数与三处机制要改

第一百一十二～一百一十七刀之后（对数 7510、真降得下来 83）把这一格从头量了一遍。
**先改这份 ADR 自己的账**：

- 上面写"「真降得下来」这个数字已经在 61 停了三刀" —— 那是第一百一十三刀之前的账，
  今天是 **83**；
- 上面把 16 份分成"12 份声明侧 + 4 份实例化侧"。**分得不对**，逐份跑出来是
  **10 份声明头 + 2 份基类表里的用 + 4 份类型位置的用**：`test158.jnc:7:24`
  （`class C: stdt.ListEntry<C>`）与 `unit_stdt_List.jnc:7:32`
  （`struct TestNode: stdt.ListEntry<TestNode>`）**自己一格泛型都没声明** ——
  它们只是继承了一格泛型的实例。这一格对落法有用：基类表那一条要单独接；
- GLR 的基线状态数也漂了：这份 ADR 记的 653，今天是 **654**（冲突数 1443 没动）。

**jancy 那一侧有三处这份 ADR 说得不全（都在 `jnc_ct_Template.cpp` / `.h`，不在
`src/jnc_ct/` 顶层）**：

1. 实例化那一遍所在的命名空间是 **`NamespaceKind_TemplateInstantiation`**
   （`jnc_ct_Template.cpp:217-218`），`TemplateDeclaration` 只管**声明**时参数名坐哪儿
   （`Parser.cpp:1176-1191`）；
2. `instantiateImpl` 还有一支 **`m_declType`**（`:169-196`）—— **typedef 模板与函数模板**
   走那一支。这份 ADR 的摘录只有 struct/class/union 那一支；
3. **孤儿（orphan）那一段（`:241-257`）这份 ADR 一个字没提**，而它正是
   `bool errorcode Array<T>.set(size_t, T e) { … }`（`stdt_Array.jnc:82`）这种**体外定义**
   如何被逐实例重新挂上去的机制：`cloneOrphan` + `addTemplateInstantiation(argArray)`。
   落法上这一条与第一百〇七刀（extension 把体外方法挂到已有类型上）是同一个形状。

声明时**体是没解析的记号串**（`declareTemplate` 末尾那句 `setBody(templ, bodyTokenList)`，
`Parser.cpp:1275`）—— 也就是说 jancy 在声明处**一个字都不检查体**，实例化时才按实参重解一遍
（`Template.cpp:88-103` 的 `parser.parseTokenList`）。这一条决定了我们这一层不能照抄：
这一层没有"存一串记号回头再解"的机制，所以只能走**克隆 AST + 替换类型参数**。

### 数（全 655 份扫出来的，脚本一次性）

- 泛型声明 **59** 格（class/struct **39** + typedef **20**），分布在 **10 份**文件里；
  不同名字 **50** 个；泛型 union **0** 格（jancy 语法给，语料里没有）；函数模板 **0** 格；
- 类型参数名只有 **10** 个（`B C E H I K M P T V`）；最大元数 **4**
  （`BinTreeNodeBase<T, K, V, P>`，`stdt_BinTree.jnc:21`）；带默认实参的 **3** 格（4 个槽）；
- `名字<…>` 的用点 **247** 处，不同的 (名字, 实参签名) 对 **102** 个；
- **落地（实参全具体）的实例化根只有 17 对 (文件, 签名)，在 8 份文件里。**

### 这一栏答了"要不要单态化"：**要**

全语料有 **3 格泛型被两套落地实参用过**：

- `Array` —— `<int>`（`unit_stdt_Array.jnc:10`）与 `<Bucket*>`（`stdt_HashTable.jnc:69`）；
- `Iterator` —— `<TestNode>`（`unit_stdt_List.jnc:54`）与 `<RbTreeNode<int,int> >`
  （`unit_stdt_RbTree.jnc:141`）；
- `RbTree` —— `<int,int>`（`:10`）与 `<int,int,Gt<int> >`（`:206`，同一份文件里）。

所以"一格泛型只造一份实例"这条捷径**走不通**，按实参签名 memoise 的单态化是必须的 ——
与 jancy 自己那一遍（`instantiateImpl` 开头拼 signature 再查 `m_instanceMap`，`:144-148`）
同一个办法。上面"不做的"里那条"类型擦除走不通"因此又多一条理由：不是只有布局的问题，
是同一格泛型真的要出两份不同的类型。

### `<` 的歧义：jancy 用的是**语义谓词**，不是语法

两处都是同一句话 —— **左边那个名字已经解成一格 Template 时，`<` 才是实例化算子**：

- 表达式侧 `jnc_ct_Expr.llk:803`：`resolver ({ return m_lastPostfixValueKind == ValueKind_Template; })`；
- 类型名侧 `jnc_ct_Name.llk:32-42`：`if ($.m_item->getItemKind() == ModuleItemKind_Template)`。

这一条与上面 S1 量到的"类型位置那条产生式一条冲突都没添、类头那条添了 70"合起来看，
方向就清楚了：**这一层不需要语义谓词** —— GLR 本来就允许两条路并行走、由后面的归约决定，
而量出来的代价（+0 / +70 条冲突）已经在可接受范围里。这与 jancy 用 llk + resolver 的做法
不同，但答案一样。

### 还剩一格没量（下一趟的活，别猜）

**克隆 AST 那一步：量过了，是纯的。** `src/core/sexpr/read.js:15-17` 那三种节点就是全部形状：

```
{kind:'list',   items, span}
{kind:'atom',   value, span}          原样的文本，不做数字解析
{kind:'string', value, raw, span}     value 是解码后的码点串，raw 是引号内的原文
```

而降级那一遍**往节点上一个字段都不写**（在 `lower.js` 里搜过 `节点.字段 = ` 那个形状，
除了读 `items` / `value` / `span` 之外一处赋值都没有）。所以"递归抄一份、把类型参数那个 atom
换掉"就是完整的替换，不用管别名与共享。

还有一条更硬的证据：**这一层已经在合成节点了** —— 第一百〇五刀的 `defConstNode` 就地造
`{kind:'atom', value, span}` 与 `{kind:'list', …}` 塞回去当默认值，一路降下来没事。
也就是说合成出来的节点与解析出来的节点在下游是同一等公民。

**真正还没量的只有一格**：17 格落地实例里有几格是**嵌套**的
（`Iterator<RbTreeNode<int,int> >`，`unit_stdt_RbTree.jnc:141` 就是），嵌套要先实例化里层
再实例化外层 —— 递归的闸门与"同一份实参不重复造"这两条要一起写，而闸门的判据
（多深算深、报什么话）这份 ADR 的验收清单里第 5 条已经写了要求，但没定数。

## S2/S3 落了（第一百一十八刀）：一遍 `expandTemplates`，按签名单态化

一遍，`lower.js` 里 `expandTemplates` 及其六个助手，加起来 160 行左右。两件事：

- **A**：名字是 `tinst` 的 `type-decl` 摘出名单记进 `this.templates`（`{full, ns, params, agg}`）。
  摘出去意味着它们**不进 typeName 那一遍** —— 泛型声明本身不产出类型，这正是"排在 typeName
  之前"那个位置要的效果。
- **B**：工作队列扫剩下的名单找 `tinst` **用点**。每格用点：解出全名（`resolve` 只认
  `templates` 里那些）→ 按实参签名拼实例名（`Box$int`、`stdt$Array$int`）→ 名字那一格换成
  一格普通的 `(name …)` → 没造过就 `tmplSubst` 抄一份体、把 `(name T)` 换成实参那格 type-spec、
  合成一格 `type-decl` **追加**回名单。追加在 `i` 后面，所以 `for (let i = 0; i < out.length; i++)`
  自然跑到不动点：嵌套（`Pair<K,V>` 体里那格 `Box<K> m_bk`）就是靠这一步解开的 ——
  先替换成 `Box<int>`，再由队列把它也实例化出来。

**两处只有做了才知道的坑**，都记在这儿：

1. **合成出来的那一格得自己补一次 `aggHoist`。** 手写的 `struct` / `class` 是在 `run()` 最
   开头那一遍（`nsFlat` → `aggHoist`）把体里的方法提到顶层的，而这一格是那一遍**之后**才有的。
   少这一句，体里的 `T get_v()` 就没人认领，报出来是"没有这个函数：'b.get_v'" —— 第二个探针
   （`/tmp/g2.jnc`，两个类型参数 + 体里带方法 + 同一格泛型两套实参 + 类那一侧）钉住的就是这一条。
2. **一格也没换的时候要回原来那颗节点。** 这不是省事：类体里那格 `reactor` / `fn-def` 与被
   `aggHoist` 提到顶层的那一格是**同一个对象**，`reactorBody` 那一遍靠这条身份认领它
   （第八十二刀）。无条件抄一份会把身份切断 —— `82-reactor` 当场变成"reactor 'Inl.m_r'
   声明了两次"。这一遍扫的是**每一个**文件，所以这一句护着的是所有**不带泛型**的写法；
   也就是说"AST 是纯的、抄一份是完整替换"那条结论只对**值**成立，对**身份**不成立。
   这一条是这一刀最值钱的一句话。

界（`bad/` 三格）：实参带 `*`（`generic-ptrarg`）、实参本身是一格实例化
（`generic-instarg`）、实参个数对不上（`generic-arity`，这一格是**真错**不是"还不收"）。
前两格是上面"替换只在 type-spec 那一层"那条判据的两个直接推论。第二格原先会掉到 `tmplKey`
那儿回 `null`、最后由下游报成含糊的"这种类型说明符"，所以补了一句明说的话 ——
不明说的边界等于没有边界。

### 账：pairs **7556 → 7572（+16）**，而 lowered / clean 一个没动（83 / 151）

数字朝**坏**的方向走了 16，照实记。逐份量了那 10 份声明泛型的文件（`/tmp/gm.mjs`），
+16 全在这 10 份里（前 39 → 后 55），一格不多一格不少：

- `stdt_Array` 4→5、`BinTree` 5→10、`BoxList` 5→5、`HashTable` 1→1、`Iterator` 2→2、
  `List` 5→5、`Map` 5→7、`Operator` **2→1**、`RbTree` 5→11、`test157` 5→8。
- **原先那道死墙没了**：`认不出的结构体名字` / `认不出的类名字`（S1 之前泛型类头撞的那两条 E）
  在这 10 份里**一条不剩**。`Operator` 就此少了一条，是这一轮唯一一格净降。
- 涨出来的全是**走到后面才碰上的**：`泛型参数的默认类型`（3 份，与先前量到的"3 格带默认值"
  对得上）、`泛型的实参本身是一格实例化`、以及各文件自己后半截真正的拦路项。

这与第一百一十七刀那一节记下的"早早一格硬 E 会把下游的 N 全挡住"是**同一条口径的反面**：
把墙推倒，被挡住的账就一次全冒出来。所以 pairs 这一栏在"拆墙"型的刀上天生朝上走 ——
判一刀的好坏要看 lowered / clean 与**具体哪几条理由消失了**，不能只看 pairs 的正负号。
这一轮 lowered / clean 没动，是因为这 10 份文件后面还各自压着好几条别的账（`RbTree` 后面
还剩 11 条），一刀推不到零。

### 还剩的（S4 / S5）

- 默认类型参数（`struct Iterator<T, Base = void>`）—— 3 份，量到的最大一格。
- 实参本身是一格实例化 —— 拼名字那条规则得连着定（`Iterator$Node_int` 这种）。
- 实参带 `*`；参数当基类；非类型参数；函数模板的实参推导。
- S4：报错落到**实例化那一处的实参**上（今天报在合成出来的体里，行列指的是泛型声明那一处）。

## S5 的第一格落了（第一百一十九刀）：实参本身是一格实例化 + 递归的闸门

`tinstOne` 碰上实参是一格 `tinst` 时**先解里层**（递归调自己，`depth + 1`），拿里层的实例名
造一格普通的 `(name Node$int_char)` 替进去 —— 外层的名字于是自然拼成
`Iter$Node_int_char`（里层名字里的 `$` 换 `_`，与命名空间那一层的分隔区分开）。判据一个字没改：
替换仍然只在 **type-spec 那一层**，只是"那一格 spec"现在可以是**先造出来的一格实例**。

**闸门 `TMPL_DEPTH = 8`。** 这一格不是保险丝，是**必需**的：`struct L<T> { L<L<T> >* m_next; }`
每实例化一层实参就长一圈，名字每次都是新的 —— "同一份实参不重复造"那条 memoise 拦不住它。
`depth` 跟着两条路一起长：实参里的里层（`depth + 1`），以及合成出来那一格体里的用点
（队列条目上记的 `tdepth`）。语料里量到的最深是 3 层，8 是它的两倍多。界在 `bad/generic-deep`，
停在一句说得清的话上。

**顺手修掉一处重报**：合成出来的那一格是 `tinstOne` 里就地扫完的，队列**又扫了一遍** ——
里头没解开的诊断于是报两遍（`bad/generic-deep` 一开始就印了两条一样的）。加一格 `done`
标记，队列跳过。这一条是上一刀留下的，账记在这儿。

`bad/generic-instarg` 那份界随这一刀**删了**，写法搬进 `cases/111-genericnest`
（与第一百一十七刀删 `bad/fnptr-field` 同一条纪律）。尺子 `/tmp/c117.c`。

### 账：pairs **7572 → 7573（+1）**，lowered / clean 还是 83 / 151

`泛型的实参本身是一格实例化` 这一行**整行没了**；顶上来的是下一格边界
`泛型的实参带 `*``。逐份看那 10 份：只有 `BoxList` 涨了 1（5→6），别的一格没动 ——
也就是说语料里那些嵌套实例化，**里层几乎都带 `*`**（`Array<Bucket*>`、
`Iterator<Node<int>*>` 那种），解开外层之后立刻撞在指针这一格上。

所以下一刀的题目就此定了：**实参带 `*`**。它现在是这一族里唯一还挡着的形状 ——
而路子已经看得见：给那一格指针类型**起个名字**（合成一格 `typedef`），替换仍然只在
type-spec 那一层。

## S5 的第二格落了（第一百二十刀）：实参带 `*` —— 给那一格指针**起个名字**

判据一个字没改，做法是**绕开而不是破例**：带 `*` 的实参先合成一格
`typedef Bucket* jnc$tp$Bucket_p;` 追进名单，再拿这个名字当一格普通 type-spec 替进去。
实例名于是是 `Box$Bucket_p`（每颗星记一个 `_p`）。

三句话值得记：

- **"给类型起名字"在语言里本来就是 typedef 那一格**，一个新机制都不用造。合成的那一条由
  `run()` 里 typedef 那一遍照常收 —— 它排在 typeName 之后、typeDecl 之前，正好赶上：
  别名可以引结构体的名字（第三十八刀那条顺序），而实例的体又在它之后才解。
  **这是第一百一十八刀"插一遍要回头问前面几遍欠不欠它"的反面**：这一次是插进去的东西
  刚好落在既有那一遍的射程里，什么都不用补。
- 形状照解析出来的那一份抄：`(typedef (specs …) (dcls (dcl (ptrs…) (name …) (suffixes) (no-ctor))))`。
  `specs` 上那两格修饰符表直接借实参那一处的（`tmplSpec` 已经查过是空的），`ptrs` 整颗
  搬过来 —— 两颗星（`Box<Bucket**>`）于是不用另写一条路。
- 两颗星那一格顺手量到一格**与泛型无关的旧洞**：`(*pp).m_n` 在不带泛型的写法上也报
  "'->' 的目标不是结构体：B*"（`/tmp/g8.jnc` 单独验过）。界里绕开它（先接到一格局部量上），
  账记在这儿 —— 不是这一刀的活，但也别让它冒充是泛型的毛病。

`bad/generic-ptrarg` 随这一刀删了，写法搬进 `cases/112-genericptr`。尺子 `/tmp/c118.c`。

### 账：pairs **7573 → 7586（+13）**，lowered / clean 还是 83 / 151

又是"拆墙"那条曲线，而且这一趟看得更清：+13 仍然**全在那 10 份**里（56 → 69），
`泛型的实参带 `*`` 整行没了，顶上来的是下一格 —— `泛型的实参上带修饰符`
（`Array<char const*>` 那种）与 `限定名或特殊名的声明符`。

连着三刀（118 / 119 / 120）都是同一条形状：**推倒一层墙，下一层立刻顶上来，pairs 每次都涨。**
这一族的账要这么读才对 —— 看的是"哪一行整行消失了"，不是 pairs 的正负号。三刀之后
`stdt` 那九份文件已经从"撞在类头上一步走不动"变成"能走到各自后半截的真问题上"
（`RbTree` 现在剩 13 条，其中最靠前的是默认类型参数）。

## S5 的第三格落了（第一百二十一刀）：实参上带修饰符 —— **第一次净降**

语料里就两处，都在 `stdt` 里（`IteratorBase<T const*>`，stdt_Iterator.jnc:79；
`MapIteratorBase<T.Value, T const*>`，stdt_Map.jnc:57）—— 正好是上一刀落地之后顶上来的那一行。

做法与上一刀同一条（起名字那一格 typedef，修饰符跟着 `specs` 整格搬进去），只多一句要紧的：
**修饰符要记进实例名**。`Box<int const*>` 与 `Box<int*>` 不是同一个类型，名字不分开就是
静默的错答案。三种形状都收了：带星带修饰符、只带星、只带修饰符（`Box<char const>`）。

**照实记一条（这一刀最该写下来的）**：这一层的方言**根本不管 `const`** ——
`int const* p; *p = 9;` 照样跑（`/tmp/gb.jnc` 单独验过，不带泛型也一样）。所以这一刀收下的
是那个**形状**，`const` 那个词在这一层没有意义。把它记进名字仍然是对的：哪天 const 长出
意义来，这两格本来就已经是两个类型 —— 反过来（今天不记名字、以后再拆）就是一次静默的语义变更。

### 账：pairs **7586 → 7580（−6）**，这一族**第一次往下走**

lowered / clean 还是 83 / 151。逐份看：`BinTree` 12→11、`BoxList` 7→6、`Iterator` 6→5、
`List` 7→6、`Map` 9→8、`RbTree` 13→12 —— 六份各降一条，正好 −6，别的一格没动。
`泛型的实参上带修饰符` 整行没了，而这一次**没有新的一行顶上来**：那两处 `T const*` 后面
接着的账，与文件里已经在册的那几条是同一条（`默认类型参数` / `限定名或特殊名的声明符` /
`这种类型说明符`），所以只减不加。

四刀（118–121）之后这一族的曲线：+16 / +1 / +13 / **−6**。前三刀在拆墙（每拆一层，
被挡住的账一次冒出来），第四刀开始**真的在填**。

### 还剩的（下一刀的题目已经明确）

- `限定名或特殊名的声明符`、`这种类型说明符` —— 得逐处看，未必是泛型这一族的。
- 参数当基类；非类型参数；函数模板的实参推导；S4（报错落到实例化那一处的实参上）。

## S5 的第四格落了（第一百二十二刀）：默认类型参数 —— 账**一格没动**

语料里两处，都在 `stdt` 里：`class HashTable<K, V, H, E = Eq<K> >`（stdt_HashTable.jnc:46）、
`class RbTree<K, V, C = stdt.Lt<K> >`（stdt_RbTree.jnc:51）。两处的默认值本身都是一格
**实例化**、而且引的是**前面那一格参数** —— 所以这一格非得等第一百一十九刀先落地才做得动。
这一条顺序是量出来的，不是猜的。

做法：给的实参不够时拿声明处那几格默认 `targ` 补上，补的时候用**已经绑定的**那几格替换、
map 边填边长（后一格默认值可以引前一格），补出来的那一格走 `tinstArg` 那条共用路
（tinst / `*` / 修饰符三支都用得上）。顺手把那三支从 `tinstOne` 里**抽成一个函数** ——
默认值那一格与写出来的实参必须走同一条路，抽出来是唯一能保证这件事的写法。

钉住的一条：`H<int>` 与 `H<int, Eq<int> >` 补完是**同一格实例**。界里用一个形参写
`H<int>*` 的函数收按第二种写法造出来的值 —— 两者要是两个类型，那一句当场不收。

界 `bad/generic-defmid`：带默认值的那几格必须**排在后面**（不然"给了 2 个实参"落在哪几格上
没有唯一答案）。这一条是**真错**，不是"还不收"。

### 账：pairs **7580 → 7580（没动）**，lowered / clean 还是 83 / 151

这一趟是四刀里最"平"的一次，而且平得有意思：`泛型参数的默认类型` 那一行**整行没了**
（原先 5 份在册），可那 5 份文件的拦路项**条数一格没变** —— `BinTree` 11、`BoxList` 6、
`Iterator` 5、`List` 6、`Map` 8、`RbTree` 12，与上一趟逐格相同。换掉的是**内容**：
`未声明的变量` 从 301 涨到 304，也就是那几份文件把默认参数那一步走过去之后，立刻踩在
下一条上，一换一。

这就是"pairs 这一栏读不出好坏"最干净的一个例子：**同一个数字，底下的账已经换了一层**。
四刀之后 `stdt` 那一族剩下的两条大项（`限定名或特殊名的声明符` / `这种类型说明符`）
已经**不是泛型这一族的了** —— 下一刀得先逐处看那两条到底是什么，再定题目。

五刀（118–122）的曲线：+16 / +1 / +13 / −6 / 0。

## S5 的第五格落了（第一百二十三刀）：泛型的 **typedef** —— 第一份文件**整份降下来了**

语料里 10 处，三份文件（stdt_Iterator 4、stdt_Map 4、stdt_BoxList 2），全是同一个用法：
"给一长串实例化起个短名字"——

```
typedef IteratorImpl<IteratorBase<T*>, IteratorBase<T*> > Iterator<T>;   （stdt_Iterator.jnc:72）
```

记账与泛型的**类**是同一套（`templates` 那张表、按签名 memoise、工作队列跑到不动点）；
只有实例化那一步不同：合成出来的是**一条 typedef**，没有体、也不用 aggHoist。名字那一格换成
实例名，`specs` / `ptrs` / `suffixes` 替换完照抄 —— `specs` 里那一串 `Impl<int,int>` 由
`tinstRewrite` 接着解，所以"泛型 typedef 指向另一格泛型 typedef"（`AutoConstIterator<T>`
那个形状）是自然跑通的，一个字都没为它写。

排在哪一遍也不用另想：合成的这一条落进名单之后，`run()` 里 typedef 那一遍照常收它 ——
与第一百二十刀那格"给指针起名字"的 typedef 同一个位置。**同一个位置连着接住了两刀合成出来的
东西**，这是"排班排对了"的证据。

界 `bad/generic-tdefmix`：一条 `typedef` 里既有泛型的名字又有别的名字（`Pair<T>, Plain`）——
前一格要按签名单态化、后一格就此坐下，"那个 `T` 归谁"没有唯一答案。语料里 10 处全是一条
一个名字，这条界不挡任何真写法。

### 账：lowered **83 → 84**、clean **151 → 154**、pairs **7580 → 7563（−17）**

**`stdt_Iterator.jnc` 整份降下来了**（5 条 → **0**）—— 这一族六刀以来第一次有语料文件走到零。
逐份：`BoxList` 6→2、`List` 6→2、`Map` 8→5、`test157` 8→7，`BinTree` / `RbTree` / `Operator` /
`Array` / `HashTable` 没动。

为什么这一刀的收成比前几刀大得多：前五刀拆的是**一格一格的形状**，而这一刀拆的是
`stdt` 那一族**互相引用的那张网**上的一个结 —— `Iterator<T>` 这个短名字是别的文件引进来用的
入口，它一通，跟着它的那几条也就通了。判一刀的量级要看它在依赖图上的**位置**，不只看
它挡住几处写法。

### 还剩的

- `stdt_Operator.jnc` 只剩一条：`static size_t operator () (string_t key)` —— **运算符重载**，
  不是泛型这一族的。
- `BinTree` / `RbTree` 各剩 11 / 12 条，最靠前的是 `结构体里除字段以外的成员`
  （`typedef P EntryPtr;` 写在结构体里）与 `这种类型说明符`。
- 参数当基类；非类型参数；函数模板的实参推导；S4（报错落到实例化那一处的实参上）。

## 一条**口径**：实例名不是一层层的命名空间（第一百三十二刀）

前五刀在这一栏里立下的名字规矩是"实例名 = `模板名$实参键`"（`Box$int`、`stdt$Array$int`），
而实例的体是拿 `this.ns = 实例名` 降的 —— 成员 typedef（`typedef P Entry;` 写在体里）要在那一层
查得着。这两句放在一起有一个当时没看见的后果：

`resolve` 往外退一层是**按 `$` 掐**的（那是命名空间的规矩）。于是在 `Box$Node` 的体里写 `Node`，
第一次探 `Box$Node$Node`（没有），第二次退成 `Box`、探 `Box$Node` —— **实例它自己**。而 typeSpec
里结构体表排在 typedef 表前面，这一撞每次都赢。

结果是**静默的错答案**，最小的样子只要三行：

```jnc
struct Node { int m_x; }
struct Box<P> { P* m_p; }
Box<Node> b;    // m_p 落成 `Box$Node*`，不是 `Node*`
```

改法是给"往外退"这一步加一格例外：`instNs`（实例名 -> 那个泛型**声明处**的那一层），退的时候
先问它、整块跳过去。实例自己那一层照旧先查。

要记下来的口径是这一句：**这一栏往名字里塞 `$` 的每一处，都要回头看一遍"谁把 `$` 当分隔符"**。
第一百二十刀那个"给类型起个名字"的 typedef（别名照用户写的拼，`T*`）也是往名字里塞东西的一处
—— 它让这一撞在 std 那一批上落成了"字段按值套回了自己"，一句指着别处的话（见 ADR-0016
第一百三十一/一百三十二刀）。

### 下一格已经量出来了：**未绑定的参数漏出去**

`--group std` 那张榜的榜首是 `没有这个类型`（134 处），里头约 90 处是**泛型参数自己的名字**：
`T` 40、`T*` 18、`I` 14、`T const*` 8、`T.Value` 4。也就是说这一层在某些路上把
`IteratorBase<T*>` 这种"实参里带着外层还没绑定的参数"的实例化**照字面做了**，而 jancy 那边它是
"晚一点再绑"。这一格是这一栏剩下的最大一块，做之前要先量清楚"是哪几条路把 `T` 漏出去的"——
猜出来的因写进账里是要回头改的（第一百三十一刀刚犯过一次）。

> 量清楚了：**就一条路**，而且与"晚一点再绑"没关系 —— 是**成员写在体外**那一种
> （`T Box<T>.fetch() { … }`）从来没人管，原样留在名单里按字面降。第一百三十五刀收了，
> 见下一节。

## S5 的第六格落了（第一百三十五刀）：成员**写在体外** —— 这一栏最大的一格

jancy 里"体内写"与"体外写"是同一件事、任选其一（type_class.rst:41-59）。这一栏先前只办了体内
那一半：`aggHoist` 把体里的成员跟着实例提出来，而体外那些条目谁也没管。

两小段：`expandTemplates` 的 A 遍之后加一遍 A2（`tmplOuter` 认它：声明符核心一层层往左剥到底，
最左那一格是 `tinst`）把这样的条目摘出来记在 `templates.get(full).outer`；`tinstOne` 末尾
（紧挨着 `aggHoist` 那一句）把每一条 `tmplSubst` 一份再 `tinstRewrite` —— 声明符里那格
`(tinst Box (targ T))` 的 `T` 一起被换掉，于是它自然解成**当前这格实例名**，名字落成
`Box$int$fetch`，与体内那一批一模一样。

### 账：lowered **88 → 91**、pairs **7465 → 7419（−46）**、`--group std` **353 → 151（−202）**

`没有这个类型` 那 134 处**整行没了**，理由数 33 → 20（一趟少 13 行）。std 那一批剩下的榜首换成了
`原型 '…' 没有带体的定义`（70）—— 宿主面，不是这一层的墙。

第一百二十三刀那句话再验一次：**判一刀的量级要看它在依赖图上的位置**。这一格是 `stdt` 那一族
每一份都要走的一步。

### 还剩的（量过了）

- **查名不走基类那一层**：`construct(EntryPtr p)` 写在 `struct IteratorImpl<B, M>: B` 里，而
  `EntryPtr` 是基类 `IteratorBase<P>` 的成员 typedef（stdt_Iterator.jnc:20/62）。这一条**与泛型
  无关**（非泛型代码同样撞：`class B0 { typedef int X; } class D0: B0 { X m_v; }`），可它在
  `--group std` 上**量不出收益**（单独开它 357 → 357、理由反而 +1）—— 语料里没有一个真被
  实例化到那一步的泛型。先记着，等量得出来再落。
- 体外写的方法名叫 `get` / `set` 时被 `accessorNamed` 读成属性取值器（`int C0.get()` 报
  "没有这个属性：'C0'"）。也与泛型无关，判据是"这个类里有没有一格同名属性"。
  > 第一百三十六刀收了（ADR-0016 那一节）。
- 非类型参数；函数模板的实参推导；S4（报错落到实例化那一处的实参上）。

### 划掉一句记错了的账：**参数当基类**其实已经收了

这一栏的"还剩的"里从第一百一十八刀起一直挂着"参数当基类"。第一百三十七刀之后回头量，
两种写法都跑得通（`129-baseparam`）：

```jnc
struct ImplS<B>: B { Entry val() { return m_v; } }   // Entry 是基类的成员 typedef
class  ImplC<B>: B { Entry val() { return m_v; } }
```

为什么它早就通了：基类那一格写的是参数，`tmplSubst` 把它换成实参那格类型说明符，剩下的与手写
基类**同一条路**（结构体那一侧是第一百二十五刀的纯前缀布局，类那一侧是第五十二刀那条链）——
这一格从来不需要单独一刀。真正欠着的是**基类里的成员 typedef 查不着**（`Entry`），
而那是第一百三十七刀办的事。也就是说这一栏把两件事记成了一件，且记在了错的那一件上。

记账的规矩是"欠着的要写下来"；同一条规矩管反面：**收了的要划掉**。一条挂着不动的欠账会让
下一趟的选题算错量级 —— 这一条挂了 19 刀。