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

## 落地：第一刀第一片 —— 语法表与五份尺子源码

只做**语法**，一行降级都没有。`src/core/frontend-glsl/glsl.grammar`，走的是与 jancy 那条线
同一条路（`.grammar` 是数据 + GLR 引擎，类型定向的那一半留给将来的 `lower.js`）。

三件事值得写下来：

**一、这张表是干净的 LR —— 0 处冲突。** 206 个状态、`(prefer …)` 一处都没有。
GLSL 在这个子集里没有 C 那种「要先知道名字是不是类型」的真歧义，因为**类型全是关键字**。
jnc 那份有 3 处真歧义靠 `prefer` 压，这份一处都不需要 —— 有歧义就是我写错了。

**二、`(prec X)` 必须紧跟在 RHS 之后**（`glr/grammar.js:133` 那个 while 只在动作之前扫）。
我第一版写成 `(-> ("-" expr) (neg $2) (prec UNARY))`，`(prec UNARY)` 落在动作后面等于没写：
表里多出 **23 处冲突**，而且 `-a * b` 分成 `(neg (mul a b))` —— 一元负号变得比乘法还松。
`a + b * c` 那两条断言是绿的，因为它们不涉及一元。挪到动作前面之后冲突归零。
**这类错不会让门直接红，只会让图变成另一张画。**

**三、`discard` 收进语法，但不实现。** 不收的话 `discard;` 会被当成「一个叫 `discard` 的
变量」悄悄分析成 `(expr-stmt (name discard))`（量过）。语法里有一条 `(discard)` 之后，
「这一刀不收」这句话由降级那一侧明着说 —— 靠语法碰巧不认，等于把错误藏进一个合法形状里。

`layout` 反过来：关键字表里每个词都得是某条规则用到的终结符（不然构表就骂），
而 `layout(location = N)` 这一刀不收，于是它**不在**关键字表里。

### 门：`tests/glsl/parse.js` 25/0

五份尺子源码从两份 python 脚本里**原样抄**进 `tests/glsl/cases/`（抄是因为脚本在仓库外，
门不能依赖它在不在；抄的时候一个字符没改）：

- `bench-vert.vert` 46 token、`bench-simple.frag` 58、`bench-complex.frag` 399
- `pretty-vert.vert` 58、`pretty.frag` 516

五份**各分析出唯一一棵树**。「唯一」不是门判的 —— GLR 驱动遇到两棵都活到接受的树会自己
报错（它不猜），所以这一条过了就等于「这份语法在这五份源码上没有歧义」。

另外 15 处形状断言挑的都是**容易悄悄错**的格：`a + b * c` 与 `a * b + c` 两个方向、
一元负号、`swizzle` 紧过乘、构造与调用是两条不同的规则、三元与 `==`/赋值的松紧、
`1e10` 是一个浮点字面量、`2.0/3.0` 是两个浮点、`for` 的三格、复合赋值、三种接口声明、
`flat in`、`#version` 整行一个 token、两种注释。3 处「该拒的」：结构体、采样器、缺分号。

断言查子串之前先把空白压成一个空格 —— `printSexpr` 会缩进换行，不压的话「形状对了但换了行」
也会红，那种红是假的。

### 顺带补一条尺子里漏记的内建

`pretty.frag` 里还有 `pow`（`col = pow(col, vec3(0.85))`）。上面那份第二档清单漏了它。
语法这一层无所谓（内建与自定义函数走同一条规则），但降级那一侧的内建表要记着。

<!-- ADR-0019 第一片-END -->

## 落地：第一刀第二片 —— 类型检查与名字解析

`src/core/frontend-glsl/check.js`。出来的是一棵**带类型的树**，不是在原树上挂属性 ——
降级那一侧要的是「每个节点的类型已经定了」，让它再算一遍等于把同一套规则写两遍，
而两遍必然会分叉。

四处决定，都写在文件里：

**一、`stage` 由调用方给，不猜。** 猜是能猜的（看有没有 `gl_Position`），但猜错的那一次会把
「顶点里写了 `gl_FragCoord`」变成「哦这是一份片元着色器」，错误就此消失。内建变量因此是
**分档的两张表**：`gl_VertexID`/`gl_Position` 只在顶点档，`gl_FragCoord`/`gl_FragDepth` 只在
片元档。用错了报的不是「没见过这个名字」，而是「它是片元着色器的内建变量，而这是一份顶点
着色器」——差一句话，查起来差很多。

**二、隐式转换只有一条：`int` -> `float`**（规范 4.1.10，`ivecN` -> `vecN` 也在里头）。
别的一律骂。悄悄转的话 `float f = someVec3;` 会变成「取第一格」——那是能跑的错。

**三、内建函数按**形状**分类，不是一条条重载**：`gen1`（`sin`/`abs`…）、`gen2`（第二个参数
可以是标量，`min(vec3, float)` 合法）、`gen3`（`clamp`/`mix`/`smoothstep`）、`len`、`dot2`、
`cross`。「第二个可以是标量」不是我编的，是规范 8.3 里那几组重载；而 `sin(x, y)` 那种不存在。

**四、`discard` 在这儿骂。** 语法里那条 `(discard)` 就是为了让这句话有地方说 —— 语法不收的话
`discard;` 会被当成「一个叫 `discard` 的变量」悄悄收下。

### 一处真错误，门当场抓到

比较运算（`< > <= >=`）第一版写的是「回两边提升出来的那个类型」，于是 `i < 20` 的类型是 `int`。
结果 `for (int i = 0; i < 20; i++)` 被条件那道检查骂成 **「整数不能当条件」** —— 报错离题，
而真正的错在两百行之外。比较**回 bool**，与两边是什么无关。这一格现在门里单列一条。

### 门：`tests/glsl/check.js` 56/0

- 五份尺子源码都过，而且**接口摸出来的形状对**：`pretty.frag` 是 2 个 uniform
  （`u_res:vec2`、`u_time:float`）、1 个 varying（`v_uv:vec2:smooth`）、1 个 const、
  5 个函数（`sdCircle:float/2`、`sdHex:float/2`、`rot:mat2/1`、`hsv2rgb:vec3/1`、`main:void/0`）。
  只查「不报错」是不够的 —— 不报错也可能是把 `vec2` 认成了 `vec3`。
- 23 条**具体类型**：swizzle 的三种字母表、向量与标量两个方向、`int` 提升、比较回 bool、
  `mat2 * vec2` 与 `vec2 * mat2` 与 `mat2 * mat2`、三元两支对齐、`vec4(vec3, float)`、
  标量铺开、`pow(vec3, vec3)`……
- 20 条**该拒的**，而且比的是**报错里的关键词**，不是「抛了就算过」：`vec2` 没有 `.z`、
  `xyzw` 与 `rgba` 混用、构造少一格与多一格、向量宽度不一样、`%` 不对 float、
  `uniform` 不能赋值、`swizzle` 重复格不能当左值、两档内建变量用错档、版本不是 330、
  没有 main。

`tests/glsl/run.js` 把两组串起来（一条红也继续往下跑），`tests/all.js` 里是一条 `glsl`。

<!-- ADR-0019 第二片-END -->

## 量：降级要接的那一层长什么样（第三片开工前）

决策一说的是「接 MIR」。动手前先量了**核心方言**（`sexpr/lower.js`，jancy 与 asy 都降到它，
五条腿从它出发），因为如果 GLSL 降到方言而不是直接降到 MIR，JS 与 C 两条腿是**白得的**。
量出来三条，其中一条推翻了我原来的打算。

**一、方言已经有向量那一格。** `(vec real 4)`、`(splat T E)`、`(vlit T E…)`、`(lane E N)`、
`(hsum E)`（`tests/sexpr/cases/03-simd.sx`）。也就是说决策一里「将来 SoA 化要给 MIR 加向量」
这件事，在方言这一层**已经有了第一阶段**。这不改变决策一（第一刀仍然一次一个片元），
但它把「以后怎么接」从「要新造一格」变成「要接上已有的那一格」。

**二、`rmath` 的名单比我以为的宽得多，可代价写在明处。**
我原本按 `01-core.sx` 里那句注释以为只有七个（sqrt/fabs/floor/ceil/round/fmod/pow），
于是准备「自己写 sin/cos 多项式」。**读代码发现不是**：`RMATH` 现在有 26 条，
sin/cos/tan/exp/log/atan2/hypot 全在（`sexpr/lower.js:101`），判据是
「C99 math.h 与 ECMA-262 Math 的**交集**」，实现只是转手宿主的库。

代价在 `src/runtime/omni_math.c` 的头注里，是量过的数：20 万个输入上
sin/cos/tan/atan/exp/log 的 120 万个结果里 **51.1 万个位不同**，按 `%.15g` 印出来 31.7 万个
字符串不同；拿 `bc -l`（scale=45）当参考，**libm 与 V8 谁都不是正确舍入**（macOS libm 的 sin
在 400 个输入里 28 个差 1 ULP，V8 22 个，还不是同一批）。

对这条线的意思很直接：**GLSL 那两份尺子重度用 `sin`/`cos`，所以 JS 腿与 C 腿之间
本来就不可能逐字节相同**。这不是我们的实现问题，是宿主数学库的事实。于是：

- 「五条腿逐字节相同」这条纪律对 GLSL 这一路**不适用**，走 `tests/asy/tol/` 那一节的口径
  （腿与腿之间只要求最后一位十进制差不超过 1）——**先例已经有了，不必新立规矩**
- 与决策二正好同向：像素比对本来就是容差的。两处容差是同一个来源

**三、方言的 `real` 是 double，GLSL 的 `float` 是 32 位。** 这是一处**真差别**，写在明处：
llvmpipe 那边整条片元管线是 float32（`lp_bld_type.c` 的 `type.width = 32`），我们按 double 算
再落成 8 位颜色。方向上这只会让我们**更准**，但「更准」在逐像素比对里同样是差别。
所以第三片落地时要顺手量一格：同一份 `FRAG_SIMPLE`，double 算与 float32 算的 8 位输出差几格。
若是 0，这件事就此了结；若不是 0，那就得在算完之后**每一步都截回 float32**（llvmpipe 就是
那样，因为它的向量类型就是 float32）。

### 于是第三片的形状定了

- GLSL 带类型的树 -> **核心方言**（不是直接到 MIR）。理由：JS 与 C 两条腿白得，
  而用户要的正是这两条腿的性能对照。
- `vecN` 拆成 N 个 `real`（决策一：一次一个片元，标量）。**不用方言的 `(vec real 4)`** ——
  那一格是「一次算 4 个片元」用的，不是「一个 vec4」用的。混用会把两件事搅在一起。
- 内建函数走 `rmath`，`fract`/`mix`/`clamp`/`smoothstep`/`length`/`normalize` 这些
  GLSL 特有的在降级里展开成方言的算术（它们都是几行算术，不必是内建）。
- 门的口径：容差，不是逐字节。理由在上面第二条。

## 落地：第一刀第三片 —— 降到核心方言，两条腿都跑起来了

`src/core/frontend-glsl/lower.js`。出来的是**核心方言文本**（与 jnc/asy 同一个出口），
于是 JS 腿与 C 腿一行没写就有了。

四处形状：

**一、每个中间结果都绑一个 `let`（三地址式）。** 不绑的话「一个向量表达式被 N 个分量各用
一次」会把它算 N 遍 —— `vec2(cos(a), sin(a)) * (0.55 + 0.15*sin(u_time+fi))` 里那个标量因子
会被算两次。既错（副作用）又慢，而这条线是要量性能的。

**二、片元着色器编成一个签名定死的函数**：

```
(fn glsl_frag ((frag_x real) (frag_y real) (<uniform 的每一格> real…)) glsl_v4 …)
```

uniform 走**参数**而不是全局 —— 这个函数没有隐藏输入，将来 SoA 化要换的只有参数与返回值的
类型（决策一那两条形状里的第一条）。`gl_FragCoord` 只给 `.xy` 两格真值，`.z`/`.w` 是 0/1
（这一档没有深度、没有透视）。

**三、`vecN` 拆成 N 个 `real`；只有「回向量的函数」用结构体。** 参数是**摊平**的
（`vec2 p` -> `p_0`、`p_1`），因为方言的参数表本来就能有多个；只有返回值躲不开，
于是 `(struct glsl_v3 (c0 real) (c1 real) (c2 real))`，调用处当场拆成 N 格。
一次调用一个 `(new)` —— 将来嫌它慢，办法是把这类函数内联，不是改这一层的形状。

**四、`min`/`max`/`smoothstep` 落成 `let` + `if`。** 方言没有表达式级的条件
（没有 `? :`），所以这三个（以及将来的 `clamp`/`step`）只能是语句。`smoothstep` 照规范 8.3
展开：`t = clamp((x-e0)/(e1-e0), 0, 1); return t*t*(3-2t)`。

### 一处真错误，门当场抓到

`for (int i = 0; …)` 写两遍 —— GLSL 里各是一层作用域，可 `for` 落成方言的 `while` 之后
`(let i_0 …)` 摆在 `while` **外面**，于是同一层里声明了两次，方言当场骂
`'i_0' 在这一层已经声明过了`。修法是局部量名字**一函数一份唯一**（重名的第二个起加个号）。
`bench-complex.frag` 正好有两个 `for`，所以这一格是被尺子逼出来的，不是我想到的。

### 门：`tests/glsl/lower.js` 11/0

- `FRAG_SIMPLE` 在 **JS 腿与 C 腿**上各跑 12 个像素、48 个数，**一致到容差**。
  容差不是逐字节：`cos` 是超越函数，libm 与 V8 在最后一位分叉（量过的数在上一节）。
  口径照 `tests/asy/tol/`。
- 48 个数与**门自己独立算的同一个公式**一致。这**不是 oracle**（真尺子是 llvmpipe）——
  它查的是「降级没有把公式改掉」：少一次乘、swizzle 取错一格、uniform 接错一格，这条都会红。
- `FRAG_COMPLEX`（第一档第二份，含两个 `for`、两个自定义函数、20+10 次 SDF）也跑得动。
- 6 条「还没接的要明着骂」：矩阵、三元、varying、`mix`、`if`、顶点着色器。

### 还缺什么才能与 llvmpipe 比图

这一片只到「一个像素一个函数」。还差：把画布扫一遍（**按 quad**，决策一第二条）、
写 PNG、以及在 llvmpipe 那边跑同一份 shader 取图。前两件是第四片，第三件要一台有 mesa 的
机器（本机是 macOS，`benchmark.py` 那条 surfaceless EGL 路走不通）—— 这一格得先解决，
不然「与 llvmpipe 比」是句空话。

<!-- ADR-0019 第三片-END -->

## 落地：第一刀第四片 —— 把画布按 quad 扫一遍

`glslRenderMain` / `glslProgram`（同一份 `lower.js`）。库 + 这一段 = 一个能跑的方言程序。

**顺序是 llvmpipe 的最内两层**（`lp_bld_interp.c:53-87` 那张图）：一个 2×2 quad 里四个像素
按「左上 右上 左下 右下」，quad 之间按行。为什么现在就要这个顺序（一次明明只算一个片元）：
`dFdx`/`dFdy` 与纹理 LOD 天生要 quad，而 SoA 化就是把这个循环的**内核**换掉 ——
顺序现在定死，将来换内核时图不会变。

宽高不是 2 的倍数时，边上那些格子**照样算、但不印** —— llvmpipe 也是这样（边上的 quad
用掩码丢掉几个像素，而不是缩小 quad）。门里用 6×5 就是为了压这一格。

**印文本不写 PNG**：方言这一层没有文件 IO（只有 `print`），而这是**故意**的 ——
一门中间语言不该长出文件系统。于是一个像素五个 `print`（`x y r g b`），PNG 由外面拼。
代价写在明处：`print` 的开销在小画布上就盖过着色器本身，所以**性能对照不能走这条路**，
那要另一个不印东西的 main（第五片）。

一格实现上的小事，也记着：一个像素五个 `print`，没有拼成一行 —— 方言的 `+` 是「同型相加」，
`int + string` 不在它的规矩里，绕过去只会让这段更难看。

### 门：`tests/glsl/render.js` 5/0

- 6×5 印出 150 个数，30 个像素**每个正好一次**、没有出界的
- 次序**就是** quad 次序（逐个比，不是抽查）
- 30 个像素的 8 位值与门自己算的 `round(clamp(v,0,1)*255)` 相同
- **C 腿与 JS 腿的 8 位像素逐字节相同**。这一条值得单列：`cos` 在两条腿上只到容差
  （上一节那些量过的数），但 8 位那一步把最后一位的差**抹掉了** —— 于是在**像素**这一层
  两条腿反而是逐字节的。这是一个好消息：将来与 llvmpipe 比图时，我们自己这几条腿之间
  不必先谈容差。

<!-- ADR-0019 第四片-END -->

## 还没定的（下一步按这个顺序）

1. ~~摸 mesa 那边的边界~~ —— 「量：读 llvmpipe」那一节。
2. ~~GLSL 接到哪一层 IR~~ —— 决策一。
3. ~~第二片：类型检查与名字解析~~ —— 那一节。
4. ~~第三片：降到核心方言~~ —— 那一节（JS 腿与 C 腿都跑通了）。
5. ~~第四片：把画布扫一遍（按 quad）~~ —— 那一节。PNG 留给外面那一层（方言里没有文件 IO）。
6. **第五片：不印东西的 main**，好量性能（现在这条路上 `print` 盖过着色器本身）。
7. **llvmpipe 那一头怎么取图** —— 本机是 macOS，`benchmark.py` 的 surfaceless EGL 走不通。
   这一格不解决，「与 llvmpipe 比」就是句空话。
8. **像素比对的容差的具体数字** —— 决策二定了量法，数字要等 7 解决。
   好消息是我们自己几条腿之间在**像素**这一层已经是逐字节的（第四片那一条）。




## 为什么先记这一份

按这个项目一贯的做法（第九刀那一百多片都是这样）：**量到的事实先写下来，再动手**。
现在手上确凿的只有 `benchmark.py` 那一份口径与它蕴含的 GLSL 子集，那就只写这些。
mesa 那边一行都还没读 —— 在读之前写任何「决策」都是编的。
