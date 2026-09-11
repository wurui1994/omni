# ADR-0026：string 落进内存 —— 16 字节的按值聚合，不是句柄

- 状态：已落（S1 + S2）
- 关联：ADR-0024（引用语义的句柄能当字段）、ADR-0016 第十六刀（fat 指针落进内存）、
  ADR-0016 第一百〇四刀之后那两节（variant_t 的墙）、任务 #38 / #35 / #39

## 背景：这一格是量 variant_t 时撞出来的

jancy 前端量到 `variant_t` 是整份语料里最大的一个名字（131 份文件 / 999 处诊断，
`没有这个类型` 那 347 对里唯一有 sole 的一格）。它在语料里压倒性的用法是**转手**：

```jancy
variant_t in, variant_t* out                  // 84 份 ioninja 插件的 dispatch
*out = m_remoteAddressCombo.m_currentText;    // 装箱：一格 string
```

原本的落法是"前端自己造一格 `{ tag, payload }` 的结构体，不动方言"。**当场撞墙**：

```
struct V { int m_tag; int64_t m_n; string_t m_s; }
-> 结构体 'V' 里有落不进内存的字段，指不到它身上（见 hir/types.js 的 structLayout）
```

换成 `class V` 一字不差地报同一句。根在 `hir/types.js` 的 `sizeOf`：`t.k === 'string'` 没有
分支、落到最后 `return 0`，于是 `structLayout` 把整格结构体判成"落不了地"。

**一条要更正的判据**：撞墙的当天我把这一格写成"ADR-0024（句柄当字段）那条模板的下一格
应用"。量下来**不是**。`arr` 那条路走得通的前提是它在两条原生腿上本来就是**一个字的指针**
（`omni.h:324-327` 的 `typedef struct omni_arr_i64_s *`、`backend-llvm/emit.js:58` 的
  `[T_ARR,'ptr']`），所以 `sizeOf` 从 0 改成 8 之后 C / LLVM / MIR 三条腿一个字都没改
（ADR-0024:99-106）。string 不满足这个前提。

## 量出来的事实：string 在五处各是什么

```
MIR                T_STR = 4，胖值（native 腿上退化成一个 i64 地址）
C                  omni_str {const char* p; int64_t len;}  = 16 字节按值聚合（omni.h:33-34）
LLVM               [2 x i64]                                = 16 字节（emit.js:49）
JS                 宿主原生 String（不进 arena，也没有 id 表）
interp / --mir     同上（共用 interp/builtin.js）
```

对照 `arr`：四条腿都是**一个字**。所以 string 落的不是"句柄"那一格，是**第十六刀 fat 指针
那一格**（多个字的值）—— 也就是 jnc 前端那句诊断自己写着的"与 `&p` 同一格"
（`frontend-jnc/lower.js` 里 `string 的数组` 那一条）。那句话当初就量对了。

**还有一条**：string 当"值结构体的字段"**今天就是收的** —— `sexpr/lower.js` 的字段白名单里
`STRING` 在列，`tests/sexpr/cases/06-structs.sx:6` 的 `(struct Tag (name string) …)` 与
`09-arrfields.sx:10` 的 `(struct Bag (xs (arr int)) (tag string))` 都在跑。卡住的**只有内存
那条路**。而 jnc 这一层的类与结构体局部量一律走 `(pnew (ptr V) …)`，所以它每次都要那条路。

## 尺子上的账：**一格都没动**，而且这是对的

跑完之后 jancy 语料那把尺子三个数一格没动（`77 / 169 / 7731`，逐行差也是 0）。原因量清了：
榜上**从来没有**"string 字段落不进内存"这一行 —— 语料里那些带 string 字段的文件在更早的地方
就倒了（`variant_t`、宿主面、`import` 不着），压根走不到布局那一步。所以这一刀的价值是
**补齐了一格能力**（jnc 那边 `struct Item { string_t m_name; … }` 现在通了，
`cases/101-strfield.jnc`），不是"降了多少对"。

**一条要更正的数**：开这一刀时我写着"顺带解掉榜上 `string 的数组` 那 90 对"。**记错了** ——
榜上 `string 的数组` 是 **14 对**；那个 90 是另一行（`类型是函数指针（void function*()）的字段`，
任务 #39）。两行都带着同一句"要方言能把多个字的值当元素搬（与 &p 同一格）"，我按那句话把两行
混成了一行。数组那一族按元素类型分行，加起来 146 对（`ui.Action*` 42、`ui.Icon*` 40、
`ui.StatusPane*` 34、`string` 14、`ui.InformationValue*` 10 …）——**而且它们没有因为这一刀
好转**：数组的元素比字段多一条"能不能整格搬"，那是下一格，要另量。

## 决定

**`sizeOf(string) = 16`、`alignOf(string) = 8`。**

尺寸由汇聚层定死（`hir/types.js` 那段注释：一套语义两套实现，尺寸与偏移不能各条腿自己算），
所以这个 16 不是"C 那边碰巧是 16"，是**规定**：

- **C / LLVM 一个字都不用改** —— 它们本来就按 16 字节按值搬（`omni_str` / `[2 x i64]`），
  `PLOAD`/`PSTORE` 是按类型泛型发的（`backend-c/emit.js` 的 `cTypeName` 强转、
  `backend-llvm/emit.js` 的 `load [2 x i64]`），`omni_pchk(p, N)` 的 N 也是从这一层的 sizeOf
  来的，所以范围检查跟着就对；
- **JS 那一族**（`run` / `interp` / `interp --mir`）arena 是一块 ArrayBuffer、JS 字符串塞不
  进去，所以那 16 字节里放**句柄 id（第 0 个字）+ UTF-8 字节长度（第 1 个字）**。
  第二个字与 C 那边的 `len` 对上；这条腿不读它，但写上 —— 免得那 8 字节是垃圾。

**与 ADR-0024 差的那一格：id 0 是空串、不是错。** `arr` 那边 id 0 报 `null reference`
（空句柄）；string 的**零值就是空串**（`backend-js/emit.js` 的零值、`mir/interp.js` 的
`zeroOfCode` 都是空串），而 `pnew` 出来的内存是零 —— 所以"没写过的 string 字段"读出来是 `""`。
这一条写在四处代码的注释里，也是 `cases/40-string-field.sx` 的判据 3。

## 改了哪几处（清单）

| # | 文件 | 改的内容 |
|---|---|---|
| 1 | `src/core/hir/types.js` | `alignOf`：string -> 8；`sizeOf`：string -> **16**（+ 两段理由） |
| 2 | `src/core/interp/builtin.js` | `ptrLoad` / `ptrStore` 各加一支 `string`（id + 字节长度；id 0 = 空串） |
| 3 | `src/core/backend-js/prelude.js` | `$pload_s` / `$pstore_s`（与 2 同算法的文本版，字节长度走现成的 `$slen`） |
| 4 | `src/core/backend-js/emit.js` | `jsPtrLoad` / `jsPtrStore` 各加一支 |
| 5 | `src/core/mir/interp.js` | `memKind`：`T_STR -> 'string'` |
| 6 | `tests/sexpr/cases/40-string-field.sx` | 五条判据的本体 |

**C 后端 0 处、LLVM 后端 0 处、MIR ir.js 0 处、sexpr/lower.js 0 处** —— 与 ADR-0024 那张
清单同一个形状。第 3、4、5 处正是 ADR-0024:108-118 记过的那个陷阱（三元链 / if 链的最后一格
是 bool，漏一支就被默默当 bool 读写）。**这一刀第一次实测到了那个症状**：只改第 1 处之后，
C 与 LLVM 立刻答对（`hi` / `yo` / `[]`），而 JS 那一族答的是 `true` / `true` / `[false]` ——
一句红都没有。那张陷阱清单是准的。

## 验收

- `tests/sexpr/cases/40-string-field.sx`：**五条腿逐字节相同**
  （`OMNI_LEGS=all node tests/sexpr/run.js` -> **86/0**）。五条判据：存取、
  **值语义**（拷一份之后改一份、另一份不动 —— 与 ADR-0024 判据 2 正好相反，string 不可变，
  "共用底下那块字节"观察不到）、没写过的那一格读出来是空串、两条 string 各自独立、
  非 ASCII 原样进出且 `slen` 数的是**字节**（`中文 ok` = 9）。
- 改的是汇聚层，所以按 ADR-0023 那条规矩跑了 `node tests/all.js`（结果见提交信息）。

## 代价与不做的

- **那张句柄表只涨不缩**（与 ADR-0024 同一笔账，任务 #13）。string 比 arr 更容易涨：
  每存一次非空串就多一格 id，哪怕存的是同一个串。**没有 interning** —— 要治就是"按串内容
  查一次表"，那是另一刀（也要先量：语料里 string 字段的写入频度）。
- **`(ptr string)` 没放开**（`ptrTargetOk` 一个字没动）。那是"指向一格 string 自己"，与
  "string 当字段"是两件事 —— 与 ADR-0024 不放开 `(ptr (arr T))` 同一条理由。
- **不**给 `buf` / `fn` / `class` 一起放开。`fn` 那一格榜上已经有 170 对在等（任务 #39），
  可它是几个字还没量 —— 一次只放一格，判据才说得清。
- 第二个字（字节长度）在 JS 那一族里**写了但不读**。哪天要 `(psub p q)` 之类的字节级操作
  真去读它，得先确认它在每一条写入路径上都是对的（现在只有 `$pstore_s` / `ptrStore` 写它）。

