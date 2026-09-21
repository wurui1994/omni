# 构建系统重做（设计）

状态：设计 · 2026-09-21 · 落地分几刀，判据写在第 8 节

## 0. 三条约束

这三条是先钉死的前提，不是权衡出来的结论：

1. **asy 编译到 JS 那一套不作为构建路径。** "把东西编成 JS 再在宿主里跑"可以是一条
   *执行*腿（`--backend js` 仍然在），但**构建**不走它：构建要出的是目标文件、可执行文件、
   库，而不是一份需要宿主才能动的文本。
2. **不许有 weak，不许有环。** 符号解析必须是确定的：缺了就当场报缺了谁、谁要的。
   依赖图必须是 DAG：有环就报整条环路径。今天 `module/load.js:175` 已经这么做了
   （`import cycle:` 带整条链），链接那一侧却还靠 weak 兜着
   （`link/flat_image.js:119`、`link/elf_exe.js:1588`：弱未定义把 `bl` 改成 `nop`）——
   那是"链接期猜"，新系统里不留这一格。
3. **`.sx` 不是必经的中间产物。** 它是一种可读的中间格式，调试与判据可以要它，
   但构建不该为了走下一步而先落一份文本。今天 `cli.js` 的借来语言那条路会往
   `.omni-cache/src-sx/<哈希>/` 落一份（ADR-0041）—— 那是当时为了"复用 `.sx` 输入那条路"
   的最省事接法，不是它该长的样子。新系统里中间结果默认在内存里传，落盘只因为
   **缓存**或**要给人看**，而且落哪儿由构建图说，不由某一处代码顺手决定。

## 1. 今天的"构建"是什么

老实说：**没有构建系统，只有几条写死的流水线**。

- `omni build FILE -o OUT`（`src/core/cli.js` 的 `case 'build'`）：前端 → OIR → 摇树 →
  后端 C → 我们自己的 C 前端 → 目标文件 → 链接。顺序是代码里的语句顺序，
  一步一步来，没有任务图。
- 运行时那 21 个 `.o`（`.omni-cache/rt/<哈希>`）：按内容哈希整目录命中或整目录重编，
  不是按文件粒度。并行度是写死的。
- 函数级增量在 `src/core/incr/cache.js`：键 = 后端标记 + 该函数 MIR 内容哈希 +
  被调者**签名**哈希；内容寻址、无失效逻辑。这一层的思路是对的，但只有 JS 后端的
  单函数文本进了缓存（那份注释自己写着"选它不是因为它有用"）。
- `omni bootstrap`（`src/core/bootstrap.js`）：四道不动点门槛，但整条链是顺序脚本 +
  子进程，失败只能从头再来。
- `src/core/cli/stages.js` / `plan-c.js` / `plan-omni.js`：叫 plan，实际是**给人看的
  管线表**（`--explain` 印它），不参与调度。

后果有三个，都是可量的：改一个字重编整棵（没有细粒度的脏判定）、并行只在少数几处写死
（没有全局 job 预算）、任何一步失败都从头开始（没有"上次做到哪儿"的记录）。

## 2. 别人怎么做的：抄什么、不抄什么

**C++（CMake → ninja）**。两层分工：CMake 生成规则，ninja 只管把 DAG 跑完。
抄的就是这条分工 —— 执行引擎不认识语言，只认识"文件 → 命令 → 文件"，
所有语言知识留在生成那一层。不抄 CMake 那门语言。

**TypeScript（tsc --build / project references）**。抄两样：**声明文件当接口**
（改实现不动接口，下游不必重编 —— 与我们函数级缓存"按签名算键"是同一个念头）、
`.tsbuildinfo` 那份"上次构建的事实"落盘。不抄它的 out-of-date 判定只看时间戳。

**Rust（cargo + rustc）**。抄三样：编译单元有**指纹**（命令行 + 依赖指纹 + 源码哈希
一起进键）、`-C metadata` 把同一份代码的不同配置分开、`cargo` 与 `rustc` 之间的
**JSON 事件流**（进度与诊断是数据不是人话文本）。不抄它的 crate 级粒度（太粗，
我们函数级已经有了）。

**Go（go build）**。抄它最狠的两样：**内容寻址的动作缓存**（action ID = 输入全体的哈希，
包括编译器自己的版本）与**没有配置文件的构建**（包的边界就是目录，依赖从源码里读）。
Go 的"编译器版本进哈希"这一条我们必须有：我们改后端的频率比谁都高。

**Zig（build.zig + 缓存）**。抄两样：构建描述**就是这门语言写的程序**（不是第二门 DSL）、
**manifest 式缓存**（每个动作记下它读过的每个文件的 mtime + size + inode + 哈希，
命中判定先比便宜的、再比贵的）。

## 3. 三层，职责不交叉

```
上层  驱动      omni build / run / test / bootstrap
                （用户敲的动词；它把"要什么"翻成一张图）
中层  规则生成  语言知识住在这儿：一份 .go 要经哪几步、运行时要哪些 .o、
                链接要哪些库。出来的是**图**（也可以落成 .ninja 给别人看）
底层  执行引擎  只认识文件、命令、依赖。不认识语言，不认识 omni
                （= 这一刀要复刻的 ninja）
```

**这条分工是整份设计的核心**。今天三层是糊在一起的（`cli.js` 里既有语言知识、
又有顺序、又有子进程调度），所以任何一处改动都要动那 5600 行。分开之后：

- 底层可以被单独判据（喂它一份 `.ninja`，与真 ninja 比"跑了哪些命令、什么次序"）；
- 中层是纯函数（输入：源文件集合 + 配置；输出：图），可以只比图不跑命令；
- 上层只剩参数解析与错误呈现。

## 4. 底层：工件与任务

照 ninja 的两类顶点（`src/graph.h:43` 的 `Node`、`:180` 的 `Edge`），因为这套模型
被十年生产验证过，而且**它的不变量正好是我们要的那两条**（DAG + 确定解析）：

- **Node = 一格工件**（多数是文件，也可以是 phony 的名字）。状态只有三样：
  `mtime`（-1 没看过 / 0 看过但不存在 / >0 真的 mtime）、`dirty`、`in_edge`。
- **Edge = 一格任务**：`inputs` / `outputs` / `rule`（命令模板）/ `pool`。
  输入分三种、输出分两种，次序编码在数组里（`implicit_deps_` / `order_only_deps_` /
  `implicit_outs_` 三个计数）：
  - 显式输入 → 进 `$in`，变了要重建；
  - 隐式输入（`|`）→ 不进 `$in`，变了要重建（头文件、模板、语法表）；
  - 仅次序（`||`）→ 必须先做完，但它变了**不**触发重建（生成目录、代码生成器）；
  - 隐式输出 → 任务确实会写它，但不进 `$out`。
- **validation（`|@`）**：要求"这个也得被构建"，但不排在本任务之前 —— 判据类任务用它。

我们加两条 ninja 没有的（因为约束 2）：

- **环当场报整条路径**。ninja 用 `Edge::VisitMark` 三态在 DFS 里查环（`graph.h:184`），
  报的是"dependency cycle"。我们报的格式与 `module/load.js:175` 那句一致：
  一行一格，指出是哪条边把它接回去的。
- **没有 weak 这一格**。缺输入就是错误，且要说清"谁要它"（哪条边、哪个位置）。

## 5. 脏判定与两份日志

三个来源合起来判一个输出是否要重做，缺一个都会给出错答案：

1. **mtime 比较**：输出比任一输入旧 → 脏。缺输出 → 脏。
2. **命令哈希**：命令行变了 → 脏。ninja 把它记在 `.ninja_log`
   （`build_log.cc:53` 的 `# ninja log v7`，每行 `start end mtime output hash`，
   哈希是 rapidhash，`build_log.cc:60`）。**我们这儿这一条比谁都重要**：
   改一行后端、换一版编译器，命令字面量往往不变而产物必须重编 —— 所以我们的命令哈希里
   要连**编译器自身的指纹**一起算（学 Go 的 action ID），否则"改了 backend-c 却没重编"
   就是静默的错答案。
3. **动态依赖**：命令跑完才知道读了哪些文件（C 的头文件、asy 的 `import`、
   go 的同目录文件）。ninja 两条路：`depfile`（Makefile 风格，跑完解析一次然后丢掉，
   `depfile_parser.in.cc`）与 `deps`（解析完存进 `.ninja_deps` 二进制日志，
   `deps_log.h:25` 那段注释把格式写得很清楚：路径记录 + 依赖记录，路径按出现次序拿到
   稠密整数 id，记录头四字节高位区分类型，单条上限 512KB-1）。
   我们要的是 `deps` 那条：我们的前端本来就知道自己读了什么，直接吐结构化依赖，
   不必绕 Makefile 文本。

`.ninja_deps` 那份"路径 → 稠密 id + 追加写 + 偶尔 recompact"的设计值得照抄：它同时解决
了"构建中途被打断"和"启动时一次读完"。

## 6. 调度

照 ninja 的 `Plan`（`build.h:96` 起）：

- `AddTarget` 递归下去标"要不要做"，`want_` 三态：`kWantNothing`（它本身不做，但它的
  下游可能要做）/ `kWantToStart` / `kWantToFinish`。
- `ready_` 是一个**优先队列**，键是 `critical_path_weight`（`graph.h:213`）——
  关键路径长的先跑。这不是锦上添花：串行化的那一段在末尾出现，总时长就多一截。
- 一条边做完（`EdgeFinished`）→ 它的输出 `NodeFinished` → 每个下游检查
  `AllInputsReady` → 进 `ready_`。
- **restat / CleanNode**：命令跑完发现输出内容没变（mtime 没前进），就把下游从"要做"
  降回"不用做"。链接那一步最吃这一条：改一行注释重编了 `.o`，但 `.o` 字节没变，
  就不该重链。
- **Pool**：一格并发预算（`depth`）。ninja 用它来限制吃内存的任务（链接）与
  `console` 池（独占终端、不缓冲输出）。我们至少要三格池：默认、link（内存大）、
  console（交互与 REPL）。
- 进程侧：`SubprocessSet`（`subprocess-posix.cc`）fork/exec + pipe 收输出 +
  `ppoll`/`pselect` 等，输出整条收齐再印（不交叉）。**我们跑在 node 上，这一格用
  `child_process` + 我们自己那格 `spawn` 的封装，但"输出整条收齐"这条规矩一样要有。**
- 默认并发：ninja 的 `GuessParallelism` 按核数给（2 核 +0、≤4 +1、否则 +2）。
  我们照同样的形状，并允许 `-j`。

## 7. 格式：吃两种

**一、`.ninja`（完整支持）。** 理由是生态：CMake / Meson / gn 都能生成它，
支持它就等于我们能被现成的项目当后端用，也能拿真 ninja 当对账的尺子（同一份 manifest，
比"跑了哪些命令、什么次序、几次重建"）。要覆盖的语法（`manifest_parser.cc:450` 行那份）：

- `rule NAME` + 缩进绑定（`command` / `description` / `depfile` / `deps` /
  `msvc_deps_prefix` / `generator` / `restat` / `rspfile` / `rspfile_content` / `pool` /
  `dyndep`）
- `build OUTS | IMPLICIT_OUTS: RULE INS | IMPLICIT || ORDER_ONLY |@ VALIDATIONS`
  加边级绑定
- `pool NAME` + `depth`、`default`、`include` / `subninja`（后者开新作用域）、
  全局变量绑定
- `$` 的转义与续行、`$in` / `$out` / `$in_newline` 这些内建、shell 转义规则
- 求值作用域：全局 → subninja → rule → edge（edge 级最强），`EvalString` 是
  "字面量片段 + 变量引用"的序列（`eval_env.h`）

**二、我们自己的格式：没有格式 —— 描述是一份正常的 JS。** `.ninja` 是**生成物**，
人不该手写；而"我们自己的 DSL"根本不该存在。落的是 **`build.js`**：一份能被
`node build.js` 直接跑的普通 ESM，它从 omni 这个包里 import 构建能力：

```js
// build.js —— 别人的项目里，omni 只是一个 npm 包
import { Build } from 'omni-lang/build';

const b = new Build();
b.set('cflags', '-O2');
b.rule('cc', { command: 'cc $cflags -c $in -o $out', description: 'CC $out' });
b.rule('link', { command: 'cc $in -o $out' });
for (const s of ['a', 'b']) b.build(`${s}.o`, 'cc', `${s}.c`);
b.build('app', 'link', ['a.o', 'b.o']);
b.default('app');
b.run(process.argv.slice(2));       // 认 -n / -j / -k / -t / --emit-ninja
```

两种用法**地位相同**，而且是同一段实现（`build/engine.js`）：

- `node build.js` —— 那个项目里可以完全没有 omni 这个命令（`npm i omni-lang` 就够）；
- `omni ninja` —— 没有 `build.ninja` 时它**转交**给 `node build.js`（开关与目标原样递过去，
  退出码原样带回来）。不是"我们把脚本 import 进来求值"：那份脚本是别人的程序，
  它的依赖、node 版本、自己的参数都归它自己。

包的出口在 `package.json` 的 `exports`：`omni-lang/build` → `src/core/build/api.js`。
那一份导出 `Build`（造图的动作 + `run` + `toNinja`）与底层几件（`State`、`parseManifest`、
`build`、`FakeDisk`）—— 想自己拼调度的人拿底层，想直接用的人拿 `Build`。

`b` 的动作与 `.ninja` 的语句一一对应（rule / build / pool / default / 三种输入），
所以两种入口造出来的是**同一张图**；判据里有一条往返：`build.js → --emit-ninja → 再解析`，
两边命令逐条相同。`--emit-ninja` 就是通向 CMake 那侧生态的**单向桥**。



## 8. 三层缓存怎么并成一套

今天有三套互不相识的缓存，新系统里它们是**同一个键空间的三种粒度**：

- **动作级**（新）：key = 命令 + 全部输入内容哈希 + 工具指纹。命中 = 直接把产物从
  缓存目录硬链/复制过来，连命令都不跑。这是 Go 的 action cache，我们最缺的一层。
- **函数级**（已有，`incr/cache.js`）：粒度比文件细，专治"改一个函数不必重编整个模块"。
  它继续存在，但键里要加上工具指纹，并且产物从"JS 单函数文本"扩到目标码 + 重定位。
- **运行时 `.o`**（已有，`.omni-cache/rt/`）：本质就是动作级缓存的一个特例。
  并进去之后那段专用代码可以删掉。

三层共用一个 `.omni-cache` 布局与一份 GC（按最近使用时间，给上限）。

## 9. 落地顺序与判据

1. **底层引擎（已落地第一刀）**：`src/core/build/` —— 词法 + manifest 解析、图、脏判定、
   Plan、`omni ninja` 入口、`.omni_log`。判据 `tests/build/run.js`（磁盘与执行器都是注入的，
   一个进程都不起）+ 外面那把尺子：`omni ninja --emit-ninja` 出来的 manifest 喂给真 ninja，
   两边跑同一批命令、第二趟都"没什么要做"。
   **还欠**：真并行（现在一次一条 —— 宿主那侧只有同步 spawn，要么加一格异步宿主原语、
   要么按批交给 `sh` 的 `&`/`wait`）、`.omni_deps` 与 depfile（动态依赖）、dyndep、
   rspfile、`-t deps/missingdeps`。
2. **中层规则生成**：先把今天 `omni build x.go -o prog` 那条路生成成图（而不是顺序执行），
   `--emit-ninja` 能印出来，跑起来与今天逐字节相同的产物。
   *判据*：`tests/go` 28/28 不变、`bench/go` 六份的比值不变、`fix:self` 绿。
3. **动作缓存 + 工具指纹**：改一行后端必须触发该重编的那些、且**只有**那些。
   （工具指纹这一格已经在命令哈希里：`OMNI_BUILD_FINGERPRINT` 或入口文件的 mtime。）
   *判据*：一份计数断言（改 `backend-c/emit.js` 一行 → 重编 N 个动作，N 是算出来的）。
4. **去掉 weak 与环**：链接器那几处弱未定义的兜底改成"报缺了谁、谁要的"。
   *判据*：现有各腿全绿，且故意删一个符号时报的是人话。
5. **`.sx` 退回调试通道**：借来语言那条路改成在内存里过图，`--emit-sx` 才落盘。
   *判据*：`tests/go` 不变、`.omni-cache/src-sx/` 不再被默认写。
6. **bootstrap 走同一台引擎**：四道不动点门槛变成图里的四条 validation 边。


## 10. 不做什么

- 不做远端缓存 / 分布式执行（接口留着：动作级缓存的键就是它的入口）。
- 不做 sandbox（macOS/Linux 两套机制，代价不值当；用"声明的输入之外不许读"的**判据**
  代替：跑完比一遍 deps，多读的当错误报）。
- 不做第二门配置 DSL（第 7 节：描述是 omni 程序）。
- 不追 ninja 的每一格周边（`browse`、`msvc` 那一族、jobserver 先不接）。
