# EVAL 两门语言：**实时、直通 GPU** 的图形那一层

> 这一份说的是 `.pss`（PolyDraw）与 `.kc`（EvalDraw）—— Ken Silverman 那两个工具的脚本语言
> （同一门 EVAL 语言，两张宿主表）。语言本体极小，难的全在**宿主**那一半。
>
> 三条硬要求（用户 2026-09-24 定的口径）：
>
> 1. **全部特性都要实现**。语言本身非常简单 —— 没有"这一版只接一半"的余地。
> 2. **默认直通 OpenGL / WebGL**。我们自己那套 CPU 光栅器（模拟渲染）**只能是备选**，
>    而且要有开关；不许把它当默认。
> 3. **及时性 / 实时性是这两门语言的核心**。它们不是"跑一趟出一张图"的语言 ——
>    宿主每帧调用脚本一次，鼠标、键盘、`numframes`、`klock()` 都是活的。

## 1. 这一层现在错在哪儿

2026-09-24 第一版（`ext/polydraw/gfx-rt.js` + `gl-rt.js`）把设备写成**生成出来的标准 IR**：
帧缓冲是语言里的一格数组，图元是语言里的循环，`refresh()` 落成一格 `(gfxframe …)` 把一帧
字节写出去。三条腿逐字节相同、判据全绿 —— 但它**三条要求全不满足**：

* 默认走的是 CPU 模拟（那正是"只能当备选"的那一档）；
* 一趟只交出一帧 —— 没有帧循环，`mousx` / `bstatus` / `numframes` 全是死的；
* 着色器（`@v` / `@f` 区段）、纹理、`glUniform*` 这一族**根本没有落点**：CPU 光栅器
  不可能跑 GLSL。而 PolyDraw 里最能说明这门语言价值的例子（`ken/gspiral.pss`、
  `tigrou/sphere.pss`）全是可编程管线那一路。

所以这一层要**翻过来**：宿主那一侧才是设备，语言那一侧只发调用。

## 2. 形状：一格 op、一张名字表、三个设备

### 2.1 方言那一层只加**一格** op

    (gfxcall "名字" 实参…)        -> real
    (gfxcalls "名字" 串 实参…)    -> real      ; 带一格字符串的那几个（glsettex / printf …）

宿主 API 的**全部**（画图、矩阵、着色器、纹理、输入、声音）都从这一格过去。理由：

* EVAL 的宿主面就是"名字 + 定数个 double 实参 + 回一个 double"（`polydraw.c:2070` 的
  `myext[]`、`eval.c` 的 `kasm87addext`）—— 一格变长 op 正好装下它，**不必**给方言加
  几十格算子；
* 名字是**字面串**，所以每条腿上的分派是一次查表，不是运行期反射；
* 元数与类型在 adapter 那一侧查（宿主表本来就带元数：`GLVERTEX(,)` 与 `GLVERTEX(,,)`
  是两格），方言这一层只管形状。

`(gfxframe …)`（现有的那格"交出一帧表面"）**留着**：它是 CPU 备选与 `--gfx=surface`
那条离屏出口的落点，也是 jnc/js 那两套 ege 库的出口。

### 2.2 三个设备，同一张名字表

| 设备 | 落在哪儿 | 什么时候是它 |
| --- | --- | --- |
| **WebGL2**（浏览器） | 页面上那格 canvas（`src/studio/studio.js` 里已经有一格 WebGL2 上下文给 glsl 用） | Studio / 单体 HTML 里**默认** |
| **OpenGL**（本机） | `runtime-gl/`（现成的 `libomnigl`，CGL 上下文）+ 一格窗口 | `omni run x.kc` 在有显示的机器上**默认** |
| **CPU 光栅器**（备选） | 现在这份生成出来的 IR 挪进宿主：JS 侧一份、C 侧一份 | `--gfx=cpu`（或 `OMNI_GFX=cpu`）、没有 GL 的机器、**判据**里要逐字节可比的那几格 |

开关一处定：`--gfx=auto|gl|cpu|surface`（默认 `auto` = 有 GL 走 GL、没有回落 CPU 并
**在 stderr 上说一句**）。`surface` 是"跑 N 帧、把最后一帧写成 `#rgba` 表面"——
判据与截图走它。

GL 那两条腿的调用**一对一直通**：`glbegin` → `glBegin`、`glvertex` → `glVertex3d`、
`gluniform1f` → `glUniform1f`。**不重新实现管线**，这是这一刀的全部要点。

### 2.3 着色器与纹理：原文直送

`.pss` 的 `@v:` / `@f:` / `@g:` 区段里是**真 GLSL**。做法是把原文交给驱动编译：

* 本机：`glCreateShader` + `glShaderSource`（桌面 GLSL，原文不改）；
* 浏览器：WebGL2 只吃 GLSL ES 3.00 —— 走**已有的那台转写器**
  （`src/studio/render.js` 的 `glslSource`：把 `330 core` 改成 `300 es`、补 `precision`、
  `gl_FragColor` → `out`）。转不过去的当场报，不静默画错。
* `glsettex(0,"earth.jpg",…)` 读图：本机走 `kplib` 那一族（参考树里有）或我们自己的
  解码；浏览器走 `createImageBitmap` + `texImage2D`。**图片解码不进方言**，是设备的事。

## 3. 实时性：脚本是**每帧一次的函数**

EVAL 的执行模型（`polydraw.c` 的主循环、`evaldraw.txt` 的 "your function is called once
per frame"）：宿主每帧

1. 刷新输入量（`xres/yres/mousx/mousy/bstatus/keystatus[256]/numframes/klock()`）；
2. 调一次脚本的**主函数**；
3. 交换缓冲。

所以编译产物不能是"一趟 main"。**落法（已落地，2026-09-24）**：脚本主体变成一格函数
`eval$frame`，入口只剩一格帧循环 —— 而"还画不画下一帧"**由设备答**：

    (fn eval$frame () real …脚本主体…)
    (main
      …static 的初值（只做一次）…
      (while (!= (gfxcall "nextframe") 0)
        (expr (call eval$frame))))

`nextframe` 那一格在三个设备上各是一件事：

* **离屏 / CPU**：画 `OMNI_FRAMES` 帧（默认 1），每帧末把动过的那一帧交出去（`dirty` 标志
  —— 脚本自己调过 `refresh()` 就不重复写）；
* **本机 OpenGL**：poll 事件 + 交换缓冲 + 刷输入量，窗口没关就回 1 —— **真实时循环**；
* **浏览器（已落地）**：`nextframe` **直接回 0**（产物那条 while 一轮都不转）——
  帧循环在页面这边，见下。

### 浏览器那一档：帧函数交出去，`requestAnimationFrame` 反复调

产物在浏览器里是**主线程同步**跑的（`browser-main.js` 的 `runArgv`），`while` 会把页面卡死。
三条候选（① worker + OffscreenCanvas、② 产物末尾挂 `globalThis.__OMNI_ENTRY`、
③ 把帧函数交给设备）里**选了 ③ 的一个变体**，代价最小：

    (gfxframefn (str "eval$frame"))      ; 名字是**编译期的串**

**不走函数值/闭包那一层**：方言里 `(fnref …)` 落成的是"闭包适配器 + 单件"，让宿主调它
得先摸清那一层的表示；而这一格的名字在编译期就知道，所以**发射那一侧直接把函数引用
交出去**（`Builtin` 上挂 `func`，与 `Call` 同一格字段）——
JS 腿 `$gfx_frame_fn(omni_eval$frame)`、C 腿 `omni_gfx_frame_fn((void *)…)`。
`②` 被否掉的理由是它要改**所有** JS 产物的形状（`tests/js-roundtrip` 整片重生成）；
`①` 的理由是浏览器这侧还没有 worker（热工人池是 node 那侧的），要新开一格。

页面这边（`src/studio/gfx-gl.js` 的 `setFrame`）：每帧 `帧号+1` -> 调那格函数 -> `flush`，
抛了就**停下并把话留在控制台**（不许一帧错一次地刷 —— 真浏览器那条判据判的正是"控制台
零错"）。`stop()` 给换文件与判据收尾用。

**判据要等一次 rAF**：`/api/run` 回来那一刻**还没有画**（踩过一次，判据红成整幅全黑）。

`static` 的落法（EVAL 里 `static` 就是"跨调用留值"）：**模块级的量 + 入口里做一次初值**
（方言的 `(global 名 类型)` 不许带初值）。函数体里的 `static` 也是模块级 ——
`ken/*.pss` 里相机位置与速度全靠它。名字落在同一个平名字空间，所以**两处同名 static
当场报**（要接就按函数名加前缀）。

* Studio 里**编辑就重编**（热工人池那条现成的路，`project_studio_warm_pool.md`）：
  一次编译 15ms 上下，比一帧还短 —— 这正是"实时"的那一半。

输入量在宿主调用那条路上就是**问设备一句**（`(gfxcall "numframes")`）：每帧都可能不一样，
所以不能折成常量。眼下接了 `xres` / `yres` / `numframes` / `klock()`；鼠标与键盘等 GPU
那两档设备把窗口与事件接上（第 3、4 刀）—— 现在接了也没有真来源。

## 4. 全部特性：清单与落点

语言本体（`eval.txt` 是正本，`eval.c` 是判据）——**欠的就三样**，这一轮补完：

* `static` 数组（含多维）+ **越界两档规矩**（长度是 2 的幂时按位与绕回，否则越界一律
  改成下标 0）；
* `goto label;` / `label:`；函数指针形参（`a()` / `a(,)`）；
* `RND` / `NRND`（`eval.c` 里各有一格，照抄 —— 它们是**有状态**的，`SRAND` 要能重置）。

宿主面（两张表，按 `myext[]` 与 `evaldraw_ref.md` 逐项）：

* **2D**：`cls` / `setcol`(1,3) / `setpix` / `moveto` / `lineto` / `drawsph`(3) /
  `drawcone`(6) / `drawpol` / `setfont` / `printnum` / `printf`（画在画布上）/ `refresh`；
* **3D**：`clz` / `setcam` / `drawsph`(4) / `drawcone`(8) / `moveto`/`lineto` 三参 /
  `drawspr`（KV6 体素）/ `drawkv6`；
* **GL 固定管线**：`glclear` / `glbegin` / `glend` / `glvertex`(2,3,4) / `glcolor`(3,4) /
  `glnormal` / `gltexcoord`(2,3,4) / `glpushmatrix` / `glpopmatrix` / `glmultmatrix` /
  `gltranslate` / `glrotate` / `glscale` / `gluperspective` / `glulookat` / `setfov` /
  `gllinewidth` / `glenable` / `gldisable` / `glcullface` / `glblendfunc` / `glquad`；
* **可编程管线**：`glsetshader`(1,2,3) / `glgetuniformloc` / `gluniform{1,2,3,4}{f,i}`(+`v`) /
  `glgetattribloc` / `glvertexattrib{1,2,3,4}f` / `glprogramlocalparam` / `glprogramenvparam`；
* **纹理**：`glsettex`(5 档) / `glgettex` / `glbindtexture` / `glactivetexture` /
  `glcapture`(2 档) / `glcaptureend`；
* **输入与时间**：`xres` / `yres` / `mousx` / `mousy` / `bstatus` / `keystatus[256]` /
  `numframes` / `klock` / `glklockstart` / `glklockelapsed` / `sleep` / `srand` /
  `glswapinterval`；
  > 输入那六格**已落地**（2026-09-24）：读走 `(gfxcall "mousx")` / `(gfxcall "keystatus" k)`，
  > **写走 `(gfxcall "setbstatus" v)` / `(gfxcall "setkeystatus" k v)`** ——
  > `bstatus` 与 `keystatus[k]` 是**脚本写得动的**（`polydraw.txt:381`、`:388` 的
  > "消掉一次点击/一次按键"），别的量赋值当场报。来源：WebGL2 那档是真事件、
  > CPU 那档是 `OMNI_MOUSE` / `OMNI_KEYS`（于是三条腿仍逐字节相同）。
* **杂项**：`rgb` / `rgba` / `noise`(1,2,3) / `printg` / `mountzip`；
* **声音**：`playnote` / `playsound` / `playtext` / `playsong` —— 这一族**明着拒**
  （这台机器上没有落点），报的话要说清是哪一格、口径在哪儿。

> 拒一格与"还没接"是两件事：拒要写清理由（没有宿主能力），还没接要写清下一步。
> 两者都不许静默回 0。

## 5. 判据（不许靠"看上去对"）

1. **语言那一半**：`tests/lower/run.js` 的家族判据照旧（stdout 逐行）—— 与设备无关。
2. **设备那一半**（`OMNI_GFX=host` 那条路，跑固定帧数：`--frame N` / `OMNI_FRAMES`）：
   * CPU 备选那一档：三条腿（js / interp / c）交出的那一帧**逐字节相同**（这条已经在跑，
     PNG 那个默认出口也逐字节相同 —— 编码那一层是 stored，确定的）；
   * GL 那一档：与 CPU 那一档比**结构**（非黑像素数量级、图元覆盖的行列），不比逐字节
     —— 驱动之间本来就不逐字节一致（`project_reference_is_vulkan.md` 那一课）。
3. **实时性**：量三个数并记账 —— 一次重编译的墙上时间、一帧的 CPU 时间、
   连续 60 帧的抖动。目标：重编译 < 30ms、一帧 < 16ms（320×240 那一档）。
4. **真浏览器**：`tests/studio/run.js` 第 4 节里加一格 —— WebGL2 设备开起来、跑 10 帧、
   `readPixels` 回来判不全黑（控制台零错这条已经在判）。

## 6. 刀法（每一刀都能单独判）

1. **`(gfxcall …)` 那格 op** + JS/interp/C 三条腿的分派骨架；CPU 备选挪到宿主侧
   （JS 一份、C 一份），`.kc`/`.pss` 的现有判据保持绿。
2. **帧循环**：产物改成 `eval$frame`，`--gfx=surface --frames=N` 走通；`static` 跨帧。
3. **WebGL2 设备**（浏览器，默认）：固定管线那一族 + 输入量 + rAF 循环 + Studio 里能拖。
   > 已落地：2D 那一族的顶点批、rAF 帧循环（`(gfxframefn …)`）、输入那一族（真事件）、
   > **GL 立即模式**（比 CPU 备选多一样：`glEnable(GL_DEPTH_TEST)` 真开 z 缓冲）、
   > **Studio 那一页点开 `.pss`/`.kc` 按「跑」就是活的 GPU 画布**（只有单体 HTML 那一档 ——
   > `serve` 那一档产物在 node 侧的工人里跑，页面的设备它碰不到）。
   > 还欠：着色器与纹理（第 5、6 刀）。
4. **OpenGL 设备**（本机，默认）：`libomnigl` 加窗口与帧循环。
5. **可编程管线**：`@v`/`@f` 区段直送、`glsetshader` / `gluniform*` / `glvertexattrib*`；
   浏览器走 `glslSource` 转写。
   > 已落地（2026-09-24）：方言加了 `(gfxdef 种类 名字 内容)`（**串只在入口里登记一次**，
   > 运行期照旧全 double）；区段从**原文**切（`drive.js` 把主文件文本按 `src` 递给 adapter）；
   > 设备那一侧有 `glsetshader`(1/2/3) / `glquad` / `glgetuniformloc` / `gluniform{1,2,3,4}f`，
   > 旧式 GLSL 由 `toEs300` 翻成 GLSL ES 300（本机 OpenGL 那一档不必翻）。
   > 还欠：`glvertexattrib*`、几何着色器、`gluniform*v`（数组实参过不了平签名）。
6. **纹理与 KV6**：`glsettex` 那五档、`drawspr`/`drawkv6`。
7. **语言那三样欠账**：`static` 数组两档越界、`goto`、函数指针形参、`RND`/`NRND`。
8. **文字**：`setfont` / `printf` 画在画布上（点阵字体照 `evaldraw.txt` 那一格）。

第一刀落地之前，现有的那套生成 IR 的 CPU 光栅器**照旧留着**（它是备选那一档的实现，
只是搬个地方）—— 判据不许因为换架构断一趟。

## 7. 出口与命令行（PNG 默认、`render`/`view`、性能账）

口径**照 c_impl**（`/Users/wurui/Documents/polydraw/c_impl` 的 `polydraw-render` /
`polydraw-view`，它是"相对正确"的那一份；语义上有分歧仍以 `polydraw_src` 的原始代码为准）。

### 7.1 一帧图的出口：**默认 PNG**，裸表面是备选

* 默认落 `.omni-cache/gfx/frame.png`（8 位 RGBA、filter 0、zlib **stored**）——
  双击能开、`magick compare` 直接吃。**不引 zlib**：stored 那点格式自己写就几十行，
  而且逐字节确定（压缩器换个版本字节就变，那会把"三条腿逐字节相同"毁掉）。
* 落点后缀是 `.rgba` 才走裸表面（`#rgba <w> <h>\n` + `w*h*4` 个字节）——
  程序对程序那一头（`putImageData` / `glTexImage2D`）直接吃裸字节。
* stdout 上永远只有**一行指针**：`#gfx <种类> <路径> <宽> <高>`（`png` / `rgba`）。
* 编码器有四份**同一套字节**：`src/core/host/png.js`（js 与 interp 两条腿）、
  `backend-js/prelude.js` 里一份（产物拿不到模块）、`runtime/omni_fmt.c` 里一份（C 腿）、
  `src/jit/png.c`（宿主工具链，早就有）。页面那侧解码是 `studio/render.js` 的 `pngToRgba`
  （只认我们写的那一档，别的当场报）。

### 7.2 命令行：`--mode render`（默认）/ `view`

```
omni run x.pss                          render：画一帧，落 .omni-cache/gfx/frame.png
omni run x.kc --frame 30 -o out.png     走到第 30 帧、**只交出那一帧**（前 30 帧真跑）
omni run x.kc --w 640 --h 480           画布尺寸（默认 320×240）
omni run x.kc --frame 60 --perf         每帧耗时与 fps 印到 stderr
omni run x.pss --mode view              有窗口地跑 —— **这条腿上还没有**（第 4 刀）
```

* **`render` 模式下 `klock()` 是确定性时钟**：帧号 / 60（照 c_impl 的
  `pdrl_set_clock_scale(ctx, 1/60)`）。离屏出的图要能逐字节比，墙上时间在那儿是噪声。
  `view` 模式才是真墙上时间。
* 这几格旗子落成**环境变量**（`OMNI_GFX_MODE` / `_FRAME` / `_W` / `_H` / `_PERF` / `_OUT`）：
  四条腿唯一都认的口径（C 腿是另一个进程），而且**不进产物缓存的印记** ——
  同一份编好的东西换个旗子再跑就换个行为（与 `.asy` 的出图设置同一条规矩）。
* 给了其中任何一格就把"设备在宿主那一侧"那条路打开（`OMNI_GFX=host`）：
  不打开的话旗子会静默没效果（默认那条路是生成出来的 CPU 光栅器，它只画一帧）。
* `--mode view` 在 node 上**明着报**并指向 `omni serve` 那一页（浏览器 WebGL2 直通 GPU
  就是 view 那一档）；本机窗口是第 4 刀（`--fovy` 那格旗子跟着那一刀一起做 ——
  默认投影的角度在设备里，现在这条腿上没有能读它的设备）。

### 7.3 性能与 fps：两个数，一处量

* `fps` = 每秒**真刷了几帧**（墙上时间）；`ms/帧` = 一帧里**我们**花掉的
  （帧函数 + 上传 + draw call）。第二个才是优化的对象，第一个被 vsync 压着。
* CLI（`--perf`）：一趟结束在 stderr 上印一行
  `#perf gfx render frames=… total=…ms avg=…ms min=…ms max=…ms fps=…`。
  **落 stderr 不落 stdout** —— 那一股上只许有指针行。
* Studio：状态栏那一格后头接上 `· 60.0 fps · 1.3ms/帧`，每半秒结算一次（照
  `polydraw-view` 把 fps 写在窗口标题上那一手）。数从设备来（`gfx-gl.js` 的 `perf()`）——
  这一层不自己计时，不然两处的数会不一样。
* 判据：`tests/studio/run.js` 第 4 节有一格判 `dev.perf()` 真结算出来了
  （fps > 0、每帧耗时是个有限的数）。

## 8. 语言那一半：几格"没有对应概念"的东西怎么落

标准 IR 里没有指针、没有无条件跳转、没有栈上数组。这几格在 adapter 那一层落，
**运行期一格新概念都不加**（口径：`polydraw_src/` 与 `RScript.htm`）。

### 8.1 `&a`：装进一格长度 1 的数组

`eval.txt` 那张形参表的第二态（`&a`）是"改得到调用方"。从前这一格是**静默丢掉的**
（`&x` 当普通的读发下去，被调用的函数改自己那份拷贝）—— 那是最坏的一种错。

现在：凡是**被取过地址**的量都落成一格长度 1 的数组（adapter 里的 `C.boxed`）——
读写走 `x[0]`、实参传那格数组本身、`&a` 形参的类型就是 `(arr real)`。

* 装箱按**函数**算：整份程序那张名单里，本函数按值收的形参不算箱子
  （`demos/planpos.kc` 里 `year` 一处是 `&year`、另一处是 `getday(year,…)` 的值形参）。
* 形参要"那一格"时，装箱的实参直接把箱子递下去 —— 于是 `&` 能一层层传下去。
* 本来就成块的（数组 / 结构体）照旧直接传；`&a[i]` / `&p.x` 与"按值形参上取地址"
  两种当场报 —— 那要一格带偏移的视图，是另一笔账。
* 宿主那一侧的出参不走这条路：`readmouse(&x,&y,&b)` 摊成三句赋值
  （设备本来就有 `mousx`/`mousy`/`bstatus`），宿主面上**不加**能写实参的调用。

### 8.2 `goto` / `label:`：一格旗子

标号那一段里每句外面套 `if (旗子 == 0)`，循环的条件上再 `&& 旗子 == 0`；`goto`
就是置旗，控制流一路退到标号。两个方向各一种包法：

* 往前跳：`旗子=0;` + 前面那段加护卫，标号后面照常降；
* 往后跳：标号到这段末尾包进 `while (旗子) { 旗子=0; …护卫… }`。

代价是那一段里每句多一格判断（只有用了 `goto` 的函数摊这份）。**不接的两格当场报**：
一个标号两个方向都有人跳、`goto` 跳进另一格语句表（`games/kenken.kc:503`）。

### 8.3 `auto`（栈上的量）与结构体

`auto a[N]` 落成声明那一处的一句 `let`（数组是 `(anew N)`），**每趟调用重来**；
初值按运行期算（`RScript.htm` §Init 第三条）。结构体是**一块摊平的 double**
（`a[i].f` = `a[i*格数 + 字段偏移]`），带类型的形参就是把那一块传过去。

### 8.4 宿主面的平签名：**十二格** double

`omni_gfx_call(名字, 个数, a0..a11)` —— 元数最大的是 `setcam`（位置 3 格 + 三个方向
各 3 格）。四处一起改才算一刀：`sexpr/lower.js` 的闸、backend-c 补零、LLVM 的参数表、
`omni_fmt.c` / `omni.h` 的签名。

### 8.5 串那一族（下一刀的设计，还没做）

口径是 `RScript.htm` 的 "String support" 那五条：串变量**必须是 static**（没有局部串）、
**本质上是串指针**（赋一格字面量或另一格串变量）、能出现在任何收字面量的地方、
可以有**串数组**（`static dayoweek[7] = {" \hSUN", …}`，`geeky/calend.kc:100`）、
除赋值以外的运算没有。

落法（三段，一段一格判据）：

1. **串就是一格下标**。字面量已经在内部表里（`internStr` + 入口里发的
   `(gfxdef "name" …)`），所以"串变量"= 一格 double 装着那个下标、"串数组"= 普通
   `(arr real)` 装着下标。宿主调用那一侧**一格都不用改**（它本来就收下标）。
2. **哪些名字是串**：adapter 按初值判（`static x = "…"` / 初值表里有串）。
   一个名字要么一直是串要么一直是数 —— 混着用当场报（`RScript.htm` 也不许）。
3. **`printf` 要一台运行期的格式机**。`rscr_strings.kc` 是最狠的一格：格式串本身是
   变量（`fmt = "You %s a%s %s.\n"`），`%s` 的实参也是串变量。现在那台机器
   （`lower/fmt.js`）是**编译期**的，读不了运行期的格式串。所以要**生成一格函数**
   （像 `pd_fact`/`pd_rnd` 那样落在产物里）：
   * 串表：入口里填一格 `(arr string)`，`pd_str(i)` 取第 i 格；
   * `pd_printf(fmt, 掩码, n, a0..a7)`：拿 `slen`/`ssub` 一个字符一个字符走格式串，
     数走 `sfix`/`ssci`/`sgen`（方言里都有），串走 `pd_str(下标)`。
     掩码是**编译期**算出来的（哪几格实参是串）—— 于是运行期不必猜类型。
   * 判据：`geeky/calend.kc`（串数组 + 定串格式）与 `geeky/rscr_strings.kc`
     （运行期格式串 + 三个 `%s`）两份，三条腿逐字节相同。

这一刀之前，凡是"串进了 printf 的实参/格式"的脚本都**当场报**，不静默印下标。

## 9. **只有一个模型**：命令 -> 顶点批 -> 几个 draw call

2026-09-24 用户定的一条硬口径（推翻了"本机那一档把 `glvertex` 原样转发给驱动的立即模式"
那个草案）：

> `glvertex` 我们**绝对不要硬件对应**。必须与 WebGL 那一档**同一个模型**，不允许存在
> 两种模型。这也是 `c_impl` 用 **gl cmd** 自己接、并且**批量**的原因。

参考实现那一侧的做法就是这样（`c_impl/src/render/glcmd.h` 第一行："record immediate-mode
GL calls into a flat command buffer"）：立即模式的调用先记进一条平的命令流，渲染器再
**合批**成少数几个 draw call。我们这边 WebGL2 那一档也是这个模型（顶点攒成段、
`refresh`/帧末一次上传 + 一两个 `drawArrays`）。

**所以本机 OpenGL 那一档不是"另写一份渲染器"，而是同一个模型换一个出口。** 为了不出现
第二份实现（"复用 > 第二份实现"），这一层的分界线重画成：

### 9.1 谁做什么

* **语言那一侧（生成出来的 IR，`ext/polydraw/gl-rt.js` + `gfx-rt.js`，跑在每条腿上）**
  —— 做全部"与设备无关"的事：矩阵栈与变换、`glbegin` 那十格 mode 的拆法、
  `w<=0` 丢顶点、2D 图元变顶点（圆 = 三角扇、`drawcone` = 两端圆 + 公切四边形）、
  **合批**（段的键：图元类 / 深度测试 / 哪格 program / 常量属性的版本）。
  一格顶点仍是**12 个 float**（位置 4 / 颜色 4 / 纹理坐标 4）。
  这一半只有**一份**实现，js / interp / c / 原生四条腿跑的是同一份。
* **设备那一侧**（WebGL2、本机 OpenGL、CPU 备选）—— 只做四件事：
  1. 收一段顶点批：上传 + 一次 `drawArrays`（CPU 备选那一档是软件光栅化同一批顶点）；
  2. 着色器：拿原文编 program（`(gfxdef …)` 那一格已经把原文送过来了）；
  3. 纹理、FBO / canvas、读回一帧；
  4. 查询与输入（`xres`/`klock`/`mousx`/`nextframe` …）。

### 9.2 顶点批怎么过去（方言里再加**一格** op）

    (gfxbatch 类 数 (arr real))   -> real

`类`是段的种类（0=线、1=三角、…），`数`是这一段有几个顶点，数组是 12·数 个 float
（照 `(gfxframe …)` 那一格的先例：数组能过去，double 参数过不去数组）。
段的状态（program、mvp、深度、常量属性）在这一格之前用普通 `(gfxcall …)` 摆好 ——
于是运行期的形状仍然是"几格 gfxcall + 一格 gfxbatch"，而不是每个顶点一次调用。

**这一格 op 也是性能那一轴的落点**：`tigrou/disco ball.pss` 每帧 16.4 万次宿主调用
（61.9 万个 `glbegin/glend` 对）—— 合批之后跨设备边界的调用降到"段数"这个量级。
他们量到"约两万 draw call、要 instancing 但没做"，我们这一档从一开始就是合批的。

### 9.3 刀法（每一刀单独能判）

1. `(gfxbatch …)` 那格 op：方言 + 四条腿 + 三档设备的骨架（顶点契约写在这儿）；
2. `gfx-rt.js` 的 2D 那一族从"写帧缓冲"改成"出顶点批"，CPU 备选那一档改成
   "收顶点批再软件光栅化" —— 判据：`draw2d.kc` 三条腿仍逐字节相同；
3. `gl-rt.js` 的 GL 那一族同样改口（变换与拆 mode 留着，rasterize 换成出批）
   —— 判据：`02-gl.pss` 三条腿仍逐字节相同；
4. WebGL2 那一档砍掉自己那半变换与合批，改成收批（浏览器判据不变）；
5. 本机 OpenGL 设备（`runtime-gl/omni_evgl.c`，**core profile + VBO**，不碰立即模式）：
   收批 + 编 program + FBO + 读回 —— 判据：`--gfx gl` 出的 PNG 与 CPU 备选那一档
   结构一致（像素容差，跨渲染器不逐字节），GLSL 那几份（`24_shader_hello.pss`、
   `tigrou/fractal.pss`）真编真画。
6. 纹理那一族（`glsettex` + `drawspr`）：数组实参走同一格 `(gfxbatch …)` 的办法
   （`(gfxtex 槽 宽 高 (arr real))`）。

**不许出现的东西**（写在这儿免得再走回头路）：本机那一档的立即模式（`glBegin`/`glVertex`
转发给驱动）、两份变换/合批逻辑、"某一档设备自己多一套语义"。

### 9.4 第四刀（**已落地** 2026-09-24）：批带上状态，着色器那一族并进同一条路

从前还剩一格**过渡开关**（`adapter.js` 的 `usesShaderGL`）：用了着色器的脚本走
"GL 名字原样交给设备"那条老路。原因是两种顶点空间：

* 内建那对着色器（2D 与固定管线）收的是**裁剪空间** —— 语言那一侧已经乘过矩阵；
* 脚本自己那格顶点着色器收的是**物体坐标** —— 变换是它自己做的（`ftransform()`），
  `u_mvp` 由设备喂。

于是"批"上带一格状态说清位置是哪一种。落法（`(gfxcall …)` 摆状态、`(gfxbatch …)` 交批）：

    (gfxcall "batchprog" p)                 p = 0 内建（裁剪空间）；≠0 脚本那格 program（物体坐标）
    (gfxcall "batchmvp" 列 m0 m1 m2 m3)     四句一张 u_mvp（列主序，只在 p≠0 时发）
    (gfxcall "batchblend" mode)             0 = alpha 混合、别的不透明（glquad(mode) 那一格）
    (gfxcall "gldepth" 0|1)                 深度测试

语言那一侧（`gl-rt.js` 新的 `glShaderDecls()`）：`glsetshader` / `gluniform*` /
`glvertexattrib*` / `glgetuniformloc` / `glgetattribloc` 都是**按 draw call 生效**的状态，
所以每一格先 `gl_flush()` 再原样转给设备；`gl_prog != 0` 之后 `gl_vertex4` 存**物体坐标**
（不乘矩阵、也不丢 `w<=0` —— 裁剪交给 GPU），`gl_flush` 先发四句 `batchmvp`
（`gl_mp = gl_pj · gl_mv`）。`glTexCoord` 也落在这一层（顶点的第 9..12 格）。

**`glquad(mode)` 的六个顶点也在语言这一侧造**（位置就是 NDC、纹理坐标 0..1）——
设备自己造一份满屏几何就是第二个模型了。它那一趟的 `u_mvp` 是单位矩阵：`gl_qid` 说。
脚本只写了 `@v`/`@f` 却没调 `glsetshader` 时发 `(gfxcall "glsetshader" -1)`
= "拿第一对"（PolyDraw 里 `glquad` 本来就是这个默认）。

设备那一侧：WebGL2 那一档的批多带三格（`prog`/`mvpVer`/`blend`，任一格变就断段），
`batchIn` 在 `prog≠0` 时**原样**把物体坐标递进去；CPU 备选那两份（JS 与 C）在
`batchprog p≠0` 时**当场报**（没有可编程管线，不静默按内建那对画）。

判据：`tests/studio/run.js` 里着色器那两条（`04-shader.pss` 的 `@v`/`@f` + `glsetshader`
+ uniform + `glquad`、`05-shader-geom.pss` 的着色器 + 立即模式几何 + `u_mvp`）——
真浏览器、判像素，全绿。`usesShaderGL` 已经删掉。

**第二份模型删掉了**（同一刀的后半）：EvalDraw 那张宿主表也加了 `glrt`（GL 那个子集
两门共用 `gl-rt.js` 的同一份 —— 只取名字以 `gl` 打头的那几格，`setfov`/`framebegin`/`rgb`
在 EvalDraw 里是别的东西），于是 WebGL2 设备里那两百来行自己的立即模式
（`glVertex`/`glEnd`/`glXf`/`mvMul`/`mvpNow`/`frameBegin`/`perspectiveT`/矩阵栈 +
十来格 `case`）整段删掉。设备那一层的 GL 现在只剩三样：深度测试、常量属性、
program 与 uniform —— 全是"只有设备做得到"的东西。`glquad` 的那份满屏 buffer 也删了。

**常量属性**（`glVertexAttrib*`）没有单开一格 `batchattr`：设备那一侧本来就按
"位置 -> 四个数 + 版本号"记着（`G.attrs`/`attrVer`，值一变就断段），语言那一侧只要
先 `gl_flush()` 再把那句原样转过去就够了 —— 少一格 op。

## 10. 宿主面按**份数**补齐（`--gfx host` 那把尺子）

`node tests/eval/scan.js --gfx host` 量的是"这份脚本**真出得来 PNG** 没有"。
2026-09-24 那一趟：**44 / 228**，缺口按名字排（前几名）：

    19  clz          清 z 缓冲（3D 那一族）          -> CPU 备选收下记着不用（没有 z）✓
    16  glsettex     纹理那一族（任务 #26）
    13  framebegin   每帧初态                        -> CPU 备选清画布 ✓
    13  setfont      画布文字（任务 #28）
     7  glcapture    把画布读回一格纹理
     7  noise        噪声（见下）
     7  glquad       满屏四边形（着色器那一档）
     5  drawcone     三维那一档的元数（8 参）
     5  playsound / playtext / playnote  声音

### 10.1 `noise` / `noise3d`：**有正本，照抄成生成出来的 IR**

`polydraw_src/polydraw.c:852-960` 是 Tom Dobrowolski 的噪声（`fgrad` 那张 16 格梯度表 +
`noise1d/2d/3d` 的三线性插值 + `t = (3-2p)p²` 的平滑）。这一族是**纯函数**，所以落成
**生成出来的 IR**（像 `pd_rnd`/`pd_fact` 那样）而不是设备的一格 —— 四条腿逐字节相同，
也不必给每档设备各写一份。

置换表 `noisep[512]` 是 `noiseinit()`（`polydraw.c:3538` 开机时调一次）用 **C 库的
`rand()`** 洗出来的，与脚本能看见的 `SRAND` 无关。MSVC 的 `rand()` 正是我们 `pd_rnd`
已经照抄的那台 LCG（`seed = seed*214013 + 2531011`、取 `(seed>>16)&0x7fff`，起始 1），
所以这张表能**一位不差**地重算出来：入口里发一格 `pd_noiseinit()` 填它。

两处**明写的偏差**（照不到的地方不装作照到）：
* 原版中间量是 `float`，我们是 `double` —— 值差在 1e-7 量级，图上看不出来；
* `dtol()` 在 MSVC 上是 `fistp`（就近偶数），我们用 `floor(x+0.5)`（就近、遇 .5 往上）。
  非 Windows 上原版那一格本身是坏的（`a = (int)f;` 写到了指针变量上），所以没有"另一份
  正确答案"可对。

## 11. 纹理那一族（第六刀的设计）

`--gfx null` 那把尺子上现在最大的一格红是**数组进不了宿主面**：

    (gfxcall "glsettex" 1 buf 256 256 KGL_BGRA32)
    -> error: 实参要是 real（宿主面只收 double），这里是 arr<real>

`ken/texture.pss`、`tigrou/metaballs.pss`、`examples/opengl/26_texture_procedural.pss`
都死在这一句上。宿主面是**平的**（一串 double），所以数组要走**另一格 op** ——
与 `(gfxbatch …)` 同一手。

### 11.1 方言里再加**一格** op

    (gfxtex 槽 宽 高 层 格 (arr real))      -> real（回 0）

* **槽**：脚本自己编号的纹理（`glbindtexture(槽)` 用的就是它）；
* **层**：3D 纹理那一档（`GLSETTEX(,&,,,,)`，语料里 4 处），2D 就是 1；
* **格**：`KGL_*` 那个打包好的数（`polydraw.c:190-193`）——
  低 4 位是像素格式（`BGRA32=0` / `CHAR` / `SHORT` / `INT` / `FLOAT` / `VEC4`）、
  `0xf0` 那一档是过滤（`LINEAR`/`NEAREST`/`MIPMAP*`）、`0xf00` 是环绕
  （`REPEAT`/`MIRRORED_REPEAT`/`CLAMP`/`CLAMP_TO_EDGE`）。**这三段照抄原版的位定义**，
  不自己编号（脚本里写的是 `KGL_BGRA32+KGL_NEAREST`，值必须与原版同一个）。
* 一格像素占几个 double 照原版 `evalvalperpix`：`VEC4` 是 4 个、别的都是 1 个
  （`BGRA32` 那一格是打包好的 `0xRRGGBB`，与 `rgb()` 回的那种数同一形）。

宿主表那一侧（`myext[]:2166-2171`）六种写法各自落在哪儿。**最后一格总是 coltype** ——
4 个实参那一档是**一维**纹理（`kglsettexarray1`：ysiz=zsiz=1），不是 (宽,高)：

    GLSETTEX(,$)      (槽, "文件")                -> 文件那一档：**这一版明着拒**（见 11.3）
    GLSETTEX(,$,)     (槽, "文件", 格)             -> 同上
    GLSETTEX(,&,,)    (槽, 数组, 宽, 格)            -> (gfxtex 槽 宽 1 1 格 数组)
    GLSETTEX(,&,,,)   (槽, 数组, 宽, 高, 格)         -> (gfxtex 槽 宽 高 1 格 数组)
    GLSETTEX(,&,,,,)  (槽, 数组, 宽, 高, 层, 格)      -> (gfxtex 槽 宽 高 层 格 数组)
    GLGETTEX(,&,,,)   读回                        -> 第六刀的后半（要"设备写回数组"那条路）

`glbindtexture(槽)` / `glactivetexture(GL_TEXTURE0+i)` 是**设备状态**：语言那一侧先
`gl_flush()`（状态一变就断批）再原样转给设备，与 `glsetshader` 那一格同一手。

### 11.2 设备那三档各自做什么

* **WebGL2**（默认）：`gfxtex` -> `texImage2D`。BGRA 在 WebGL 里没有，所以
  `BGRA32` 那一格**在上传前换成 RGBA**（一次 `Uint8Array` 走一趟，格式转换是设备的事）；
  `FLOAT`/`VEC4` 走 `R32F`/`RGBA32F`（WebGL2 本来就有）。过滤与环绕照那三段位设。
  采样器按**名字约定**接：program 链好之后把 `tex0..tex7` 那几个 uniform 设成 0..7 号
  纹理单元 —— PolyDraw 的脚本正是 `glactivetexture(GL_TEXTURE0+i); glbindtexture(i)`
  加片元里 `uniform sampler2D tex0, tex1, tex2`，没有别的绑定办法。
* **本机 OpenGL**（第五刀）：直接 `glTexImage2D`，BGRA 真有，不必换。
* **CPU 备选**（JS 与 C 两份）：**收下存着**（一张表：槽 -> 宽高格 + 一份数据）。
  这一档没有着色器，所以纹理只在"以后接了 2D 贴图"时有用 —— 现在存下来但画不出，
  这一点明写在错里：`glbindtexture` 之后要是真有人采样，那是着色器那一族，已经在
  `batchprog` 那一格当场报了。

### 11.3 文件那一档为什么先拒

`glsettex(0,"earth.jpg")`（语料里 7 处 + EvalDraw 那 50 多处 `glsettex("cloud.png")`）
要**解码 JPG/PNG**。我们这一侧有的只有 PNG 的**写**（`host/png.js`），没有解码器；
浏览器那一档能用 `createImageBitmap`，但那是**异步**的，而脚本的 `glsettex` 是一句
同步调用 —— 要接就得先有"帧函数之前先把资源准备好"那一层。所以这一刀先把**数组那三档**
接通（判据能钉住的那一半），文件那一档当场报一句说清"是哪一格没有"，记在任务里。
