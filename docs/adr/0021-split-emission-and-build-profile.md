# ADR-0021：分文件发射、构建 profile，与"每一步 30 秒"

状态：进行中（P0 已落，P1 已落，P2 起）
日期：2026-09-09

## 起因

`node src/cli.js bootstrap` 一趟 558 秒，单步最慢 191 秒。而这九步印出来只有九个总数 ——
"慢在哪个文件、慢在哪个阶段"没有答案。这不是一个性能小问题，是**看不见**：
单体构建 + 没有 profile，正好是 rust / c++ 那个通病。

## 量出来的基线（2026-09-09，M 系列 MacBook Air）

| | |
|-|-|
| src/ 源码 | 6.5 MB |
| emit-js -> omni.mjs | 13.5 MB（2.1 倍） |
| emit-c -> 一个 TU | 25.8 MB / **421,394 行** / 60,772 个 `static` |
| omni 产物（-O0） | 18.8 MB（2.9 倍） |
| clang -O0 编那个 TU | 12.5 s |
| clang **-O1** 编那个 TU | **137 s** |
| 每个 TU 光 `#include "omni.h"` 的固定税 | 94 ms 墙 / 27 ms 用户 |
| node 跑 emit-c cli.js | **1.96 s** 墙 / 3.10 s 用户 |
| -O0 产物跑同一件事 | 35.6 s 墙 / 25.9 s 用户 / **峰值 RSS 1.56 GB** / 页回收 147 万 |
| -O1 产物跑同一件事 | **54.5 s 墙** / **9.6 s 用户** / 7.2 s sys |

`-O0` 产物的采样（15 秒，按栈顶，非空闲）：

```
omni_dict_string_dynamic_find  2917
omni_s16_of_utf8                676
omni_s16_to_utf8                592
omni_hash_string                547
omni_js_arr_at                  480
omni_list_dynamic_from          362
omni_dyn_as_ref                 276
omni_alloc                      262
_platform_memcmp                252
```

## 三个互不相干的结论

**一，`-O1` 不是解药，是陷阱。** 用户 CPU 降了 2.7 倍（25.9 -> 9.6 s），墙上时间反而**更慢**
（35.6 -> 54.5 s）—— 因为一半以上的墙上时间根本不是 CPU：峰值 1.56 GB、147 万次页回收。
arena 从不释放。同一个 bootstrap 步骤在不同轮次量出 46 / 58 / 104 / 117 秒，那是内存压力的
噪声，不是编译器的噪声。而 `-O1` 让 clang 从 12.5 s 变成 137 s。所以"提高优化档"在单体
构建上两头都亏。`backend-c/emit.js` 里那句"不许开 -O2，那会盖住性能问题"方向是对的 ——
先开档会把下面那两条藏起来。

**二，一半以上的 CPU 花在把属性名变成键。** `find` + `s16_of_utf8` + `s16_to_utf8` +
`hash_string` + `memcmp` ≈ 5000 / 9500 样本。每次 `o.kind` 都重新做一遍 UTF-16 -> UTF-8
转换、arena 分配、FNV 全串哈希、memcmp。这与"有没有 JIT"无关，是可以就地修的。

**三，产出分布是平的，而共用的那一块占 29.5%。** `--stats`（P1 加的）量出来 94 个源文件，
最大的一个 5.6%（`frontend-c/tccgen.js`），另有 **29.5%（7 MB）是共用的**：字面量池、
容器实例化、成员派发器、内联进去的运行时。离群点也看得见了：`host/path.js` 用 **11 个函数**
发出 6949 行、占 4.3%。

## 计划（每一格都能独立落地与独立验收）

- **P0 可观测**（已落）。`-v` 每行在峰值内存长了的时候印它；`--stats` 印按源文件的产出分布；
  运行时那 20 个 .o 并行编（1237 -> 372 ms）。为此加了一格宿主 ABI `js_max_rss` ——
  单位在**宿主那一侧**归一成字节（node 的 maxRSS 是 KB，C 的 `ru_maxrss` 在 macOS 上是
  字节、Linux 上是 KB）。
- **P1 模块来源**（已落）。OIR 的 func 带上"定义在哪个源文件"。这一格其实是现成的 ——
  span 里本来就挂着整个 `SourceFile`，只是从前没往下传。没有它，"按文件切"连依据都没有。
- **P2 分文件发射，改成默认**（见下，有一个架构叉路）。
- **P3 内存**。arena 按阶段边界释放 + 热路径少造 `omni_dyn`。目标峰值 < 300 MB ——
  这一条本身就能把那 20 秒非 CPU 的墙上时间去掉。**量清楚之后这一条的形状变了，见下。**

## P3 量清楚了：11 GB，不是 1.5 GB

`OMNI_MEM_DEBUG=1`（arena 自带的量口）一问就出来了：

```
omni check src/core/frontend-c/tccgen.js   arena 块 1099  、 1112 MiB   峰值 RSS 1117 MB
omni emit-c src/cli.js                     arena 块 10513、11029 MiB   峰值 RSS 1434 MB
```

**一趟 emit-c 申请了 11 GB，而峰值常驻只有 1.43 GB。** 两个数差 9.5 GB —— 那 9.5 GB 是被
系统压缩 / 换出去的，正是 147 万次页回收和 `sys 4.4s` 的来处，也是墙上 35.6s 里 CPU 只占
25.9s 的那一段。arena 永不回收，所以"申请了多少"就是这一趟碰过多少页。

6.5 MB 源码 -> 11 GB 分配，**1700 倍**。所以 P3 的靶子不是"压峰值"，是"少申请"。

沿路还排除了几个候选（都是量出来否掉的，免得再试）：

- 不是产出那一头：`check`（一个字节都不出）峰值 1.46 GB，和 `emit-c` 一样。
- 不是固定开销：`omni help` 10 MB、`check hello.js` 11 MB。
- **不是 dict 的索引表**：把 `idx` 从 int64 换成 int32（索引表总比条目数大一倍以上，看着像
  主角）——峰值 1.437 -> 1.434 GB，噪声。**也不是键的比较**：并排存一份完整哈希、探测时先比
  8 个字节再调 EQ ——35.6 -> 36.2s / 用户 25.9 -> 25.5s，噪声，而它每个 dict 还多要
  `icap*8` 字节，所以撤了。`find` 那 2917 个采样是 `-O0` 下探测循环**本身**，不是比较。

剩下的两个已知乘数（还没量到量级，但机制确定）：

- **`omni_grow` 是"新开一块、拷过去、把旧的丢掉"**（arena 那条路上它就是 `omni_alloc`）。
  于是每个容器长大一次就丢掉上一份数组，翻倍增长下来是 2 倍浪费，而 dict 有
  `keys`/`vals`/`live`/`idx` 四份。
- **一格小记录要五次分配**：AST 的每个节点、每个 token、每个 span 都是一格 dict
  （struct + keys + vals + live + idx）。JS 那侧它们是对象，这边是哈希表。

所以 P3 拆成两小步，第一步是纯度量、第二步才动结构：
- **P3a** 给 `omni_alloc` 加一格编译期可关的计数（调用次数 + 请求字节的直方图），
  把"11 GB 是几千万次多大的分配"变成一张表。不知道这个就是在猜。
- **P3b** 按那张表决定动哪一头。

### P3a 的答案（`OMNI_MEM_DEBUG=3`，一趟 `emit-c src/cli.js`）

```
omni_mem: arena 块 10513、字节 11564695701（11029.0 MiB）
omni_mem: 分配 370243792 次、请求 9596.4 MiB（平均 27.2 字节）
omni_mem:   <=16         181404834 次    49.0%
omni_mem:   <=32         143879270 次    38.9%
omni_mem:   <=64          17439716 次     4.7%
omni_mem:   <=128         25387093 次     6.9%
omni_mem:   <=256          1907528 次     0.5%
omni_mem:   <=512           147801 次     0.0%
   ...（更大的那些一共不到万分之一）
```

**3.70 亿次分配、平均 27.2 字节、88% 在 32 字节以内。** 输入 6.5 MB，也就是**每一个源码字节
摊到 57 次分配**。这一个数把前面所有现象都解释了：11 GB 被碰过的页、147 万次页回收、
以及"同一件事 node 1.96 s 而这条腿 35 s"。

而 88% 落在 <=32 字节这一档说明**主角不是 AST 节点**（一格 dict 是五次分配，其中 struct 就
六十多字节）。16 字节正好是 `omni_dyn`（tag + union）、也正好是 `omni_s16`（{p, len}）、
也正好是一个单元素 list 的 items。1.8 亿次 16 字节 + 1.4 亿次 32 字节，对应的是
**每一次调用现拼一条实参 list、每一次字符串操作现造一份视图**这一类"每个操作都要一块新内存"
的模式 —— 数量级与"这一趟做了多少次 JS 级操作"对得上，与"源码里有多少个节点"对不上。

所以 P3b 的靶子定了（按收益排）：

1. **实参 list 上栈**。定长调用点本来就有 `const omni_dyn a_[] = { … }` 这种写法
   （backend-c 的 memberDispatch 里就是），把它推广到所有静态知道实参个数的调用点 ——
   每次调用省掉 `LT_new()` + `items` 两次 arena 分配。
2. **字符串临时量**。`omni_str_fmt` / `omni_s16` 的每一份中间视图都是一次分配。
3. **`omni_grow` 的"丢掉旧的"**：翻倍增长下来每个容器 2 倍浪费 × dict 的四份数组。

这三条都不需要动 AST 的表示，也不需要第二个 arena；"给前端一格 scratch arena"于是从
第一选择降级成备选（它还得先解开"span 指着 SourceFile"这条逃逸）。

### 按归属改的第一刀（已落）与它量出来的结果

**实参 list 一律走栈。** 归属表的第一名是
`omni_list_dynamic_from < omni_js_call3 < omni_js_arr_find < omni_js_m_find < u_lexJs`，
6.4%、约 2300 万次、约 1 GB —— 回调每处理一格元素就现拼一条实参 list。

修法不是在调用点上一个个判断，而是**把责任翻过来**：让"实参 list 不逃逸"成为一条处处成立
的不变量 —— 绑形参走只读的 `js_arr_get`、rest 走拷一份的 `js_arr_slice`，而唯一会把它当值
留住的 `arguments` 自己拷一份（`lower.js` 那一句）。于是 `omni_js_call3` 与生成代码里的
直接调用都能把那条 list 放在栈上。（规范里非严格函数的 `arguments` 与形参联动，这个值域
本来就没有那一条 —— 形参在入口绑成局部量，所以拷贝不改变任何可观察行为。）

```
分配   357.8M -> 333.2M   (-6.9%；连上"直接调用上栈"那一刀累计 370.2M -> 333.2M)
arena  10571 -> 9260 MiB  (-12.4%)
```

再跑一次归属确认它落在了该落的地方：`call3` 那条栈**从前八名里消失了**。

### 下一刀：属性键的三次编码（归属表现在的第一名）

新的前八名是同一个模式（各 0.6%，只是被精确帧元组拆开了）：

```
omni_s16_of_utf8 / omni_s16_to_utf8 / omni_js_key_tag_
  < omni_js_pkey_ < omni_js_getp < omni_js_obj_getk < l_JsParser_peek
```

一次 `o.foo` 在真对象上要走 **UTF-8 -> UTF-16 -> UTF-8 三次分配**，位置很具体：

1. `omni_js_obj_getk` 的 OBJ 那一支（`omni_js_obj.h`）：
   `return omni_js_getp(o, omni_dyn_of_s16(omni_s16_of_utf8(key)), omni_dyn_undef());`
   —— 它收到的 `key` 本来就是 UTF-8（对的形态），却转成 STR16 只为了凑 `getp` 的 dyn 形参。
2. `omni_js_getp` -> `omni_js_pkey_(k)` -> `omni_s16_to_utf8`：又转回 UTF-8。
3. `omni_js_pkey_` -> `omni_js_key_tag_('s', u)`：再开一块，只为在前面加一个字节的前缀。

而这个键在生成的 C 里**两种编码的静态副本都已经躺在字面量池里了**（`k_s16_N` 与
`k_s16_N_s`）。两步走：

- **先 3 -> 1**：加一格 `omni_js_getp_k(o, omni_str key, omni_dyn recv)`，直接收 UTF-8 键，
  只在真要 dyn 键的地方（代理陷阱、访问器的 this）才现造。`obj_getk` 的 OBJ 支改叫它。
  不动发射器，纯运行时。
- **再 1 -> 0**：发射器给每个字面量多发一份**带前缀的**静态键（`k_s16_N_p`，就是
  `"s" + utf8`），`...k` 那条特化把它一起传下去。前缀存在的理由是"串键与符号键不能撞"
  （符号按 `y%p` 发键），所以不能简单地去掉前缀 —— 只能把它挪到编译期。

### 这两刀都落了，而且 1 -> 0 换了个更便宜的做法

`getp_k` 落地：**分配 -20.6%（333.2M -> 264.6M）、墙上时间 -11%、用户 CPU -11%**
（交替跑两轮：40.00/39.93 -> 36.93/34.59 与 28.53/29.58 -> 26.01/25.83）。这是这一轮里
第一刀真的把时间也带下来的。

1 -> 0 没有走"发射器多发一份带前缀的静态键"，因为有更便宜的一条：**查槽只读键**
（`omni_js_find_slot_` -> `DT_find` 就是算哈希 + memcmp，从不留它），只有插入才把键存进表。
所以带前缀的键可以直接在**栈**上拼（`char kbuf[64]`），>= 63 的才落回 `key_tag_`。
再 **-13.0%（264.6M -> 230.2M）**，时间中性。

这一轮的累计：**分配 370.2M -> 230.2M（-37.8%）、arena 11029 -> 7786 MiB（-29.4%）、
emit-c 墙上 35.6s -> 32.5s**。每一刀都由归属表指，改完再跑一次归属确认它从榜上消失。

### 归属表现在的前几名（下一轮的靶子）

```
[1][3] omni_list_dynamic_from < u_lexJs < l_JsParser_init          约 240 万次 / 54 MiB
[2][4][5][6] alloc16 < omni_s16_of_utf8 < omni_js_dict_keys_
             < omni_js_obj_keys < u_eachChild < u_nestedFns …      约 430 万次 / 38 MiB
```

两个都不再是"运行时的一格 op 白花钱"，性质变了：

- **`u_lexJs` 自己在建 list** —— 那是**编译器自己的源码**（词法器给每个 token 建数组）。
  这一头要改的是 `src/core/frontend-js/lexer.js` 的写法，不是运行时。
- **`Object.keys(dict)` 把每个键从 UTF-8 转成 UTF-16**，一个键一次 16 字节分配；而
  `lower.js` 的 `eachChild` 对**每个 AST 节点**都 `Object.keys(node)` 一遍，所以它极热。
  运行时侧要去掉这一次转换，得让 `obj_keys` 交出 `OMNI_DYN_STRING`（UTF-8）而不是
  `OMNI_DYN_STR16` —— `omni_js_key` 那儿两种都认，可"比较 / 打印 / typeof 会不会分叉"
  得先量清楚，那是一个**表示层的决定**，值得单独一刀，不该顺手改。
  编译器侧的另一条路更便宜：`eachChild` 不必每次问 `Object.keys`（节点的字段集按 type
  是固定的），这一条不碰运行时。

- **P4 属性取值**。字面量键带编译期哈希、动态键去掉 UTF-16/UTF-8 往返、按调用点 inline
  cache。容器那一半已经落了一点：索引表多存一份完整哈希（`ihash`），探测先比那 8 个字节再
  调 EQ；`_find_h` / `_set_h` 让字面量键连 `HASH(k)` 都省掉。目标 emit-c 用户 CPU < 5 s。
- **P5 omni 变薄**。每个前端 / 后端各自成组 TU，藏在注册表后，`--without-frontend=asy`
  能从链接里摘掉。这才是真正压 18.8 MB 产物的那一刀，必须排在 P1 之后。
- **P6 最后再谈 -O 档**。等 P2/P3/P4 落了，小 TU 上开 -O1 才是便宜的。

## 第三刀落了，然后换仪器：分配已经不是时间的瓶颈

### 短串转码两头都记一份（已落，`2117a473`）

上面那两个靶子的共同点是"同一批属性名来回转码"。所以在 `omni_str16.c` 两个方向各放一张
4096 格的定长表（`<=40` 字节才收）：

- 分配 230.2M -> 193.2M（**-16.1%**），`<=16` 字节那一档 95.0M -> 58.2M
- arena 7786.3 MiB -> 6850.6 MiB（**-12.0%**）
- 墙上 27.9s -> 26.5s（**-5%**），输出逐字节相同
- `bootstrap` 9/9：296.9s -> **222.9s**（-25%）

`omni_eq_string` 顺带改成"先比长度、再比是不是同一份缓冲区"：表命中时还回的就是同一份，
dict 查找连 memcmp 都省了。安全性写在代码注释里（串不可变、没有一处按地址判串相等）。

### 拐点：分配 -16% 只换来墙上 -2%

前两刀的比例是分配 -20.6% 换墙上 -11%，这一刀是 -16.1% 换 -2%。**分配已经不是主导项了**，
再按归属表往下追是在磨一把不再锋利的刀。所以换仪器：`/usr/bin/sample` 采 20 秒 / 1 ms。

### 自时间榜（一趟 `emit c src/cli.js`，14602 个有效样本）

```
omni_hash_string                927     omni_s16_to_utf8         532
omni_dict_string_dynamic_find   926     omni_dyn_as_ref          396
omni_dict_string_dynamic_find_h 741     omni_js_obj_getk         309
_platform_memcmp                663     omni_s16_of_utf8         307
```

**dict 查找那一串（哈希 + 探测 + memcmp）合起来约 3260 个样本 ≈ 22%** —— 这就是"AST 节点是
dict、每次取字段都是一次带前缀键的哈希查找"的价钱。它才是下一个真靶子，不是分配。

### 阶段分布（非递归帧，可信）

```
u_compile +348  (前端)  10400   71%
u_compile +960  (后端)   4202   29%
```

### 负结果：lower.js 的遍历记忆化，白改（已回退）

按 `u_eachChild` 在栈上出现的次数（15812）推断"外层函数反复重走内层子树"，于是给
`refNames` / `mentionsThis` / `mentionsNewTarget` 按函数节点记了一份答案。量出来
**26.62s vs 26.52s —— 没有收益**，已回退（输出逐字节相同，所以不是改错了，是没用）。

**方法上的错在我**：把一个**递归**函数在同一条栈上的多层样本加起来，得到的不是它的
inclusive 成本，而是"次数 × 深度"。`u_eachChild 15812` 这种数不能用来做归属。
可信的只有两样：自时间榜，和非递归帧（`u_compile` 的两个偏移）的分布。

## P2 的架构叉路：运行时得从 header-only 的宏块变成真正的库


分文件在墙上时间上是赚的（94 个 TU 的固定税并行下来约 1.1 s，对上单体的 12.5 s），
而真正的大头是"改一行只重编一个 200K 的 TU"。**卡点不在切分，在链接**：

那 29.5% 的共用部分今天全是**一个 TU 里的 `static`**。天真地切成 94 份会把它复制 94 遍
（7 MB -> 660 MB 的 C）。所以分文件的前提是让 `OMNI_DICT_DEFINE` / `OMNI_JS_OBJ` 那一族的
宏能把"只声明"与"定义一次"分开 —— 给它们加一个存储类参数（它们本来就收 `LT` / `DT`），
默认还是 `static`，于是单体那条路逐字节不变；分文件时由**一个** TU 用外部链接定义，
别的 TU 只见声明。

字面量池不必外部链接：每个 TU 只需要**它自己用到的**那些，照旧 `static` 就行
（发射器知道每个函数引用了哪些）。这样共享 header 里只有类型声明、容器声明、函数原型 ——
小，于是每个 TU 的固定税不会被 header 本身吃掉。

子步骤：

- **P2a** 宏加存储类参数，默认 `static`，单体逐字节不变（安全的第一步，可独立验收）。
- **P2b** 发 `shared.h` + `shared.c` + 一个函数 TU，两文件构建跑通且逐字节稳定
  （先证链接改动，不碰切分）。
- **P2c** 按 `f.file` 把函数摊到 N 个 TU，每个 TU 自带 `static` 字面量池。
- **P2d** 并行编（`spawnPar` 已在）+ 每个 TU 内容寻址不重编（`incr` 有按函数的内容寻址
  可借）。

验收：N1 冷构建 <= 30 s、热构建 <= 5 s，四道闸与四条不动点全绿。

### 修正：P2a 不是前提 —— 量了一下，"复制 94 遍"这个担心是错的

把发出来的 C 的**共用前段**（`#include "omni.h"` + 字面量池 + 容器/JS 模板实例化 + 全部函数原型，
47852 行）单独拿出来，接一个空 `main`，用构建用的档编一遍：

```
clang -std=c11 -O0 -I src/runtime -c pro.c   ->  0.46 s，pro.o 528 字节
```

**528 字节。** 没被引用的 `static` 函数与 `static const` 数据 clang 连代码都不生成（-O0 也一样）。
所以复制共用前段的代价是"每个 TU 0.46 秒的编译税"，不是"7 MB × 94 的产物"。

于是顺序反过来了：

- **P2a（宏加存储类参数）不再是前提，降级成一条以后可选的优化** —— 它省的是"同一个
  helper 在 16 个 TU 里各留一份机器码"那点体积，不是能不能切分。
- 先做的是 **P2c'**：发射器把**生成的函数**改成外部链接（原型本来就在共用前段里），
  按 `f.file` 摊到 N 个 TU，每个 TU 前面照抄共用前段。
- 分组数是个旋钮：94 个 TU 的税是 43 s CPU（10 路并行约 5 s 墙上），并成 16 组只有 7.4 s CPU
  （约 1.5 s 墙上）。热路径上真正要紧的是"改一个文件只重编一个 TU"（约 0.5-1.5 s）。
- 要量的代价有一个：常用 helper 会在每个 TU 各留一份机器码，产物会变大 —— 那正好是 P2a
  以后要收的账，先量出来再决定。

### 切分的配方（读代码读出来的，不是猜的）：只有三样东西不能复制

复制一份共用前段是安全的，**除了带状态的那几格** —— 复制它们就是复制状态，等于静默的错答案：

- **模块级变量** `static omni_dyn g_*` / `static <T> g_*`（emit.js:325、329）。
  切分时共用前段里发 `extern`，定义只放在带 `main` 的那个 TU。
- **单例闭包的缓存** `static omni_fn one = NULL;`（emit.js:438，`c.single === true`）。
  复制它 -> 同一个"单例"闭包在两个 TU 里是两格，`f === f` 会假。所以 closure maker 必须
  外部链接、定义一次。
- **剖面器的栈** `static int omni_prof_sp / omni_prof_ovf`（emit.js:974-975）。
  它是全程一根栈，复制成每个 TU 一根，`--prof` 的输出就废了。

其余都是无状态的，复制没有语义后果（字面量池、容器/blob/vec 模板、box、enum 构造器、
成员派发器、`omni_js_op_key_`、fnmeta 与 data 那两张 const 表）—— 而且没被引用的那份
clang 连代码都不生成（上面 528 字节那一条）。

生成的函数本身要去掉 `static`（原型也一样，emit.js:1059 的 `proto`），否则跨 TU 调不到。

### 试了，响着坏了：P2a 到底还是前提（配方上面那一段少数了三样）

按上面的配方把发射器切开（`emit c --split=N --work DIR`，已落），12 + 1 个 TU：

```
发射   13 个 TU，每个约 8 MB（共用前段 6.8 MB + 自己的 1.5 MB）
编译   10 路并行 7.4 s 墙上 / 24.6 s CPU（单体是 11.0 s 墙上）
链接   0.9 s，产物 21.2 MB（单体 18.9 MB，+12% 是复制的 helper）
跑     omni: uncaught: TypeError: cannot set property 'items' of undefined   <- 响着坏了
```

**坏在我数漏了：模板实例化自己就带状态。** `OMNI_JS_OBJ(...)` 是在**生成的 C 里**展开的
（emit.js:665），而它里面有

- `static omni_dyn omni_js_realm_tbl_[25]`（omni_js_obj.h:1723）—— 内建原型那 25 格
- `static DT omni_js_xprops_tbl_`（:241）—— list / Map / Set 身上"表外属性"的旁表
- `static omni_dyn omni_js_ctor_tbl_[19]`（:184）—— 构造器那 19 格

复制它们等于每个 TU 一套对象模型：在 u0 里给数组挂的属性，u3 看不见。所以
**P2a（给容器 / JS 那一族宏加存储类参数，让"声明"与"定义一次"分开）确实是前提** ——
原来的计划是对的，我上面那一段"只有三样不能复制"数漏了模板自己的状态。

好在这一趟不是白试的，它把三件事钉住了：切分的发射器已经能用、并行编 7.4 s 是真的、
体积代价 +12% 是真的。下一步就是 P2a，然后这条路直接就通。

### 切分的形状定死了：模块 = TU = `.o`，不是把一体切块

按字节装箱那个做法是错的，两条理由，都是硬的：

1. **它在造膨胀。** 共用前段抄进每一格，13 个 TU 就是 104 MB 的 C —— 而这一轮要收的账
   正是膨胀（src 6.5 MB -> omni.mjs 13.5 MB -> omni 18.8 MB）。
2. **模块与 TU 不对齐，增量就不成立。** "改一个文件只重编一个 TU"要求 TU 的边界就是
   模块的边界，桶里混着七八个模块的函数时，改哪个文件都得重编一整桶。

所以 `emit c --split --work DIR` 现在按模块发：一个源文件一个 `.c`，外加一份共享段。
量出来（`emit c src/cli.js --split`）：

```
94 个模块 TU，合计 17 MB，共享段 7 MB   （单体是 25.9 MB —— 没有复制，总量还小一点）
最大的几个：frontend_c_tccgen 1M/240 funcs、frontend_jnc_lower 1M/288、
            frontend_js_lower 1M/307、host_path 1M/11 funcs、cli 685K/184
```

`host_path` 那一行**不是**膨胀，是一处**归属错**：数进去才看清 —— 那个 TU 里坐着
`omni_main`（451 行，整份程序的模块级初始化都在它里面），也就是说**合成出来的入口函数
被归到了 `src/core/host/path.js`**（它该归到入口模块 `src/cli.js`）。`fileOfSpan` 对
合成节点拿到的是"最后一个链进来的模块"的 span，P1 那一格得补一刀：入口函数按入口模块归。
在它修好之前，按模块分组的表里最大的那一格是虚的。

去掉这一格之后，真正的分布是 frontend_c_tccgen 1M/240 funcs、frontend_jnc_lower 1M/288、
frontend_js_lower 1M/307 —— 每函数 3-4 KB，均匀，没有单点膨胀。
**膨胀不在某个模块里，在"每一行 C 的单价"上**（25.9 MB / 42.2 万行 = 61 字节一行），
那是 P4/P6 的题（一行 op 发多少字节的 C），不是切分的题。

剩下的两步没变，顺序是死的：**P2a**（宏加存储类参数 -> 共享段变成"只有声明的头 +
一个定义 TU"）-> 然后每个模块 `.c` 才编得起来、`.o` 才能按内容寻址缓存、并行才有意义。

### 最小构建（只留 js -> c）值多少：量出来了，76%

按模块切完，把 94 个 TU 按子系统加起来（`emit c src/cli.js --split`，字节）：

```
共享段            7.75 M      <- 字面量池 + 模板实例化 + 原型（P2a 之后是"一份头 + 一个 TU"）
frontend_asy      2.48 M (10)      link            1.55 M (11)
frontend_c        2.03 M ( 6)      mir             0.93 M ( 9)
frontend_js       1.90 M ( 5)      interp          0.69 M ( 3)
frontend_jnc      1.42 M ( 1)      x64             0.49 M ( 3)
frontend_glsl     0.84 M ( 4)      arm64           0.44 M ( 3)
frontend_wat      0.24 M ( 1)      backend_llvm    0.41 M ( 1)
sexpr             0.58 M ( 3)      backend_js      0.27 M ( 2)
glr              0.29 M ( 5)      backend_spirv   0.18 M ( 1)
host 1.13 M / cli 0.86 M / hir 0.56 M / parse 0.24 M / repl 0.12 M / 其余 < 0.1 M
```

**只留 js -> c 这条路**：留下 frontend_js + backend_c + hir + host + cli + module + source
+ parse ≈ **5.4 M**，摘掉别的前端（asy / c / jnc / glsl / wat / sexpr / glr ≈ 7.9 M）与
别的后端与原生那一摊（link / mir / interp / x64 / arm64 / llvm / spirv ≈ 5.0 M）
—— **能砍掉约 12.9 M / 17 M 的独占部分，76%**。生成的 C 从 25.9 M 掉到约 13 M
（其中 7.75 M 是共享段，那一份等 P2a 之后自己会瘦）。

一条硬边界：`backend_js` 不能在**自举链**里摘 —— `bootstrap` 的 C1 / C2 两条不动点是
`emit-js` 出来的 `omni.mjs`，所以 js 后端要么内建、要么当第一个被发现的插件。

**没有 `--only` 这种开关。** 语言模块各自独立编译成一个动态库，核心**自动发现**：
扫约定的那个目录（`<exe>/../lib/omni/plugins`），按文件名认 `omni-lang-<名字>.dylib` /
`omni-target-<名字>.dylib`，`dlopen` + `dlsym("omni_plugin_init")`，插件自己调
`registerLang` / `registerTarget`。装了就有、没装就没有 —— "带哪些"是**目录的内容**，
不是命令行上的一个白名单。（试过白名单那条路，当场删了：它把"装没装"变成了一个要配置的问题，
而且核心里那份代码根本没少。）

### P2a 有一条便宜得多的路：把**状态**搬进运行时，别动宏

宏加存储类参数要把六个 header 里几百个函数一个个改成"声明 / 定义"两态（宏体里带逗号的
类型还会把参数切断），是一大刀。但真正拦路的只是**状态**，函数复制一份是无害的
（一样的代码，代价只是产物 +12%，已量）。而状态只有十一格，全在这三个 header 里：

```
omni_js_obj.h  fnproto_tbl_(DT)  ctor_tbl_[19](omni_dyn)  pm_find_/pm_call_(函数指针)
               xprops_tbl_(DT)   nt_slot_(omni_dyn)       realm_tbl_[25](omni_dyn)
               jobq_(LT) jobq_at_(int64)                  gt_tbl_[1](omni_dyn)
omni_js_arr.h  this_slot_(omni_dyn)
omni_js_json.h json_jb(jmp_buf)
```

`omni_dyn` / `int64_t` / 函数指针 / `jmp_buf` 都是**运行时自己的类型**，可以直接搬进
`omni.h` 声明、某个 `.c` 里定义；`DT` / `LT` 那三格是指针，在运行时存成 `void *`、
在模板里强转回来就行。十一格搬完，模块 `.c` 就能各自编、链起来跑对，
而 P2a（真正的声明/定义分离）降级成"以后想收那 +12% 体积再说"的优化。

顺序于是变成：**搬状态（十一格）-> 模块 .o + 并行 + 内容寻址缓存 -> P5 可选子系统
-> （可选）P2a 收体积**。

## 形状定死：分语言 = 动态库 + 按需加载，`.o` 只是路上的一步

上面那些 `.o` 的活儿都不是目的。目的是：**`omni` 核心是一个薄二进制，每种语言（前端）
与每个目标（后端）各自是一个动态库，用到了才 `dlopen`。** 不是"都链进来但可以不链"，
是"根本不在核心里"。

核心里留什么：driver + OIR/HIR + host + **js 前端 + c 后端**（最小构建那条路，
也是自举要走的那条）。别的一律出去：

```
核心（估）  共享段 7.75 M + frontend_js 1.90 + backend_c 0.53 + hir 0.56 + host 1.13
            + cli 0.86 + parse 0.24 + 零碎 ≈ 13 M 的 C（今天是 25.9 M）
插件（各自一个 .dylib / .so）
  omni-lang-asy   2.48 M      omni-target-llvm   0.41 M
  omni-lang-c     2.03 M      omni-target-spirv  0.18 M
  omni-lang-jnc   1.42 M      omni-target-js     0.27 M
  omni-lang-glsl  0.84 M      omni-native（link/mir/x64/arm64/interp）4.06 M
  omni-lang-wat   0.24 M      omni-glr（sexpr/glr）0.87 M
```

### 三条硬约束（前两条已经量到，第三条是设计）

1. **插件里不能有第二套对象模型。** 今天容器 / JS 那一族模板在**生成的 C 里**展开、
   带静态状态（十一格，上一节列了）。插件是另一个映像，模板再展开一遍就是又一套
   `realm_tbl_` / `xprops_tbl_` —— 就是那句 `TypeError: cannot set property 'items' of
   undefined`。所以"搬状态"从"可选的便宜路"升级成**动态库的前提**：状态住在核心，
   插件通过动态符号解析拿到（macOS `-Wl,-export_dynamic` + 插件侧
   `-undefined dynamic_lookup`；Linux `-rdynamic`）。
2. **自举链要 `backend_js`。** C1 / C2 两条不动点是 `emit-js` 出来的 `omni.mjs`。
   所以要么 js 后端也内建，要么自举时把 `omni-target-js` 当第一个被加载的插件跑通 ——
   后者更好：它顺带把插件机制自己变成自举的一部分，坏了当场就红。
3. **插件 ABI 要是 C ABI 且带版本。** 形状：
   `const omni_plugin_v1 *omni_plugin_init(const omni_host_v1 *)`，交一张
   `{ abi_version, kind: lang|target, name, exts[], lower(), emit() }`。版本不合**响着拒**
   （"这个插件是给 ABI 2 编的，我是 1"），不许按名字猜、不许静默降级。

底子已经有了：`host/native_c.js` 与 `runtime/omni_r3.c` 里已经在用 `dlopen` / `dlsym`
（LLVM-C 与 GL 那两条路），所以宿主原语不用新造。

### 落地顺序（每一格能独立验收）

- **S1 搬状态**：十一格进 `omni.h` 声明 / 一个 `.c` 定义（`DT` / `LT` 三格存 `void *`）。
  验收：四门 + 自举全绿，单体产物功能不变。**已落**（`faa7388a`）。
- **S2 核心 / 插件的 C 分家**：按模块发的 `.c` 分成"核心组"与"每个插件一组"，
  插件组的函数外部链接。**按模块编 + 链 + 跑，已经通了**：

```
emit c src/cli.js --split   ->  _decl.h（共用 7 M）+ 94 个模块 .c（合计 17 M）+ _shared.c
clang -O0 x 95，10 路并行       13.6 s 墙上 / 86 s CPU     （单体 11.0 s 墙上）
链接                            0.9 s，产物 28.5 M         （单体 18.9 M，+50%）
跑                              emit c src/cli.js 与 node 腿**逐字节相同**
改一个模块重编                  1.4 s（+ 链接）            <- 这才是"热构建 <= 5 s"那一条
```

  冷构建反而慢了 2.6 s（95 份共用前段的固定税 = 43 s CPU），产物大了 50%（模板在 95 个 TU
  里各留一份机器码）—— 两笔账都记在 P2a 头上，收它的时候一起收。**换来的是增量：
  改一个模块 1.4 s，对上单体 11 s 全量。**
- **S3 一个插件走通**：先 `omni-target-js`（自举要它，坏了当场红）。`dlopen` + ABI 版本检查 +
  找不到插件时的**响错**（"asy 前端没装：缺 omni-lang-asy.dylib"，不是 "unknown extension"）。

  **链接那一半先单独证了**（S1 之后立刻能证，不必等注册表）：拿按模块发出来的 `_decl.h`
  编一个 `plug.dylib`（`-fPIC -shared -undefined dynamic_lookup`）与一个核心可执行文件
  （`-Wl,-export_dynamic` + 运行时），核心写 `omni_js_realm_tbl_g[0] = 7`、`dlopen` + `dlsym`
  之后插件读到 7，插件写 `[1] = 99`、核心也看得见：

```
plug: realm_tbl_g[0].tag=3 u.r=7
host: realm_tbl_g[1].u.r=99
```

  也就是说：**模板在插件里再展开一遍无害（无状态了），而状态是同一份。**
  这正是 S1 要换来的东西。剩下的是注册表与 ABI 那一半（纯管线）：
  把 `emitJs` / `lowerAsy` 这些**直接调用**改成过一格注册表，node 腿用动态 `import()`、
  C 腿用 `dlopen`，宿主原语已有（`host/native_c.js`、`runtime/omni_r3.c`）。
- **S4 其余插件搬出去**：每个语言 / 目标一个独立编译的动态库，落到约定目录里；
  核心启动时扫一遍（自动发现，无开关）；`bootstrap` 分步表把每个插件的时间与体积摆出来。
- **S5**（可选）P2a 收共享段那 7.75 M 与产物那 +50%。

## 顺带记下的两个坑（都不是性能问题，是这一轮量的时候撞上的）

**`dist` 安装跑不了 `omni c tcc`。** 它把 libc 头解析到 `<dist>/include`，而 bootstrap 的
layout 只铺 `lib / runtime / jit / grammar`，从来不铺 `include/`；仓库里也根本没有
`stdio.h`（从 node 跑时 C 前端走的是另一条找系统头的路）。所以"从 dist 装出来的 omni 跑
C 前端"这个组合是坏的 —— 属于 P5 的打包边界，动它要先定 `include` 该由谁提供。

**用户方法与内建成员同名，在两条编出来的腿上都炸。** `splice` / `toSpliced` / `push` 这
三条收可变实参，降级器不走定长的成员派发器、直接发 op，静态分不出接收者。`push` 早就有那句
运行期看标签的判断，`splice` 那两条漏了 —— 于是 C 前端里的 `Cpp.splice()` 在 C 腿上是
"dynamic value is object, expected list"、在 emit-js 腿上是 "object is not an array"，
而 node 直接跑源码时它是一次普通方法调用，所以四道闸一个都没抓着。已修，用例进
`tests/js-exec/cases/54-member-name-collision.js`。
