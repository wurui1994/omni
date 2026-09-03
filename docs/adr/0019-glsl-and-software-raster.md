# ADR-0019：GLSL 前端与软件光栅化（复刻 llvmpipe）

状态：读过尺子与 mesa 的一角，**有了两条决策**，实现还是 0 行

## 背景

新的一条主线：复刻 mesa 的 llvmpipe（`/Users/wurui/Documents/Lang/reference/mesa`），
即**纯软件的 OpenGL 实现**。GLSL 编到 JS 与 C 两条腿上执行是顺带的（这个管线本来就有那两个
后端），真正的目标是那条光栅化管线本身，以及与 llvmpipe 的**性能对照**。

与前几刀的纪律一样：**尺子先于实现**。所以这一份先只记尺子。

## 尺子：`moderngl` offscreen

参考 `/Users/wurui/Downloads/benchmark.py`（已读）与 `/Users/wurui/Downloads/pretty_render.py`
（**还没读** —— 下一步）。

`benchmark.py` 把测量方式定得很死，逐条抄下来：

**上下文**：`moderngl.create_standalone_context()`——优先真 GPU，取不到就
surfaceless EGL + llvmpipe（`EGL_PLATFORM=surfaceless`，不要 X），再不行 Xvfb +
`LIBGL_ALWAYS_SOFTWARE=1`。**所以同一份脚本既能量硬件也能量 llvmpipe** —— 那正是我们要
的两条基线。

**顶点那一路没有顶点缓冲**：全屏三角形由 `gl_VertexID` 现算，
`(-1,-1)`、`(3,-1)`、`(-1,3)`。所以第一刀压根不用管顶点数组、属性、索引缓冲。

**两个片元着色器**（`#version 330 core`）：

- `FRAG_SIMPLE`：`0.5 + 0.5 * cos(uv.xyx * 3.0 + vec3(0, 2, 4))`
- `FRAG_COMPLEX`：SDF 场景 —— 20 个圆（`sdCircle`）+ 10 个方（`sdBox`）取 min，
  再叠三层 `smoothstep`/`sin`/`cos` 着色

**量法**：每个尺寸先 warmup 一帧，然后 `iterations` 帧，每帧计时**包含 `fbo.read()`**
（回读！不是只算绘制）。尺寸 128/256/512/1024/2048 见方，迭代 50/30/15/8/4。
报三个数：`Avg(ms)`、`MPix/s`、`Frame/s`。

### 这两个着色器定下了「最小可用的 GLSL 子集」

这是读那份 benchmark 最要紧的收获 —— 要走通它，需要的 GLSL **只有这些**：

- 类型：`float`、`int`、`vec2`、`vec3`、`vec4`
- 构造：`vec2(a,b)`、`vec3(a,b,c)`、`vec4(v3, 1.0)`、`vec3(0.02)`（标量铺开）
- 取分量与 swizzle：`d.x`、`d.y`、`uv.xyx`、`gl_FragCoord.xy`
- 运算：向量与向量、向量与标量的 `+ - * /`，一元 `-`
- 内建：`length`、`abs`、`min`、`max`、`smoothstep`、`sin`、`cos`、`float(int)`
- 语句：`for (int i = 0; i < N; i++)`、局部变量、`+=`
- 函数定义与调用（`sdCircle`、`sdBox`）
- 接口：`uniform vec2`、`out vec4`、`gl_FragCoord`（片元）、`gl_Position`/`gl_VertexID`（顶点）

没有：矩阵、纹理、结构体、数组、分支（`if`/三元只在 `sdBox` 里用了 `min/max` 代替）、
`discard`、多渲染目标、几何/计算着色器。

所以第一刀的门可以就是「跑通 `FRAG_SIMPLE`」，第二刀「跑通 `FRAG_COMPLEX`」——
两个门都有像素级的尺子（llvmpipe 的输出）与三个性能数。

## 尺子的第二档：`pretty_render.py`

也读了。它与 `benchmark.py` 是**同一套上下文取法**（默认 → surfaceless EGL → Xvfb），
但量的东西不同：800×800、36 帧动画（`u_time` 推进），存 `pretty.png` 与一份 GIF，
另报每帧耗时。所以它是**像素正确性**那一路的门（有图可比），`benchmark.py` 是性能那一路。

它把子集往上扩了一档，逐条列出来（这一档是第二刀的门）：

- **varying**：顶点里 `out vec2 v_uv;`、片元里 `in vec2 v_uv;`——于是要有**插值**，
  不再是只读 `gl_FragCoord`。这是这一档里最重的一条：llvmpipe 那边插值是
  `lp_bld_interp.c` 独立的一块。
- **矩阵**：`mat2 rot(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }`，
  然后 `p = rot(a) * p` 那种矩阵乘向量。第一档一个矩阵都没有。
- 标量 uniform：`uniform float u_time`
- 模块级 `const float PI = 3.14159265359;`
- 三元 `? :`（顶点里 `(gl_VertexID == 1) ? 3.0 : -1.0`），函数里的 `return`
- 多出来的内建：`dot`、`normalize`、`fract`、`mix`、`clamp`
- swizzle 重复分量：`c.xxx`

**仍然没有**：纹理／采样器、结构体、数组、`if`/`else`（全用三元与 `min/max` 代替）、
`discard`、多渲染目标。

于是两档门是清楚的：

- 第一刀：`benchmark.py` 的 `FRAG_SIMPLE`、`FRAG_COMPLEX`——`gl_FragCoord` + 标量/向量 +
  那七个内建 + `for` + 函数。**没有插值、没有矩阵。**
- 第二刀：`pretty_render.py`——加插值、`mat2`、三元、五个内建。

## 量：读 llvmpipe —— 借什么、不借什么

读过的：`lp_limits.h`（全）、`lp_bld_interp.h`（全）、`lp_bld_interp.c` 头 200 行、
`lp_rast_tri_tmp.h` 头 120 行、`lp_state_fs.c` 的文件头。**没读**的：`lp_bld_nir.c`
那一整摊（NIR → LLVM IR）、纹理采样、`lp_linear*`、`lp_scene`/`lp_setup` 的分箱。
下面每条都带出处，好回查。

### 量到的形状

**一、瓦片是 64×64，光栅化是分层的。** `lp_limits.h:39` `TILE_ORDER 6` → `TILE_SIZE 64`。
`lp_rast_tri_tmp.h` 里两级：`do_block_16` 拿一个 **16×16** 块，按每条边的边函数
（`plane[j].dcdx`/`dcdy`/`eo`）一次算出 16 个 **4×4** 子块的「全在内 / 全在外 / 骑边」
（`build_masks_32` 出 `outmask` 与 `partmask`，`outmask == 0xffff` 直接 return）；
骑边的那些交给 `do_block_4`，它出一个 **16 位掩码**（4×4 个像素各一位），
再调 `lp_rast_shade_quads_mask_sample`。

所以 llvmpipe 的「快」有一半在这儿：**大多数像素根本不逐个测**，整块接受或整块丢掉。

**二、片元着色器的执行单位是 2×2 的 quad，四个像素按 SoA 摆。**
`lp_bld_interp.c:53-87` 那段注释说得很死：一个 block 是 2×2 个 quad、一个 quad 是 2×2 个
像素；四个像素的绿通道躺在**同一个向量寄存器**里 —— `{g0,g1,g2,g3}`。
`quad_offset_x/y[16]`（`:117`）就是那 16 个像素在块内的坐标。

**三、插值是 `a = a0 + x*dadx + y*dady`，一条 fmuladd 两次。**
`interp_attrib_linear` 就这三行。系数（`a0`/`dadx`/`dady`）是 setup 那一步按三角形算好的，
插值这一步只做仿射求值。`lp_bld_interp.h` 头上那句更要紧：**只有第一个 quad 做乘法，
后面的 quad 全靠加法**（沿 x 走一步就加 `dadx*2`）。

`enum lp_interp` 只有六种：`CONSTANT`、`COLOR`、`LINEAR`、`PERSPECTIVE`、`POSITION`、
`FACING`。`COLOR` 按 flatshade 状态化成 `CONSTANT` 或 `PERSPECTIVE` 之一 —— 也就是说
**「插值方式」是编 shader 变体时就定死的常量，不是运行期分支**。

**四、透视除法「每 quad 一次」这条优化 mesa 自己关着。**
`lp_bld_interp.c:103-114`：本来想在 quad 左上角算一次 `1/w`、其余三个像素用线性近似，
注释写着 “Ironically, this actually makes things slower —— 除法单元闲着，乘法单元反而饱和”，
于是 `PERSPECTIVE_DIVIDE_PER_QUAD 0`。**这是一条现成的教训**：别照着「省除法」的直觉做。

**五、整条片元管线是 JIT 出来的一个 C 可直接调的函数。**
`lp_state_fs.c` 文件头列的顺序：early depth test → 片元着色器 → alpha test →
depth/stencil test → blending。它还点明一处复杂性的来源：**各阶段用的精度与类型不同**
（着色器用 float，深度与混色用最贴近缓冲格式的类型），而 SIMD 寄存器宽度固定，
于是「类型不同 ⇒ 一次算的像素数不同 ⇒ 大类型那几段要多生成几份实例」。

**六、变体是有上限、按状态做键的缓存。** `lp_limits.h:72` `LP_MAX_VARIANTS_PER_FS 16`、
`:84` `LP_MAX_SETUP_VARIANTS 64`，注释说 setup 变体由「片元着色器的输入签名 + 一小撮
光栅化状态（如 flatshade）」决定，很多着色器共用一个。

### 借

- **分层光栅化 + 边函数掩码**（`do_block_16`/`do_block_4` 那两级）。这是与语言无关的算法，
  也是性能的大头。第一刀就借。
- **2×2 quad 当执行单位**。第一刀哪怕是一次算一个片元，也要**按 quad 组织循环** ——
  因为 `dFdx`/`dFdy` 与纹理 LOD 天生要 quad，而且后面 SoA 化就是把这个循环换个内核。
- **`a0`/`dadx`/`dady` 的仿射插值形式**，包括「一个 quad 一次乘、后面全加」这条。
- **变体按状态做键**。我们这边没有 LLVM JIT，但「一份 GLSL + 一撮状态 → 一份编好的代码」
  这个缓存结构照借（我们的 `incr` 那一路已经有缓存的骨架）。
- **管线阶段的次序与 early-z 的位置**。这是正确性的一部分，不是优化。

### 不借

- **LLVM 与 gallivm 那一整层**。整个工程的前提是不用 LLVM —— 我们有自己的 x64/arm64 后端，
  这条线正好是它们的第一个「非 C 前端」用户。
- **NIR / TGSI 两套中间表示**。mesa 有历史包袱（`tgsi_to_nir`、`nir_to_tgsi_info`），
  我们直接 GLSL → 自己的 IR。
- **AoS 与 SoA 两条并行的路**（`lp_bld_blend_aos.c`、`lp_linear*` 那一族快路）。
  那是二十年攒下来的特例，第一刀一条路走通再说。
- **多重采样**（`MULTISAMPLE` 那些 `#ifdef`）、**stencil**、**双源混色**、
  **纹理采样**、**几何/计算着色器**。两档尺子（`benchmark.py`、`pretty_render.py`）
  一个都用不到。
- **透视除法每 quad 一次**。mesa 量过是负优化，直接跳过。

## 决策一：GLSL 先接到 MIR，一次一个片元；但循环按 quad 组织

这是「还没定的」第 2 条的答案。三个候选：

- (a) GLSL → **现有的标量 MIR**，一次算一个片元
- (b) 先给 MIR 长出**向量那一格**（SoA、typed vector），后端学 NEON/SSE，再接 GLSL
- (c) 另起一个着色器专用的小 IR，向量化当成它到 MIR 的一个 pass

**选 (a)，理由是「先有能量的东西」：**

- (b) 是这条线上最大的一笔改动（MIR 的类型系统、两个后端的向量指令、寄存器分配），
  而它换来的是**倍数**上的性能 —— 可我们现在连一个能跑出像素的实现都没有，
  没有基线的倍数是空话。llvmpipe 那边 SIMD 是 2010 年就有的事，但它的**结构**
  （quad 循环 + 每通道一个向量）本身在标量下也成立：把 `{g0,g1,g2,g3}` 换成
  循环四次，逻辑一字不改。
- (c) 多一层 IR 就多一层要维护的不变量，而 GLSL 的语义（标量/向量、swizzle、内建）
  离 MIR 并不远。真需要一层，那也该是**在 MIR 之上加向量单元**，不是旁边另立一套。
- (a) 立刻能拿到两条腿（JS 与 native）跑同一份 GLSL，`fbo.read()` 那口径下的
  三个数与像素图都能量 —— 也就是**尺子立刻能用**。

**为了不把 (b) 堵死，第一刀必须守住两条形状：**

1. 片元着色器编成一个**「吃一个片元、吐一个颜色」的函数**，它的输入由一个显式的
   「插值」步骤提供（`a0 + x*dadx + y*dady`），不允许在着色器体里直接摸像素坐标以外的东西。
   这样 SoA 化就是「把这个函数的参数与返回值从标量换成 4 宽向量」，而不是重写。
2. 遍历顺序**按 quad**（2×2），不按扫描线。理由在上面第二条量里。

什么时候动 (b)：等第一档尺子（`FRAG_SIMPLE`/`FRAG_COMPLEX` 五个尺寸）在两条腿上都有数
之后，拿那组数与 llvmpipe 的比，**用差距决定值不值得**。这一条写在这儿，是为了将来不必
靠回忆来判断。

## 决策二：像素比对的口径，量法先定下来

第 3 条还不能定（还没有实现能出图），但**量法**现在就能定，免得将来事后挑一个宽松的：

- 尺子是 **llvmpipe**（不是硬件 GPU）—— 同一份 `pretty_render.py`，
  `LIBGL_ALWAYS_SOFTWARE=1` 那一路。
- 先量**硬件与 llvmpipe 之间**的差（同一份 shader、同一尺寸）。那个差是「实现自由度」的
  下界：`sin`/`cos`/`smoothstep` 的实现不同带来的差别，谁都不算错。
- 我们的容差**不得宽于**那个已量到的差。宽了就是在给自己开后门。

<!-- 量：读 llvmpipe-END -->

## 还没定的（下一步按这个顺序）

1. ~~摸 mesa 那边的边界~~ —— 上面「量：读 llvmpipe」那一节。
2. ~~GLSL 接到哪一层 IR~~ —— 决策一。
3. **像素比对的容差的具体数字** —— 决策二定了量法，数字要等能出图。
4. **第一刀的门长什么样**：`FRAG_SIMPLE` 一个尺寸（比如 256×256）跑通，
   与 llvmpipe 的 PNG 比。这一刀要写的东西：GLSL 的词法/语法/类型检查（子集）、
   降到 MIR、一个最小的光栅器（全屏三角形其实连边函数都用不上 —— 但**要用**，
   因为第二刀就要真三角形）。



## 为什么先记这一份

按这个项目一贯的做法（第九刀那一百多片都是这样）：**量到的事实先写下来，再动手**。
现在手上确凿的只有 `benchmark.py` 那一份口径与它蕴含的 GLSL 子集，那就只写这些。
mesa 那边一行都还没读 —— 在读之前写任何「决策」都是编的。
