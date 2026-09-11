# ADR-0027：结构体里的匿名 union —— 布局那一层长出"共用偏移"

- 状态：已落
- 关联：ADR-0024（引用语义的句柄能当字段）、ADR-0026（string 落进内存）、
  ADR-0016 第十八 / 二十二刀（定长内存 `(blk T N)`）、任务 #41

## 背景：jancy 那些协议头要它

榜上 `结构体里的嵌套类型` 17 份 / 37 处 / sole 3，按真话拆开**只有一种源头** ——
结构体里的匿名 `union { … }`：

```jancy
struct DeviceMonitorNotifyHdr {
    …
    union {
        uint32_t m_pid;
        uint32_t m_processId;
    }
}
```
（`src/jnc_ext/jnc_io_devmon/jnc/io_DeviceMonitorNotify.jnc:59`、
`io_win_DeviceMonitorNotify.jnc:49/85/92/105` 那一族）

union 的语义是"几格字段**共用同一个偏移**"，而这一层的布局一直是"自然对齐、按声明顺序、
一格一格往后排"。前端合成不出来（没法让两格字段的 off 相等），所以这是**布局那一层**的账。

## 落之前量到的那条事实（它决定了这一刀有多便宜）

**四条腿的字段访问都是按字节偏移**：

- C：`backend-c/emit.js` 的 `case 'PtrField': … omni_padd(p, off, 1)`；
- JS：`backend-js/emit.js` 同形的 `$padd(p, off, 1)`；
- 而 C 那边发出来的结构体声明，注释里早就写着："那个 C 结构体只是那段内存的**值**表示，
  而 arena 那一侧是字节 + 偏移，**根本不经过它。要紧的只有尺寸与对齐**。"

所以只要 `structLayout` 给那几格成员**同一个偏移**，指针那一侧就是白得的。**实测**：只改
`hir/types.js` 与语法这两处之后，探针（写 `a` 读 `b`、再写 `b` 读 `a`）在 **run-llvm /
interp / interp --mir 三条腿上一次就对**；剩下两条腿报的是宿主崩（`zero: union` /
`cTypeName: union`），也就是**值那一侧**还没接。

## 决定

1. **布局**：`sizeOf(union) = 最大成员的尺寸`、`alignOf(union) = 最大成员的对齐`（与 C 的 union
   同一条）；`structLayout` 把成员**摊进那张平表**、偏移都等于这一格 union 自己的偏移。
   union 自己在平表里没有一格 —— 它不是一个值，只是"这几格共用这段字节"这件事。
2. **语法**：字段位置收 `(union (名字 类型) …)`，至少两格成员。值那一侧要一格槽的名字，
   由这一层起（`$u0` / `$u1` …）—— **源码里写不出它**。
3. **界：成员只能经指针碰**。`(fld …)` / `(fldset …)` 走的是按值那条路，那张没摊开的表里没有
   成员的名字，所以照旧报错 —— 但话说清了：`'a' 是 H 里一格 union 的成员 …… 只能经指针碰`
   （`bad/union-fld.sx`）。这与 `(blk T N)` 那一格是同一个道理（那一格也观察不到）。
4. **成员的类型只收** `int` / `real` / `bool` / `(vec T N)` / 另一个结构体 —— 也就是"零值是全零位、
   没有旁表"的那几种。句柄（`arr`）与 `string` 落进内存之后旁边都还挂着一张表（ADR-0024 /
   ADR-0026），重叠之后说不清那张表上的东西是谁的。
5. **类里不收 union**（类是引用、字段在堆上那一格里，与 `(blk T N)` 在类里不收同一条）。

## 改了哪几处

| # | 文件 | 改的内容 |
|---|---|---|
| 1 | `src/core/hir/types.js` | `sizeOf` / `alignOf` 认 union；`structLayout` 把成员摊进平表、偏移相同 |
| 2 | `src/core/sexpr/lower.js` | 字段位置收 `(union …)`；`field()` 把"这是 union 的成员"说清 |
| 3 | `src/core/backend-c/emit.js` | `fieldDecl` 发一格**真** C union（尺寸对齐才对得上）；铺零走 `memset`（匿名类型写不出复合字面量，而这一格观察不到） |
| 4 | `src/core/backend-js/emit.js` | `zero` 给 union 留一格 0 —— 与 blk 那一格同一个道理 |
| 5 | `tests/sexpr/cases/41-union-field.sx` | 四条判据的本体 |
| 6 | `tests/sexpr/bad/union-fld.sx` | 界：`(fld …)` 拿不到成员 |

**LLVM 后端 0 处、两个解释器 0 处、MIR 0 处** —— 指针那一侧本来就按偏移走。
C 那两处与 JS 那一处都只是**值表示**，而值表示里这一格观察不到。

## 验收

- `tests/sexpr/cases/41-union-field.sx`：**五条腿逐字节相同**
  （`OMNI_LEGS=all node tests/sexpr/run.js` -> **87/0**）。四条判据：写一格按另一个名字读是同一块
  字节、反过来也一样、union 的尺寸是最大成员（里头一格 16 字节的结构体，写它碰不到后面那格
  `tail`）、union 之后那格字段的偏移是对的。尺子是手写的等价 C（`/tmp/c27.c`，
  `cc -O0 -std=c99 -Wall`）：`3 7 7 11` / `9 9` / `21 22 21 11`。
- 改的是汇聚层（`hir/types.js`），所以按 ADR-0023 那条规矩跑了 `node tests/all.js`。

## 代价与不做的

- **值那一侧不重叠**：`(fld …)` / `(fldset …)` 拿不到成员（当场报清）。真要"按值也重叠"，
  得在 C 与 JS 的结构体值表示里做重叠 —— 那是另一刀，而且语料里那些协议头本来就是
  "盖在缓冲上按字段读"，用不着。
- **不收**句柄 / string / 函数值当 union 的成员（旁表说不清是谁的）。
- **没有位域**：`声明符后缀 'bitfield'` 那 17 份 / 90 处是同一族的下一格，可它要的是掩码与移位、
  不只是偏移 —— 另一刀。
- jnc 前端**同一趟接上了**（第一百一十刀）：语法上 `union { … }` 是一格 agg（key 是 `union`、
  名字 `(anon)`），前端把成员**摊平**进那个结构体的字段表（所以 `hdr.m_pid` 那一处查名一个字
  都不用改）、记一格 `uni` 标记，发 `(struct …)` 时再把同一串括回成 `(union …)`（`unionGroups`）。
  判据 `tests/jnc/cases/102-union.jnc` 与这一份的 `/tmp/c27.c` 是同一把尺子。
  尺子上：`结构体里的嵌套类型` **17 → 1（−16）**，对数 7731 → 7728。新露出来一格
  `union 体里除字段以外的成员` **11 份 / 14 处 / sole 3** —— 拆开是**union 里再套一格匿名
  `struct { … }`**（`io_win_DeviceMonitorNotify.jnc:175/184` 那种 C 的老写法）。
- **那一格紧接着也落了（第一百一十一刀）**：给每一组合成一格真结构体（`<外层>$u<N>$s<M>`）当
  union 的一格成员，再把它里头每一格的名字登记进第一百〇四刀那张 `aliasPath` 表
  （`h.m_a` -> `(pfield (pfield p $s0) m_a)`）—— 于是源码里直接写 `h.m_a` 照旧解得开，
  "两组共用同一段字节"由这一份的布局给。界：嵌套只做一层；两组同名成员撞车当场报清
  （`bad/union-dup.jnc`）。判据 `cases/103-unionstruct.jnc`，尺子 `/tmp/c28.c`（**刻意用
  `int64_t`** —— 方言的整数在内存里一律 8 字节，尺子要照方言的布局写）。
  尺子上：`union 体里除字段以外的成员` **11 → 0**，对数 7728 → **7723**；涨的 7 是
  `声明符后缀 'bitfield'`（那几份走得更远，撞上位域那堵墙）。



