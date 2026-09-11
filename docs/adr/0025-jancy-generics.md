# ADR-0025：jancy 的泛型（模板）——要不要按实例单态化

- 状态：**只量墙，一格没落**
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

所以这一格的账面是 **12 + 4 = 16 份文件**，而「真降得下来」这个数字已经在 61 停了三刀。
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

## 落法（建议的分步，一格都还没落）

- **S1 语法**：类/结构体头上的 `<T…>`（带默认类型），与类型位置上的 `名字<实参…>`。
  验收是 `tests/glr` 的 jnc 表快照：**冲突数不许涨**，涨了就说明 `(prefer …)` 那一格没摆对。
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

## 判据

1. `tests/glr` 的 jnc 表：**冲突数不涨**；
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
