# ADR-0019：GLSL 前端与软件光栅化（复刻 llvmpipe）

状态：刚开始 —— **这一份现在只有尺子，没有决策**

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

## 还没定的（下一步按这个顺序）

1. **读 `pretty_render.py`**：它大概会把子集扩到纹理 / 更多内建，得先知道边界在哪。
2. **摸 mesa 那边的边界**：llvmpipe 里哪些算「复刻目标」——`lp_state_fs.c` 那条片元管线、
   tile（4×4 / 64×64）光栅化、LLVM JIT 出的 shader 变体、`lp_rast.c`；哪些明确不借。
   要像 ADR-0016 对 jancy 那样写清「借什么、不借什么」。
3. **GLSL 接到哪一层 IR**：MIR 已经有线性内存、SIMD 还没有。llvmpipe 的快靠的是
   **一次算 4 或 8 个片元**（SoA + LLVM 的向量类型），所以这一条八成要让 MIR 长出
   向量那一格 —— 那是这条线上最大的一个决定，不能顺手做。
4. **像素比对的口径**：逐字节？还是容差？llvmpipe 自己与硬件就不逐字节相同（`sin`/`cos`
   的实现不同），所以尺子该是 **llvmpipe**、口径大概是「每通道差 ≤ 1」——但要量过再定。

## 为什么先记这一份

按这个项目一贯的做法（第九刀那一百多片都是这样）：**量到的事实先写下来，再动手**。
现在手上确凿的只有 `benchmark.py` 那一份口径与它蕴含的 GLSL 子集，那就只写这些。
mesa 那边一行都还没读 —— 在读之前写任何「决策」都是编的。
