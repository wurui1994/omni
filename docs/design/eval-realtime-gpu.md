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

> **落地之后的对照**（2026-09-24，正本在 §13）：旗子实际是 `--gfx host|gl|ir|null`
> 四档 —— `host`（设备在宿主，CPU 备选 + 那格帧缓冲，默认）、`gl`（本机 OpenGL：
> 离屏 core profile，挂不上就回落 host 并在 stderr 上印一行 `#gfx gl …`）、
> `ir`（产物自带光栅器）、`null`（只记账不画，量语言那一半用）。
> 上面那张表里"本机 OpenGL = 默认 + 一格窗口"还没到：现在是**离屏出一帧 PNG**，
> 窗口那一格在任务 #17。GLSL 也不是"原文直送"了 —— **编译期翻成对齐后的 GLSL**（§13.2/§13.7）。

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

### 8.6 `&a[i]` / `&p.x`：**一格伴随的偏移形参**

`--gfx null` 那把尺子上第二大的一格红是 `&` 的另外两种写法（9 份 `.kc`）：

    quicksort(&a[0],j0); quicksort(&a[j1],n-j1);     geeky/sorttest.kc:145
    bufcpy(&buf0[1],&buf1[0],BUFSIZ-2);              geeky/buf_speed_tests.kc:101
    getlgs(&lgs.krnd);                               games/magpong.kc

前两种**不是"一格标量的出参"**，是**从第 i 格起的那一段**（快排的递归、`bufcpy` 的两端）。
标准 IR 里没有"带偏移的视图"，而 EVAL 里数组本来就是一段 double —— 视图就是 `(基, 起点)`
两个数。所以落法是：**每个收整块的形参后头跟一格偏移形参**（`名字$o`，real）。

    被调用方   f(&a) / f(&a[i]) / f(&p.x)  ->  (fn f ((a (arr real)) (a$o real) …))
    函数体里   a[j]                        ->  a[a$o + j]
    调用点     &a       -> (a, 0)
               &a[i]    -> (a, 那一格的摊平下标)
               &p.x     -> (p, 字段偏移)       ← `fieldRef` 算出来的正是这个数
               a（整块往下传）-> (a, a$o)

为什么不加一格方言的 op（`(aview A 起)`）：那要让**四条腿**的 `(arr real)` 都能"共享存储的
视图"——C 那侧是 `{len-off, items+off}` 一行就行，JS 那侧的数组是普通 Array，做不到共享，
只能整套换成 `Float64Array` + 两个字段。偏移形参这一手只动这一门语言的 adapter，
**四条腿一个字都不用改**，而且语义是精确的（不拷贝、别名照旧共享）。

代价写明白：形参个数翻倍（只对收整块的那几个）、`&a[i]` 之后**越界那一夹按基数组算**
（EVAL 原版也是照整块夹的，见 `eval.txt` 的 "Variables & arrays"）。

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
`--gfx null` 那一档只量语言那一半（设备认所有名字、只记账）。

    2026-09-24 全量那一趟（`--budget 600 --timeout 10`，228 份）：
      语言那一半（--gfx null）  129 / 228   （.pss 74/86、.kc 55/142）
      设备那一半（--gfx host）   48 / 228   （GL 那 39 份出得来图那一趟之后）

剩下的账（按份数排，`--gfx null` 那一趟）：10 超时（算得久，不是坏）、
9 份 `&a[i]`/`&p.x`（`&` 只接名字，任务 #27）、5 份纹理的**文件与 EvalDraw 写法**
（`glsettex("cloud.png")` / `glsettex(buf,宽,高)` —— 见 11.3）、3 份 `frameinit`
（EvalDraw 的"开机跑一次"那格函数）、2 份往前跳的 `goto`、零零碎碎十几格宿主名字。

缺口按名字排（前几名，`--gfx host` 那一趟）：

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

## 12. "大部分脚本真能出图"这件事：现在靠什么、偏差在哪儿

用户 2026-09-24 的口径：**先让大部分 `.pss` / `.kc` 出得来图**，别一格一格磨。所以这一刀
（第七刀）做的是三件事，落点都在"语言这一侧 + CPU 备选那一档"：

1. **3D 那一族在语言侧投影成 2D**（`ext/polydraw/gfx3-rt.js`）。语料里 `.kc` 的主力就是
   它：`drawcone` 357 次、`drawsph` 195、`setcam` 47、`clz` 48。投影是纯算术 ⇒ 按"只有
   一个模型"放在语言这一侧，设备只收投影完的 2D 图元。
2. **声音那一族收下不响**（`playsound`/`playtext`/`playsong`/`playnote`，语料 500 多次）。
3. **纹理/贴图/画布文字那几族在 CPU 备选里收下不用**（`glsettex` 六档、`drawspr`、
   `drawkv6`、`setfont`、`printg` …）。

配上默认设备从 `ir` 换成 `host`（`gfxMode()`），于是"几何能画出来"的脚本就真出 PNG 了。

### 12.1 明写的偏差（**不装作照到**）

| 那一族 | 我们现在画的 | 原版 |
| --- | --- | --- |
| `drawsph(x,y,z,r)` | 投影后的**平色圆**（半径 `r/z*hz`） | 带光照与 z 缓冲的实心球 |
| `drawcone(8 参)` | 两端投影后的 **2D 粗线** | 带光照的锥/胶囊 |
| `clz(d)` | 收下不用（**没有 z 缓冲**，后画的盖前画的） | 软件 z 缓冲 |
| `setcam(5 参)` | 三个向量按我们定的那一套算（见 `gfx3-rt.js` 头注） | 只给了"hang 水平、vang 垂直" |
| 纹理与贴图 | 收下不用（图上缺贴图） | 真采样 |
| 画布文字 | 收下不用（图上缺文字） | 位图字模 |
| 声音 | 收下不响 | 真出声 |
| 着色器（`@v`/`@f` + `glquad`） | **当场报**（`batchprog` 那一格） | 真 GPU |

**为什么"收下"而不是"报"**：这些脚本的主体是几何，贴图与文字是点缀 —— 报了整份图都
出不来，收下则"图能出、少了点缀"。而着色器那一族反过来：它就是整幅图本身，缺了它画面
是**错的**，所以仍然当场报，等第五刀（本机 OpenGL 设备）。

### 12.2 下一刀该做什么（按份数）

* **本机 OpenGL 设备**（第五刀，任务 #24）：`.pss` 那 39 份着色器脚本 + 真 z 缓冲与贴图；
* **画布文字**（`setfont`/`printg`，178 次）：一份 8×8 字模就能让那一族真出字；
* **z 缓冲**（`clz` + `drawsph`/`drawcone` 的深度）：CPU 备选加一块 z 缓冲，3D 的遮挡才对；
* **文件纹理**（`glsettex("x.png")`）：要解码器 + "帧函数之前先备好资源"那一层（见 11.3）。

## 13. 第五刀的设计：**本机 OpenGL 设备**（命令行那一档的 GPU）

### 13.1 为什么必须做

出图那把尺子上最后一块大的是**着色器那一族 22 份**（`glsetshader` 13 / `glgetuniformloc` 5 /
`glquad` 4）。它与贴图、文字不同 —— 它**就是整幅图本身**，缺了它画面是错的，所以 CPU 备选
那一档只能当场报（第 12 节那张表的最后一行）。浏览器那一档早就通了
（`tests/studio/run.js` 74/74），**只有命令行没有 GPU**。

`--gfx browser`（借 headless 浏览器出图）评估过：要外部 `playwright-cli`、每趟起浏览器
几十秒、还得把产物塞进页面 —— 不划算，不做。

### 13.2 **必须与 WebGL 对齐**（2026-09-24 用户定的，写在最前头）

**不许用 legacy OpenGL。** 上下文一律 **core profile**（macOS 上
`kCGLOGLPVersion_3_2_Core`，Apple Silicon 给到 4.1 core），内建那对着色器与
`src/studio/gfx-gl.js` 里 WebGL2 那一档**逐句对应**（`in`/`out`、自己声明的 `o_col`、
`u_mvp` 由设备喂），差的只有 `#version` 那一行。

连带的一条口径（不然就成了两种模型）：脚本里那些**旧式 GLSL**
（`attribute` / `varying` / `gl_FragColor` / `ftransform()`）**不在设备里翻** ——
在**编译期**翻（adapter 那一侧、`(gfxdef …)` 把原文发出去之前），于是两档设备收到的是
**同一份文本**。翻译那一份现在还在 `gfx-gl.js` 的 `toEs300` 里（浏览器那一档私有），
第五刀的后半要把它挪到公共位置：

    编译期翻好的主体        ->  两档设备共用
    浏览器那一档补 #version 300 es + precision
    本机那一档补 #version 410 core

曾经试过 legacy 2.1（驱动直接吃旧式 GLSL、省掉翻译）—— **被否**：那等于本机这一档
自己一套语义，正是"不允许存在两种模型"那条规矩要挡住的东西。

### 13.3 形状：**一份 `.dylib`，dlopen 挂上去**

    src/runtime-gl/omni_evgl.c     ->  libomnigl_ev.dylib
    宿主面：omni_gfx_call / omni_gfx_batch / omni_gfx_tex 三格转发给它

复用 asy 那条腿已经踩平的三件事（`project_gl_backend_live.md`）：
* **上下文用 CGL 不用 GLFW**（我们跑在大栈线程上，`glfwInit` 会 SIGTRAP）；
* 画到 **FBO**（离屏）再 `glReadPixels` 回来 —— 命令行那一档要的是一帧 PNG，不是窗口；
* `.dylib` 用 `dlopen` 挂：主二进制不链 OpenGL，**没有 GPU 的机器照旧跑 CPU 备选**。

### 13.4 设备那一侧要实现的（**与 WebGL2 那一档同一套名字**）

    收批      (gfxbatch 类 数 顶点) -> VBO + 一次 glDrawArrays（core profile，不碰立即模式）
    批的状态  batchprog / batchmvp / batchblend / gldepth
    program   glsetshader（**收到的已是编译期翻好的对齐 GLSL**，这一档只补 `#version 410 core`）
    uniform   glgetuniformloc / gluniform{1,2,3,4}f / glgetattribloc / glvertexattrib*f
    纹理      (gfxtex 槽 宽 高 层 格 数组)（BGRA 真有，不必摊成 RGBA）+ glbindtexture/glactivetexture
    2D 那一族 cls/setcol/setpix/moveto/lineto/drawsph/drawcone（**已经在语言侧变顶点了**，
              所以这一档只要收批 —— 一个字都不用另写）
    查询与输入 xres/yres/klock/numframes/mousx/mousy/bstatus/keystatus（离屏那一档输入照
              CPU 备选那一手：环境变量）

**一个字都不许有的东西**：立即模式转发、第二份变换/合批、只有这一档才有的语义。

### 13.5 判据（**跨渲染器不逐字节**）

1. `tests/build` 那一层：`.dylib` 编得出来、`dlopen` 挂得上（没有 GPU 的机器跳过）；
2. `02-gl.pss` / `draw2d.kc` 用 `--gfx gl` 出的 PNG 与 CPU 备选那一档**结构一致**
   （非黑格数 ±5%、几个探针像素 ±40）—— 口径与 WebGL2 那一档那条判据一样；
3. **着色器那三份**（`04-shader.pss` / `05-shader-geom.pss` / `06-texture.pss`）在这一档
   真编真画：判的是"铺满 + 片元真在算 + uniform 真喂进去"那三条（与浏览器那条同一套探针）；
4. 语料尺子：`node tests/eval/scan.js --gfx gl` 的份数 **要比 `--gfx host` 多 20 份以上**。

### 13.6 已落地（2026-09-24）：**离屏 core profile 上下文 + 收批 + 读回**

`src/runtime-gl/omni_ev_gl.c`（新）导出六格 C ABI：

    omni_ev_gl_open(w,h) / _cls(rgb) / _depth(on) / _batch(类,数,顶点) / _read(rgba) / _error()

里头是 CGL core profile + RGBA8/DEPTH24 的 FBO + 一格 VAO + 一格 VBO + 内建那对着色器
（与 WebGL2 那一档逐句对应）。顶点契约与别的两档同一格：一格 12 个 double
（位置 4 **裁剪空间** / 颜色 4 / 纹理坐标 4），类 0 线段 / 1 三角 / 2 点。

判据 `tests/gl/run.js`：编插件 + `dlopen` + 画一个裁剪空间的红三角读回来 ——
**红 9600 / 背景 67200**（320×240 里三角占 1/8，那两个数是算出来的，所以它同时钉住
"顶点是裁剪空间"这条契约）。没有 `OpenGL.framework` 就整份跳过。

**一个坑记在这儿**：core profile 里**没有默认 VAO** —— 不绑一格就 `INVALID_OPERATION`，
画面全黑而且一行错都没有。

下一步（第五刀的后半）：`cli.js` 的 `glPlugin()` 把这一份也编进 `libomnigl.dylib`、
`omni_fmt.c` 在 `OMNI_GFX=gl` 时把 cls/gldepth/批/读回转过去、翻译挪到公共位置、
program 与纹理接上（那时着色器那 22 份就出得来图了）。

### 13.7 已落地（2026-09-24）：**GLSL 翻译挪到编译期**（13.2 那条口径的落实）

翻译那一份从 `gfx-gl.js` 私有的 `toEs300` 挪到 **`ext/polydraw/glsl.js`** 的
`glslAlign(kind, src)`，在 **adapter 里、`(gfxdef …)` 发出去之前**就翻好：

    attribute            -> in
    varying              -> out（顶点）/ in（片元）
    gl_Vertex            -> a_pos          gl_MultiTexCoord0 -> a_tex
    gl_Color             -> a_col / v_col0 ftransform()      -> (u_mvp * a_pos)
    gl_TexCoord[0]       -> v_tex0         gl_FragColor      -> o_col
    texture2D(           -> texture(       用到的名字在头部补声明

两档设备于是收到**同一份文本**，各自只补一行：浏览器 `#version 300 es` + precision、
本机 `#version 410 core`。脚本自带 `#version` 的原样放过（作者自己对齐了）。

**连带的一格判据口径**：`tests/studio/run.js` 里三处显式 `OMNI_GFX=ir`
（本地参照、浏览器腿、第 3 节那个 probe）—— 那几条判的是"产物自带光栅器"那一档，
从前靠"默认恰好是 ir"，默认换成 host 之后就假红了。默认值不是判据，写明才是。

### 13.8 已落地（2026-09-24）：**转发那一层**（`OMNI_GFX=gl`）

    cli.js glPlugin()      两份源码一份 dylib（omni_r3_gl.c + omni_ev_gl.c，各自 dlsym 自己的符号）
    omni_fmt.c  OMNI_GFX=gl  dlopen（OMNI_GL_LIB） -> 六格函数指针 -> open(w,h)
                 cls / framebegin / gldepth / (gfxbatch …)   转发
                 别的名字                                    照旧走 CPU 备选（查询/帧循环/输入/2D）
                 present   _read(rgba) -> 与宿主那一层合成 -> 同一个 PNG 出口

三条定下来的：
* **挂不上就回落**（与 `omni_r3.c` 那侧同一手）：没有 `OpenGL.framework`、编不过、
  `open` 回非 0 —— 一律退回 CPU 备选并在 stderr 上印一行 `#gfx gl …`。
  `OMNI_GFX=gl` 是"想要"，不是"必须"；
* **两层合成**：GPU 画顶点批，`setpix`/`lineto`/`drawsph` 那一族仍落在宿主那格帧缓冲上
  （语言那一侧没把它们变顶点）。所以 GL 开着时宿主那格的初值是 **-1 = 这一格没人画**，
  交帧时 GPU 那一层当底、宿主那一层盖上去。连带一格：`getpix` 读到 -1 回背景 0
  （不为一次查询去 `glReadPixels` 一整帧）；
* **一帧一次读回**：`_read` 里是 `glFinish` + `glReadPixels`，同步的。

判据（`tests/gl/run.js` 第二节，7/7）：
* `02-gl.pss` 在 `gl` 与 `host` 两档上**非黑格数 10223 / 10228**（差 0.05%，两个渲染器不逐字节），
  且 `gl` 那趟 stderr 上没有 `#gfx gl` —— 没有偷偷回落（不判这一条的话它会变成自己判自己）；
* `draw2d.kc` 两档**逐字节相同** —— 钉住合成那一格没把宿主的 2D 弄坏。

下一步（第五刀最后一格）：program / uniform / 纹理（`glsetshader` 那一族）接进
`omni_ev_gl.c` —— 那时着色器那 22 份 `.pss` 就出得来图。现在 `batchprog != 0` 在这一档
是当场报，报的话里明写"还没接"。

### 13.9 已落地（2026-09-24）：**可编程管线与纹理**（第五刀最后一格）

`omni_ev_gl.c` 补上与 `gfx-gl.js` 逐句对应的那半（名字表 / 着色器登记 / program 缓存 /
uniform 句柄 / 常量属性 / 纹理四格式），ABI 多这几个：

    _def(种类,名字,内容)   vert/frag/geom/name —— 收到的主体已是对齐后的 GLSL（§13.7）
    _shader(argc,args)     glsetshader（实参是名字表下标；负数 = 第一对，glquad 那一句）
    _uniloc / _uni         glgetuniformloc / gluniform{1,2,3,4}f（句柄按 program 记）
    _attrloc / _attr       glgetattribloc / glvertexattrib*f（常量属性，画的时候摆上）
    _prog / _mvp / _blend  batchprog / batchmvp 列 m0..m3 / batchblend
    _tex / _bindtex / _activetex   (gfxtex …) + glbindtexture/glactivetexture

两格接法照 WebGL2 那一档一字不差：**采样器按名字约定接单元**（`tex0..tex7` 链好就设成
0..7 号单元 —— PolyDraw 的脚本除此之外没有别的绑定办法）、**KGL_BGRA32 摊成 RGBA**
（真 GL 有 `GL_BGRA`，但"一格 double 是一格打包像素"那步两边都要做，不给自己留第二条路）。

宿主那侧有一格要记：`(gfxdef …)` 在**设备开起来之前**就来了（产物开头那一摊登记语句），
所以 `omni_fmt.c` 先把它们存下来（自己的一份拷贝），GL 挂上之后一趟补给插件。
`glsetshader` 也可能是这一趟的第一句图形调用 —— 所以转发之前先 `gfx_need()`。

判据（`tests/gl/run.js` 第三节，11/11）：
* `04-shader.pss` 非黑 76800/76800、**72259 种颜色** —— 铺满 + 片元真在算；
* `05-shader-geom.pss` 非黑 9216、9217 种颜色；`06-texture.pss` 非黑 76780、4096 种颜色
  （棋盘正好 64×64 = 4096 —— 纹理真上传真采样了）；
* `04-shader.pss` 第 0 帧与第 30 帧 **76632 格不同** —— 时间那格 uniform 真喂进去了。

## 14. 第六刀的设计：**画布文字**（`printg` / `printchar`，语料里 178 次）

### 14.1 为什么它是下一刀

着色器那一族清完之后，出图那把尺子上最大的一块是**画布文字**：`printg` 那一族在语料里
178 次，现在一律"收下不用" —— 图出得来但**该有字的地方是空的**（帧数、坐标、菜单、
调试值全没了）。它不像着色器那样"缺了画面就是错的"，但它是**读得懂那张图的前提**。

### 14.2 字模照原版那一张（`polydraw.c:709` 的 `font6x8`）

**不自己造字模**（复用 > 第二份实现）。那张表是 256 个 DOS 字符、**竖排**存的：

    字符 c 的第 x 列（x < 6）= 字节 c*6 + x，其中 bit r 是第 r 行（r < 8）
    （原文：((char *)font6x8)[(y>>3)*6+(x&7)] & (1<<(y&7))，y = c*8 + r）

格子是 **6×8**，一个字符往右走 **6 像素**（`myprintg` 里 `x += 6`）；
`\t` 那一格照原文：`ich == 9` 时 `intab = 2` 再换成空格 —— 也就是**三格空格**。

落点：一份数据、两处引用 —— `src/core/host/font6x8.js`（JS 那侧）与
`src/runtime/omni_font6x8.h`（C 那侧）。**表本身由一段生成器从原版抄下来**，不手打。

### 14.3 字怎么从语言那一侧走到设备

`printg(x, y, 颜色, "格式串", …)` 的格式串是**字面量**（与 `printf` 同一条口径），
所以排版在**编译期**做完：走公共层那台格式串机器的 `fmtToIR`（`lower/fmt.js`）
拿到**一格串表达式**，再逐字符发一句设备调用：

    s = fmtToIR(fmt, 那几格实参)        ; 一格串（公共层那台机器，不另写一份）
    循环 i = 0 … slen(s)-1:
      (gfxcall "printchar" (sord s i) (+ x (* 6 i)) y 颜色)

`(sord E I)` 是**这一刀要加的一格方言 op**（"串的第 I 个字符的码"）—— 现有的串那几格
（`slen`/`ssub`/`sfind`/`srep`）拿不出字符码。四条腿各一句：js emit、c 运行时、
解释器、sx 读写。**不用 `sfind` 在一张 ASCII 表里查位置那种取巧**：那是 O(95) 一格字符，
而且把"码"这件事藏进了一格字面串。

### 14.4 文字是**宿主那一层**的事（与 `setpix` 同一层）

三档设备各画一遍字模是第二份实现。这一刀照已经建好的**两层合成**（§13.8）：
`printchar` 落在**宿主那格帧缓冲**上（`host/gfx-cpu.js` 与 `omni_fmt.c` 逐句相同的那两份），
GL 那一档交帧时它自然盖在 GPU 那一层上面 —— 文字与 `setpix` 同一层，一个字都不用另写。
浏览器那一档（WebGL2）例外：那边没有宿主帧缓冲，所以它把 `printchar` 落成**六个顶点**
（一格字符一个四边形 + 字模纹理），走已经有的批那条路。

### 14.5 判据

1. `tests/lower/run.js` 加一族 `EVPRINTG`：`printg(4, 4, 0xffffff, "n=%d", 7)` 之后
   `getpix` 那几格**按字模算出来的点**是前景色、旁边那几格是背景 —— 数是算出来的，
   不是量出来的（与红三角 9600 那一条同一手）；
2. 三条腿（js / interp / c）**逐字节相同**（文字在宿主那一层，所以这条必须成立）；
3. `tests/studio/run.js` 加一条：浏览器那一档同一份脚本，字的那几格非背景；
4. 语料尺子：`printg` 那 178 次里"该有字"的那些份**非黑格数变多**（现在是 0 个字）。

## 15. 性能：**实时性**（2026-09-24 用户定的口径）

### 15.0 要的是实时，不是"快一点"

用户的原话（两次纠正之后的最终口径）：

> **PolyDraw / EvalDraw 就是为实时交互设计的，而且是十多年前的旧电脑，要做到 60fps。**
> shader 渲染往往不是瓶颈，shader 的动态库可以走 FFI。**LLVM JIT 模式重要、tcc -run
> 重要、编译到 JS 的执行速度（含编译速度）重要**（特别是浏览器端）。
> **编译到 C 的性能没那么重要。** 不是要快一点的问题，而是要实时的问题 ——
> 不然就不是 evaldraw/polydraw 的效果。

于是判据的重心是两条线（`tests/eval/perf.js` 的"实时性那一栏"）：

* **每帧 ≤ 16.7ms**（60fps）；
* **改完脚本到看见画面 ≤ 1s**（编译时间算在里头）—— `--backend c` 那条**不判**这一条
  （它是出成品用的，一趟一秒多）。

### 15.0.1 现在的账（2026-09-24，`04-shader.pss`，`--gfx gl`）

    模式      启动(ms)   每帧avg   每帧max    状态
    jit          —         —        —      **跑不起来**：`llvm: gfx_call.string 要 14 个实参，实得 1`
    tcc          —         —        —      这台机器上没装 tcc（那一档跳过）
    js           —         —        —      **跑不起来**：CPU 备选上没有 glsetshader（FFI 那条还没接）
    interp       —         —        —      同上
    c          1240       0.8ms   15.3ms   每帧 1250fps ✔（启动那一条不判）

**四种实时模式全红，只有"出成品"那条通。** 这正是这一节存在的理由：帧时间早就够了
（GPU 那一半 0.8ms/帧），缺的是**那几条能立刻跑起来的路**。

按重要性排的欠账：
1. **js 腿 + FFI 接 `libomnigl`**（浏览器端走的就是这条路的表亲）—— 见 §16；
2. **LLVM JIT 那格 `gfxcall` 的 ABI**（`gfx_call.string` 的实参个数对不上）；
3. **启动延迟**：`c` 那条 1240ms 里前端 161ms、**我们自己的链接器 805ms** —— 那是
   "改完到看见"这条线上最大的一格。


### 15.1 口径

**接了 GPU 后端之后，每个例子 ≤ 5s；而且不能比本机那份 c_impl 实现慢。** 但这句话要拆成
两栏才量得对 —— 用户自己点明的：

* **出图那一半（shader / GPU）对双方公平** —— 同一颗 GPU、同一份 GLSL。参考是
  `c_impl/build/polydraw-render x.pss --frame 0 --w 320 --h 240 -o out.png`（离屏一帧）。
  门槛：**≤ 5s 且 ≤ 参考**。
* **主脚本那一半（语言这一半）不公平，而且是我们占便宜** —— 我们编译到 C 的原生码，
  那侧是**没做任何优化的解释器**。所以门槛不是"不慢"，而是**快几倍**（判据里 ≥3x）。
  参考是 `polydraw-eval -f x.pss -n N`（把脚本跑 N 趟，不画）。

### 15.2 量法上的两个坑（都踩过）

* **别拿父进程这侧的 `hrtime` 当分子**：同一个二进制从 shell 里跑 **0.15s**、从 node 里
  `spawnSync` 量到 **1.03s** —— 那 0.88s 是 `spawnSync` 起进程 + 收 stdio 的开销。
  第一版判据就是这么量的，于是"我们比 c_impl 慢 4.8 倍"这个结论是**工具造出来的**。
  现在一律 `/usr/bin/time -p` 包一层、读被测进程自己报的 `real`。
* **主脚本那一栏只能用不含图形调用的脚本**：参考那侧无上下文时 `GLVERTEX`/`GLBEGIN`
  那一族是 **no-op stub**（`c_impl/src/pd_polyhost.c:6` 的注写着），拿含 GL 的脚本去比
  等于比"谁更会空转"。基准脚本是 `tests/eval/hot.pss`（一帧 20 万次浮点、零设备调用）。
* 量的对象是 **`omni build` 出来的二进制**，不是 `omni run`：这台机器上 node 空跑就
  0.42s、再 import 两百多份 ESM +0.3s —— 那是编译器的启动账。

### 15.3 现在的数（`node tests/eval/perf.js`，都取最小）

    出图一帧（320×240）        我们      c_impl      比
      02-gl.pss               160ms     220ms     0.73x
      04-shader.pss           120ms     130ms     0.92x
      05-shader-geom.pss      110ms     140ms     0.79x
      06-texture.pss          120ms     160ms     0.75x

    主脚本（hot.pss 40 帧 = 800 万次浮点）
      我们 <10ms   解释器 2260ms   ≥200x

一帧里画那一下是 **4~15ms**（`OMNI_GFX_PERF=1` 的 `#perf gfx` 那行），剩下的是进程启动 +
CGL 上下文 + 着色器编译 + 写 PNG —— 双方都付这一份，所以那一栏的比值才是公平的。

### 15.4 欠的两格

* **语言侧 GL 立即模式的每帧开销**：`02-gl.pss` 在 `--gfx null`（只记账不画）下
  5000 帧 860ms = **172µs/帧** —— 那是矩阵乘 + 顶点数组 + 合批在语言这一侧的账。
  出图那一栏我们已经比参考快，但这一格是**下一刀该优化的数**。
* **第三种模式：node + FFI**（主脚本编到 JS、shader 走 FFI 到 `libomnigl`）。
  机制在 ADR-0038（node 这侧的 FFI 已经有），缺的是 js 那条腿上的 GL 转发 ——
  `host/gfx-cpu.js` 现在只有 CPU 备选。这一栏也要有判据与优化。


### 15.5 **最吃力的那几份**才是判据（2026-09-24 用户纠正）

> 比较简单的例子意义不大。要比那些最吃力的例子。

参考实现自己的性能计划里就有这张清单（`polydraw/Plan/10_Performance.md`）：
`disco ball`（19970 个 draw call）/ `snake tube` / `ken/drawsph` / `balls2k` 被标成
"远低于 60fps"，而 `metaballs`（605fps）、`heightmap`（343fps）那种**量了没意义**。
参考那一侧的工具是 **`c_impl/build/framebench`**（EVAL 录制 + FBO replay + `glReadPixels`，
与我们 `--gfx gl` 同一件事），固定 **320×320**、60 帧 —— 判据的分辨率跟着它，
不然比值是假的（踩过：我们 320×240 对它 320×320）。

这台机器上参考的数（`framebench --frames 60`）：

    脚本              interp      llvm       最好
    disco ball        65.34ms    79.37ms    65.34ms   （15.3fps）
    snake tube        82.61ms    35.27ms    35.27ms   （28.4fps）
    ken/drawsph       39.82ms    54.12ms    39.82ms   （25.1fps）
    balls2k           25.46ms     7.01ms     7.01ms   （142.7fps）

我们在 `ken/drawsph.pss` 上量到的（320×320、60 帧）：

    我们 c 腿   --gfx gl     18.4ms/帧（54.4fps）   <- 比参考最好那档快 2.2 倍
    我们 js 腿  --gfx gl     36.0ms/帧（27.8fps）
    我们 js 腿  --gfx null   22.1ms/帧            <- **语言那一半就占了 61%**
    参考最好档                39.82ms

两条结论（都是这一份例子逼出来的）：
* **合批那一格是对的**：一帧只发 3 格 `(gfxbatch …)`（180/60）—— 参考那边是每球一个
  `glBegin/glEnd`（它那 19970 个 draw call 之所以成瓶颈就是这个）。所以我们不是
  draw-call 密集，是**语言侧算术**密集；
* 于是 **js 腿要优化的是"编到 JS 的执行速度"**（22.1ms 那一格），c 腿要优化的是原生码
  那一半 —— 与用户定的口径一致（编到 C 的**整趟**时间不重要，**每帧**重要）。

### 15.6 这几份例子逼出来的四个真缺口

1. **`@v:名字` 与 `@f:名字` 同名是常态**（`balls2k` 就是 `glsetshader("drawsph","drawsph")`）
   —— 按名字找着色器会把顶点与片元拿成同一份，编出来是 `gl_Position 未声明`。
   修：`ev_sh_by_name(名字, 种类)`，**种类参与匹配**（浏览器那一档 `SH.src` 有同样的隐患，
   下一刀一起改）；
2. **`gluniform1i`**（采样器与开关位走它）：补了 `omni_ev_gl_uni1i` + 两条腿的转发；
3. **`glklockstart` / `glklockelapsed` / `gltextdisable`**：`polydraw.c` 的 `myext[]` 里有、
   我们没有的那几格（名字照那张表抄 —— 第一版把 `glklockelapsed` 写成了 `glklockelaps`）；
4. **还欠的两格**（下一刀）：
   * `gl_Normal`（旧式内建属性）—— 要给顶点加**法向**那 4 格（12 -> 16），
     三档设备 + `gl-rt.js` 一起改；`balls2k` 卡在这儿；
   * `gluniform{1,2,3,4}{i,fv,iv}` 那一族（`myext[]` 里全有）。


## 16. 第六刀：**js 腿 + FFI 接本机 GL**（实时那三条路的第一条）
### 16.1 为什么它排第一

`--backend js` / `--backend interp` 这两条是**改完立刻能跑**的路（没有 cc、没有链接），
而浏览器端走的就是"编到 JS"这条路的表亲。现在它们在着色器那一族上**当场报**
（`这格设备（CPU 备选）上没有 'glsetshader'`）—— 也就是说实时那一栏根本没有绿的可能。
GPU 那一半的代码**已经在 `libomnigl` 里了**（§13），缺的只是 node 这一侧的入口。

### 16.2 形状：**一份 N-API 扩展 + CPU 备选里的一条转发支路**

    src/runtime-gl/omni_ev_gl_napi.c     omni_ev_gl.c 一起编 -> omni_ev_gl.node（N-API）
    src/core/host/ffi_host.js            现成的 dlopenAddon(path)（process.dlopen）
    src/core/host/gfx-cpu.js             加一条 GL 转发支路（与 omni_fmt.c 里那一条逐句对应）

**不写第二台设备**：帧循环 / 输入 / `present` 写 PNG / 两层合成（GPU 当底、宿主那层盖上去）
全部复用 `gfx-cpu.js` 现成的那几格 —— 这与 C 那条腿的做法**一一对应**
（`omni_fmt.c` 就是在 CPU 备选里加转发，§13.8），所以两侧的行为天然一致。

### 16.3 ABI：普通数组，不用 typed array

N-API 那一侧收 **普通 JS 数组**（`napi_get_array_length` + `napi_get_element`），
不用 `Float64Array` —— 理由是**子集**：`gfx-cpu.js` 要过 `check:self` 那道门，
而 typed array 还不在那个子集里。代价量过：一格顶点 12 个 `napi_get_element` ≈ 50ns，
04-shader 一帧 6 个顶点、02-gl 上千顶点 ⇒ 0.01~0.6ms/帧，在 16.7ms 的预算里够用。
读回那一格（320×240 = 76800 格）约 4ms/帧，`render` 模式一帧只读一次 —— 也够用。
**真不够的时候的下一步是把 typed array 扩进子集**（"撞上子集外的名字就扩支持，不许绕"），
不是在这儿绕。

导出的名字与 `omni_ev_gl_*` 一一对应：

    open(w,h) cls(rgb) depth(on) batch(kind,n,verts[]) readInto(out[])
    def(kind,name,text) shader(args[]) uniloc(i) uni(h,n,vals[]) attrloc(i) attr(loc,vals[])
    prog(on) mvp(col,m0,m1,m2,m3) blend(mode) tex(slot,w,h,d,fmt,px[]) bindtex(s) activetex(u)
    error()

### 16.4 判据

1. `tests/gl/run.js` 加一节：addon 编得出来、装得上（`process.dlopen`）、离屏拿到像素
   —— 与 C 那侧那条红三角判据**同一组数**（红 9600 / 背景 67200）；
2. `tests/eval/perf.js` 的实时性那一栏里 `js` 与 `interp` 两档**由红转绿**：
   每帧 ≤ 16.7ms、启动 ≤ 1s；
3. `04-shader.pss` 在 js 腿与 c 腿上出的图**结构一致**（非黑格数差 5% 以内 ——
   两条腿同一份 GLSL、同一颗 GPU，只差谁在跑主脚本）。

### 16.5 已落地（2026-09-24）

    src/runtime-gl/omni_ev_gl_napi.c   N-API 包装（19 格），与 omni_ev_gl.c 一起编成 .node
    src/runtime/omni_napi.h            加 4 条声明（数组那三条 + 建串）—— 仍然不外挂 node 头
    src/core/host/gfx-cpu.js           那条 GL 转发支路（cls/framebegin/gldepth/批/着色器那族/
                                       纹理/def/两层合成/getpix），与 omni_fmt.c 逐句对应
    src/core/cli.js                    evGlAddon()：编 + 缓存 + 把路径摆进 OMNI_EV_GL_ADDON

量出来的（`04-shader.pss`，`--gfx gl`，60 帧）：

    模式      启动     每帧avg   每帧max    fps
    js       500ms    2.3ms     8.0ms     435     ✔ 实时
    interp   510ms    2.4ms    15.0ms     417     ✔ 实时
    c        860ms    0.4ms     3.4ms    2500     ✔（启动那条不判）
    jit        —        —         —        —      仍红：`gfx_call.string 要 14 个实参，实得 1`

三条腿画出来的图**一模一样**（非黑 76800/76800、72259 种颜色 —— 同一份 GLSL、同一颗 GPU，
只差谁在跑主脚本）。`tests/lower` 44/44、`tests/gl` 11/11、`check:self` 绿。

**一格要记的**：`--gfx gl` 必须走**旗子**，不能只设 `OMNI_GFX=gl` —— 那两份 GPU 的门
（原生腿的 dylib、js 腿的 .node）是 `cli.js` 解析旗子时顺手编出来并摆进环境的；
只设环境变量的话它们不会被编，设备**悄悄回落 CPU 备选**（判据第一版就是这么假红的）。

## 17. 第七刀：**正确性优先**（2026-09-24 用户定的口径）

> 你需要在正确的情况下优化速度。目前还有很多例子渲染都不正确，包括基本的例子。
> 黑的显然不正确，像素差异大也不正确。此外 c_impl 实现也只有 80% 正确 ——
> 如果你连 c_impl 那种正确都保证不了，比较速度没有意义。细节情况看原始实现 polydraw_src。

### 17.1 判据：`tests/eval/correct.js`（与 c_impl 逐像素对照）

我们出 `.rgba`（裸表面、没有编码层），参考出 PNG 再用它自带的 `pd-imgdecode` 转 PPM ——
两边都不过第三方解码器。量四个数：**RMSE**、两边非黑格数、有差的格数、最大分量差。
三档判定：**黑图**（参考有东西而我们几乎全黑）、**差异大**（RMSE 过线）、其余算过。

### 17.2 **一格必须传对的东西：fovy**（不然"看着像我们画错"）

参考 `polydraw-render` 的 fovy **默认固定 73.74°**（`src/render_main.c:48` 的注：
"setfov(90) effective, matches the reference" —— 那是 640×480 那台窗口上的值）；
我们照 `polydraw_src` 的 `ksetfov`（`polydraw.c:1484`）用**真实画布的宽高比**算：
`tan(fovy/2) = 高/宽`。于是 320×320 上我们是 90°、它还是 73.74°，三角差 **1.333 倍** ——
第一版对照就是这么"发现我们画错"的。判据现在按分辨率把 fovy 递过去
（`fovy = 2·atan(h/w)`）。改对之后：

    01_minimal_noshader.pss   RMSE 0.00   逐像素相同（3698 = 3698）
    04-shader.pss             RMSE 0.00   逐像素相同（102400 格全中）
    06-texture.pss            RMSE 0.00   逐像素相同
    05-shader-geom.pss        RMSE 6.62   够近（每格差一点，最大 38）

### 17.3 第一批账（320×320、第 0 帧）与两格已修

    RMSE   我们非黑  参考非黑  判定        例子
    0.00     3698     3698   逐像素相同   01_minimal_noshader.pss
    0.00     4096     4096   逐像素相同   03_custom_shader.pss     ← 修好的
    0.00     1406     1406   逐像素相同   04_required_shader.pss   ← 修好的
    0.00   102400   102400   逐像素相同   04-shader.pss
    0.00   102375   102375   逐像素相同   06-texture.pss
    6.62     9216     9216   够近        05-shader-geom.pss
   14.84     2320     1160   **参考错**   02_primitives_noshader.pss
   17.59    10223     9832   待查        02-gl.pss
    0.00    10750    10750   逐像素相同   05_explicit_main_and_funcs.pss ← 旋转那一格修好之后

**已修的两格（都照 `polydraw_src`）**：

1. **`glsetshader` 的序号是"该类里的第几份"**，不是全表下标。原版
   `qglsetshader(d) = setshader_int(0, -1, (int)d)`（`polydraw.c:1072`）—— 顶点固定第 0 份、
   片元取第 d 份；名字那一档 `kglsetshader3` 在区段表里按**类别 + 名字**找、取的是
   `tsec[].cnt`（分类计数）。我们从前拿全表下标，于是 `glsetshader(0)` 把片元指到了 `@v`
   那份，报 `gl_Position 未声明`。越界照 `setshader_int` 夹成第 0 份。
   **一格根因修好两份例子，而且都是逐像素相同。**
2. **具名主函数**（`main() { … }` 接着 `cube(a) { … }`）：`.grammar` 的 `program` 加一支
   `(pre NAME params block fns)` —— 照原版"第一个函数就是主函数"的语义（名字随意）。
   与旧那支不打架：旧的主函数以 `(` 开头、这一支以 NAME 开头。

**`02_primitives_noshader` 是参考错**（连通块数出来的）：脚本 `for (i = 0; i < 6; i++)`
明写 6 个方块，我们画 6 个、参考只有 3 个。这类分歧要裁定一次再记名单，
依据只有 `polydraw_src` 的语义。


### 17.5 **`glRotate` 的转向反了**（第三格根因，2026-09-24）

`05_explicit_main_and_funcs`（递归树）画出来只有参考一半的量（RMSE 46.13）。二分到最小复现
（一个方块 + 一句变换，两边逐像素比）：

    A 只 translate            RMSE 0.00
    D 只 scale                RMSE 0.00
    E 只 translate(0,1,0)     RMSE 0.00
    B 一句 glRotate(60,1,0,0) RMSE 10.33   ← **形状一样、整体偏 2 像素**
    C 两句 glRotate           RMSE 6.57

B 那一格两边非黑格数**一样**（516 = 516）、x 范围也一样，只有 y 差 2 —— 于是试了一手：
**我们 `glRotate(-60)` 与参考 `glRotate(+60)` 逐像素相同（RMSE 0.00）** ⇒ 转向反了。

根因是**约定**：我们这一侧顶点是**行向量**（矩阵按 `m[12..14]` 放平移，`gl_translate` 与
`gl_vertex4` 都按这一套），所以旋转要填 GL 那张 `R` 的**转置** —— sin 那几项的符号与
OpenGL 规范里相反。填成规范原样就等于每次旋转都反着转，浅层看不出、递归里放大。
改完之后 `05_explicit_main_and_funcs` **RMSE 0.00 逐像素相同**（10750 = 10750）。

一格教训：`glScale` / `glTranslate` 在这两套约定下**恰好看不出差别**（对角与平移分量位置
正好一致），所以"平移缩放都对"不能说明矩阵那一层的约定是对的 —— **只有旋转能试出来**。

### 17.6 `02-gl.pss` 那 17.45 也是参考错（裁定过程照抄）

按颜色数出来的：脚本第三段是 `glTranslate(.45,-.45,.2); glRotate(30,0,0,1); glScale(.25,.25,1);`
一个青方块（`glColor(0,.8,.9)`）—— **我们 1976 格、参考 0 格**（参考压根没画）。
别的三样两边逐格相同：渐变三角、黄线圈、白点列（40 格、位置一致）。
最小复现 `translate + glRotate(30,0,0,1) + GL_QUADS` 两边**包围盒与格数都一样** ⇒
参考不是不会转、而是**在多段之后丢了图元**（与 `02_primitives_noshader` 那格"6 个只画 3 个"
同一个味道：push/pop + QUADS 的组合）。

两格裁定都记进 `tests/eval/correct.js` 的 `REF_WRONG` 表（每条都写清怎么定的）——
判据里印出来但**不计红**：不记会永远红在别人的 bug 上，乱记又会把我们自己的 bug 藏起来。

### 17.7 现在的正确性账：**7 过 0 红 2 裁定**

    0.00   逐像素相同   01_minimal_noshader / 03_custom_shader / 04_required_shader /
                        05_explicit_main_and_funcs / 04-shader / 06-texture
    6.62   够近        05-shader-geom（每格差一点、最大 38 —— 几何着色器那档的插值）
   14.84   参考错      02_primitives_noshader
   17.45   参考错      02-gl

### 17.4 待修（按"基本例子"优先）

1. `balls2k` 卡在 `gl_Normal`（顶点要加法向那 4 格，见 §15.6）；
2. 浏览器那一档（`gfx-gl.js` 的 `SH.src`）有**同名覆盖**与**全表下标**两个同样的隐患 ——
   那边还没改（studio 判据现在跑的例子里 @v/@f 不同名，所以还没红）；
3. `05-shader-geom` 那 6.62：每一格都差一点点（最大 38），是几何着色器那一档的插值口径；
4. 语料里更大的那一批（`ken/` `tigrou/`）还没进这份判据 —— 基本例子清完之后再铺。

## 18. 第八刀的设计：**法向那一格**（`glnormal` / `gl_Normal`，语料里 20 份）

### 18.1 为什么是它

全量扫（58 份判了）之后按根因分组，`glquad()` 那一族（9 份）修完就剩这一格最大：
`gl_Normal` 18 次、`gl_FrontColor` 5 次、`gl_NormalMatrix` / `gl_ModelViewMatrix` 各 1 次，
一共 **20 份 `.pss`**（`ken/` 12 份 + `tigrou/` 8 份，含 `balls2k` / `clock` / `drawsph`
那几份"最吃力"的）。现在它们全都**跑不起来**：内建顶点着色器编不过，
`Use of undeclared identifier 'gl_Normal'`。

### 18.2 原版的事实（照 `polydraw_src` 抄）

    polydraw.c:620   double qglNormal3d(x,y,z) { glNormal3d(x,y,z); return 0; }
    polydraw.c:2108  {"GLNORMAL(,,)", qglNormal3d}

就是固定管线那格**当前法向**（与 `glColor` 同一个味道：设一次，之后每个 `glVertex`
都带着它走），默认值照 GL 规范是 `(0,0,1)`。所以落法与颜色**一模一样**，
不是新机制：语言那一侧存三格状态，`gl_vertex4` 那一趟抄进顶点。

`clock.pss` 把它当**数据通道**用（`glnormal(shakeshift, shakecolor, xres/yres)`）——
这更说明不能"归一化一下"或"自己算面法向"：原样送过去，一个字都不动。

### 18.3 顶点从 12 格扩到 16 格

一格顶点（`(gfxbatch 类 数 (arr real))` 的契约，**三档设备 + 两门语言共用**）：

    0..3    位置      x y z w
    4..7    颜色      r g b a     (0..1)
    8..11   纹理坐标  s t p q
    12..15  法向      nx ny nz 0  ← 新增（第四格留 0，凑齐 4 的倍数好摆 attribute）

要一起改的地方（**一个模型**那条规矩：顶点在语言侧、设备只收批）：

* `ext/polydraw/gl-rt.js` —— `VS` 12→16、三格状态 `gl_nx/gl_ny/gl_nz`（初值 0,0,1）、
  `glnormal/3` -> `gl_normal3`、`gl_vertex4` 多写 4 格、`glquad` 那六个顶点多补 4 格；
* `src/core/host/gfx-cpu.js` —— `VSTRIDE` 12→16（CPU 备选不读法向，只是别错位）；
* `src/runtime-gl/omni_ev_gl.c` —— stride 16、attribute 表加 `a_nrm`；
* `src/studio/gfx-gl.js` —— `ST` 48→64、attribute 表同上；
* `src/runtime/omni_fmt.c` —— 只是转发，不认格数（不用改）。

### 18.4 `gl_NormalMatrix` / `gl_ModelViewMatrix`：**多发一个矩阵，不新造概念**

现在设备只收 `u_mvp`（语言侧算好的 `gl_pj · gl_mv`，四句 `batchmvp` 一句一列）。
这两个内建要的是**模型视图**那一格，所以照同一个形状再加一族：

    (gfxcall "batchmv" 列 m0 m1 m2 m3)      ← 与 batchmvp 逐字同形

法向矩阵**不另发**：在 GLSL 里算 `mat3(transpose(inverse(u_mv)))`（410 core 与
ES 300 都有这两个内建函数）—— 少一条宿主面、少一份"可能与 `u_mv` 不一致"的状态。

### 18.5 翻译表补的几格（`ext/polydraw/glsl.js`，两档设备共用一份）

    gl_Normal                 -> a_nrm.xyz        （in vec4 a_nrm;）
    gl_ModelViewMatrix        -> u_mv             （uniform mat4 u_mv;）
    gl_NormalMatrix           -> mat3(transpose(inverse(u_mv)))
    gl_FrontColor             -> v_col0           （顶点段那格输出 = 片元段的 gl_Color）

`gl_FrontColor` 那一格要注意次序：我们已经在 `main` 的左花括号后注入了
`v_col0 = a_col;`，脚本自己那句 `gl_FrontColor = …` 在它**后面**执行，所以覆盖得掉 ——
与真固定管线的语义一致（不写就是顶点色）。

### 18.6 判据

1. `node tests/lower/run.js polydraw evaldraw`（改顶点契约必须过）；
2. `node tests/gl/run.js`（11/11，那三节都量了顶点批与 uniform）；
3. `node tests/eval/correct.js --only clock,balls2k,drawsph,ballsk,dominos` —— 这一族
   从"跑不起来"变成有 RMSE 的数；
4. `npm run check:self`。

## 19. 第九刀的设计：**带数组的宿主调用**（`gluniform*v` / `glgettex`）与 **ARB 汇编那 5 份**

### 19.1 带数组的宿主调用：**一格新 op，不是九个新名字**

`myext[]` 里带 `&`（一整块 double）的名字只有这几族（`polydraw.c:2070` 起那张表）：

    GLUNIFORM{1,2,3,4}{F,I}V(,,&)     语料里 9 次
    GLGETTEX(,&,,,)                   语料里 4 次（把纹理**读回来**）
    GLSETTEX(,&,…)                    语料里 34 次 —— 已经有 `(gfxtex …)` 了
    GLMULTMATRIX(&)                   语料里 0 次

形状是同一个：**恰好一格数组 + 几格 double**。所以方言里再加**一格** op 就够：

    (gfxarr "名字" a0 a1 a2 a3 (arr real))      ← 四格 double 定死 + 数组在最后一格

**为什么把标量那几格定死成四个**：每一层（sexpr 检查、四条后端、两处设备）都只写一条
固定形状的判断，与 `(gfxtex 槽 宽 高 层 格 数组)` 一个味道；变长那一套要在七处各写一遍
"最后一格是数组、前头随便几格"。用不满的那几格递 0：

    gluniform3fv(句柄, 个数, 数组)   -> (gfxarr "gluniform3fv" 句柄 个数 0 0 数组)
    glgettex(槽, 数组, 宽, 高, 格)   -> (gfxarr "glgettex" 槽 宽 高 格 数组)

`glgettex` 是**往里写**的那一档（out 参数）—— 同一格 op 够用：设备按名字知道方向，
数组那一格两边都是"那一块内存"。这比"给每个名字开一格 op"少八份实现。

**两个照 `kglgettexarray2`（`polydraw.c:1348`）抄下来的口径**，两个都是"不照就静默画错"：

* **最后那格 `coltype` 是不看的**：一像素几个 double 由**那一槽自己的格**说
  （`KGL_VEC4` 四个、别的一个）。`ken/gpgpu.pss` 写 `glgettex(2,buf,XT,YT,KGL_VEC4)`
  而那一槽是 `KGL_FLOAT` 时，出来的就是一像素一格。
* **写回几格由设备算**（回值就是它，-1 = 没读到）：宿主那一侧（N-API / `omni_fmt.c`）
  只有数组长度，算不出这个数 —— 所以它只把长度当上限递过去。

`gluniform*v` 那一族的 `个数` 在原版里是**直接当 GLsizei count 递给 GL 的**，
而它只抄 `个数` 个 float（`kglUniform3fv`：`fvals[inum]`）—— 于是 `metaballs.pss` 那句
`gluniform3fv(gmpos, n*3, mpos)` 在原版里让 GL 读了 45 个 float 而只填了 15 个。
我们把 `个数` 按数组长度掐到 `长度/分量数`（5 个 vec3）：**能看见的那几格逐字相同**
（着色器只读 `i < nbballs` = 5 个），越界那一段不去碰。


### 19.2 ARB 汇编那 5 份：**与 c_impl 同口径 —— 认出来，退回内建那对**

`ken/` 有 5 份把 `@v:`/`@f:` 段写成 **ARB 汇编**（段首是 `!!ARBvp1.0` / `!!ARBfp1.0`，
不是 GLSL）：`drawsph_asm` / `interference_asm` / `multiarb_asm` / `drawcone2_asm` /
`creepers_asm`。core profile 没有 ARB 汇编那条路，参考实现也没有 ——
`c_impl/src/render/pd_polyhost_tex.c:547` 把 `glProgram*Param` 写成 no-op，
`gl_renderer.c:1131` 那儿编不过就**留着上一格 program**（也就是内建那对）。

所以这一刀按参考的口径做，两格：

* `glprogramenvparam/5` —— 收下不管（ARB 汇编专用，`polydraw.c:2111`）；
* 着色器段的原文以 `!!ARB` 开头 ⇒ **认出来是另一门语言**，这一档不支持，退回内建那对
  （不是"编不过就悄悄退"—— 那会把我们自己的 GLSL bug 藏起来；只认 `!!ARB` 这一个特征）。

于是这 5 份从"跑不起来"变成"与参考画同一条内建管线"，像素才比得上。

## 20. 第十刀的设计：**文件纹理**（`glsettex(槽,"earth.jpg")`，13 份脚本）

### 20.1 账

语料里 13 份 `.pss` 用 `glsettex(槽, "文件名")` 那一档（`GLSETTEX(,$)` /
`GLSETTEX(,$,)`，`polydraw.c:2166`）：`earth.jpg` 9 次、`kensky.jpg`（立方体贴图）、
`b2dr_sph.jpg`、两个 `.png`，另有两处指向这台机器上没有的路径。
那三份 jpg 与两份 png **就在 `polydraw/` 底下**，所以这不是"没素材"，是我们没有解码器。

原版的落法（`polydraw.c:1279` 的 `kglsettex2`）：
读文件 -> `kpgetdim`/`kprender` 解码成 BGRA -> `glTexSubImage2D`；
**`(colmode&0xf0) >= KGL_MIPMAP` 时还要 `gluBuild2DMipmaps`**；
一个字符串那一档的默认 colmode 是 `KGL_MIPMAP + KGL_REPEAT`（`:1346`）。
**文件读不到不报错**：它画一张 "IMAGE NOT FOUND :-(" 的占位图（`:1308`，里头有
`rand()` 噪声 —— 所以那种例子天生不可逐像素对照）。
立方体贴图那一档：一张竖排 6 面的图，按 `cubemapindex[]` 分别 `glTexSubImage2D`（`:1339`）。

参考实现用的是 **stb_image**（`c_impl/src/render/pd_polyhost_tex.c:25`）。

### 20.2 解码器放哪儿：**一份 C，两条腿共用**

这一层是宿主面的事，而宿主面有三份实现（`host/gfx-cpu.js` / `runtime/omni_fmt.c` /
`studio/gfx-gl.js`）。**不许写三份解码器**，所以：

* 解码器写成**一份 C**（`src/runtime/omni_img.c`）—— 基线 JPEG + PNG（PNG 要 inflate）；
* C 腿直接链它；
* js / interp 两条腿走**已经有的那条外挂路**（`ffi_host.js` 的 `dlopenAddon`，
  GL 那一档就是这么挂的）—— 于是"一份实现两条腿共用"，与 GL 那一刀同一个形状；
* 浏览器那一档下一刀再说（那边有平台自己的解码，`createImageBitmap`）。

方言那一侧不加新 op：文件名走**已有的串那一格**，落成
`(gfxcall "settexfile" 槽 名字下标 colmode)` —— 与 `glgetuniformloc` 收串同一手。

### 20.3 判据

1. 单元一层：`tests/img/run.js` 解 `earth.jpg` / `kensky.jpg` / `tomland.png`，
   与参考的 `pd-imgdecode` 出的 PPM 比 —— **平均差 ≤ 2**（两家 IDCT 不同，不追逐字节）；
2. 出图一层：`texture` / `drawsph` / `mipmap` / `cubetex` / `orthoglobe` 那几份的 RMSE；
3. 读不到文件那一档：占位图**不带随机噪声**（原版那儿是 `rand()`）——
   我们画同一张 "IMAGE NOT FOUND" 字样、底色定死，判据里把那种例子记 `REF_WRONG`
   （参考每趟都不一样，本来就没法对照）。

## 21. 第十一刀：**js 腿那条数组边界**（一格改动 35 倍）

判据里有两份一直是"跑不起来"（30s 看门狗）：`tigrou/tree.pss` 与 `tigrou/disco ball.pss`。
量下来不是死循环，是**慢**：tree 画一帧 64×64 要 **72.69s**，参考只要 **0.39s**（186 倍）。

根因在 N-API 那个包装（`src/runtime-gl/omni_ev_gl_napi.c`）：顶点批那几块是**按上限开的**
（`gl_ob` 是 `OMAX*VS` = 49152 格），而一趟 flush 往往只用头上几十格 ——
包装却把**整块**抄过去，于是每个 draw call 都是四万多次 `napi_get_element`。
tree 那份一帧上千个 draw call ⇒ 分钟级。

改法只有一句话：**按 `cnt * 16` 抄，不抄整块**。tree 72.69s -> **2.09s**、
disco ball 39.7s -> **1.17s**，两份从"跑不起来"变成有 RMSE 的数。

同一类还没做的那一格记在这儿：`readInto(out[])` 每交一帧要 `w*h` 次
`napi_set_element`（320×320 = 102400 次）。一帧只交一次，所以现在不是瓶颈；
真要 60fps 得让那一格走整块的路（子集里加 TypedArray —— 按"撞上就扩"那条纪律做，不绕）。

## 22. 第十二刀：**抓屏那一族**（`glcapture()` / `glcaptureend(槽)`，6 份脚本）

`tigrou/` 那几份后处理（blur/bloom）都是同一套：先把场景画一遍抓成纹理，再拿一个满屏
四边形配一段片元着色器把它糊开。语料里 6 份用它（tree / gears / clock / funky /
disco blur / ken 的 texture），从前 `glcapture` 是"收下不管"，于是那格 `tex0` 里
什么都没有 —— 图能出，但后处理采的是空的。

### 22.1 两份参考在这一格不是一回事 —— 跟的是 c_impl

* `polydraw.c:1195` 的 `qglCapture`：视口换成 `captexsiz²`（512 往下取到 2 的幂 ⇒
  320×240 上是 128）、PROJECTION 换成定死的 `gluPerspective(45,1,0.1,1000)`、
  MODELVIEW 换成 `glScalef(高/宽,1,1)`；`qglEndCapture` 拷 128×128 进纹理后**清屏**。
* `c_impl/src/render/gl_renderer.c:1652` 起：**整帧**。视口不动、矩阵不动，
  `glcapture()` 只把画布清成黑，`glcaptureend(槽)` 那一刻把整帧读回纹理。

按"以 polydraw_src 为准"本该照前者，但**这一格它定不下来**：`glcapture()` 在
`myext[]` 里是**零参**的（`"GLCAPTURE()"`），而 `qglCapture(double dcaptexsiz)` 读的是
一格根本没传的实参 —— `captexsiz` 拿到的是栈上的垃圾，视口边长在原版里就是不确定的。
语料自己的注释说的也是整帧那一种（`examples/opengl/25_offscreen_capture.pss`：
"glcapture() grabs the current framebuffer into a texture id"）。
两种都做过、量过：按 polydraw_src 那一种做，这一族与参考的差**一律变大**
（tree 38.6→64.4、gears 40→82、clock 16.7→40.6、texture 54→全黑）。所以跟 c_impl。

### 22.2 落点：设备两格 + 语言两句

设备（`omni_ev_gl_capbegin` / `_capend`）：清屏、`glCopyTexImage2D(0,0,宽,高)`、
按 `KGL_BGRA32`（LINEAR + REPEAT，后处理常按 >1 的坐标采样）设参数。
语言（`gl_capbegin` / `gl_capend`）：**断批**再把那一句转过去 —— 抓屏前后是两拨东西，
攒在一条批里就错了。矩阵一格都不动。

## 23. 第十三刀：三处**开局状态/作用域**的口径（一次治好五份）

这三格都不是"少了个 API"，是**语义定错了**，图照样出、但出的是另一张。

### 23.1 鼠标的开局位置是 (320,240)，不是 (0,0)

13 份 `.pss` 读 `mousx`/`mousy`。原版一开机光标就在窗口正中；参考也定死在那儿
（`c_impl/src/pd_polyhost.c:22`：`s->mousx = 640/2; s->mousy = 480/2;`，注释写着
"original starts the cursor at window center"）—— 注意它按的是**默认窗口 640×480**，
不随 `--w/--h` 变。我们从前给 0，于是 `ken/orthoglobe.pss` 的 `z = mousy/yres*4` 是 0，
整张图退化成一条线（全黑）。改完：`showmouse.pss` **逐像素相同**（RMSE 123 → 0）、
`cubetex` 99.9 → 39.3、`texture` 54.3 → 49.2。

### 23.2 `@h`：宿主脚本被挪到了后头（4 份）

`polydraw.txt:167`：「By default, the code at top is the host script. If you wish to
relocate the host code, you may put `@h` before it. Note that only 1 host block is
allowed - whichever comes last in the file.」

而词法层是**从第一个 `@` 整段跳到末尾**的，于是写了 `@h` 的脚本在我们这儿就是
"一句代码都没有"—— `orthoglobe` / `gspiral` / `geo_test` 三份全黑就是这一格。
落点在预处理那一趟（`ext/polydraw/pre.js` 的 `hostBlock`）：**把不属于宿主那一段的行
换成空行**，于是词法器看见的是宿主那段，而**行号一格不动**（那台机器的规矩）。
着色器原文那一半不受影响 —— adapter 拿的是未经预处理的原文（`drive.js` 的 `mainSrc`）。

### 23.3 同名的量**盖住** `enum`

`enum` 那张表整份程序共用（原版也是一份全局表，`eval.c:392`），而**名字大小写不敏感**
（`eval.txt:61`）。`ken/gspiral.pss` 主函数里写了 `enum {N=2^16}`，另一个函数里
又有局部量 `n = min(…)` —— 在我们这儿是同一个名字，于是那句赋值成了"给常量赋值"
（`未声明的变量 'n'`，整份跑不起来）。原版的次序是**先当变量看**（赋值就地造一格局部量），
所以 `bodyOf` 里记一格 `C.shadow`（形参 + `static` + 被赋过值的名字），
名字解析时它盖住 `enum`。gspiral 从"跑不起来"到出图（RMSE 20.6、非黑 27328 vs 26796）。

### 23.4 一个判据陷阱：`.ours.rgba` 前头有 14 字节文本头

判据留的那份原始像素是 `#rgba 宽 高\n` + RGBA，**看图/取像素前要跳过那一行**
（判据自己是 `b.indexOf(10)+1`）。忘了跳的话每个像素错位两字节，黑底变成纯绿、
黄色变成青色 —— 会把人引到"通道顺序错了""着色器被 miscompile 了"那条岔路上去（踩过，
为此还去试了改标识符名、改行尾）。要看图就 `tail -c $((宽*高*4))`。

## 24. 第十四刀：**alpha 那一对状态与纹理里的 alpha**

### 24.1 `glAlphaEnable()` / `glAlphaDisable()` 是真的一对 GL 状态

照 `polydraw.c:962`/`:969`：

    glAlphaEnable()  = glDisable(GL_DEPTH_TEST) + glEnable(GL_BLEND) + SRC_ALPHA/ONE_MINUS_SRC_ALPHA
    glAlphaDisable() = glEnable(GL_DEPTH_TEST)  + glDisable(GL_BLEND)

**开机与每次重编都是 `AlphaDisable`**（`polydraw.c:2256`）⇒ 默认混合是**关着**的。
参考也实现了这一对（`c_impl/src/render/pd_polyhost_render.c:112`）。我们从前把这两格
当 no-op 收下，于是任何"靠 alpha 决定看不看得见"的脚本都错。

深度测试那一半**没跟**：这一档默认深度测试是关的，参考也是（`gl_renderer.c:1020`
只由脚本的 `glEnable(GL_DEPTH_TEST)` 打开）—— 原版默认是开的，这一处偏差明写在这儿。

`glquad(mode)` 那一趟会临时改混合，完事要**还回脚本那一格状态**（原版是
`glPushAttrib`/`glPopAttrib`）—— 所以语言这一侧记一格 `gl_bl`。

### 24.2 纹理里的 alpha 要原样收（0 就是透明）

`kglsettexarray*` 把那四个字节照原样交给 GL。我们从前有一条"alpha 0 当 255"的
将就（怕 `rgb()` 造的纹理整块透明），结果 `ken/texture3d.pss` 那块 64³ 体素
（`rgba(r,g,b,(issol!=0)*48)` —— 空的地方 alpha 就是 0）整块变实心：一盏灯画成一个
渐变方块。去掉那条将就 + 接上 §24.1 之后：RMSE 65.4 → 28.8，图是一盏灯了
（剩下的差在灯罩那一圈的形状/叠加层数上）。

`rgb()` 造的纹理不会因此坏掉：那种脚本不开混合，alpha 没人看。

## 25. 第十五刀：**两处"算出来的东西本身不一样"**

### 25.1 `RND` 那台 LCG 是 mod 2^31，不是 mod 2^32

`eval.c:497` 那一行：

    kholdrand = (unsigned long)((kholdrand * (214013*2) + 2531011*2) >> 1);

Win32 的 `unsigned long` 是 32 位 —— **先绕回 2^32、再右移一位**，合起来就是
`h = (h*214013 + 2531011) mod 2^31`，而 `RND` 回的是 `h / 2^31`。
我们从前是 `mod 2^32`、读的时候 `>>1`：**状态与回值都不是同一串**
（`r ≥ 2^31` 时 `floor(r/2) ≠ r mod 2^31`）。7 份脚本用随机数，序列不同 = 图不同。

判据：把那一行抄成一份 `uint32_t` 的独立 C 程序，`srand(12345)` 之后头两个数是
`0.231451 0.584851` —— 与我们改完之后的输出逐位相同（期望写在 `tests/lib/cases.js`
的 `EVALARR` 里）。参考也是照这一行写的（`c_impl/src/eval/pd_interp.c:35`）。
账：`metaballs cube.pss` RMSE 28.41 → **0（逐像素相同）**。

### 25.2 着色器里的 `#ifdef GL_扩展名` 由翻译这一层判

core profile 里那些扩展宏**不定义**（扩展早并进核心了），而 `#define GL_…` 是 GLSL
明令禁止的（`#define of reserved name`，试过）。所以在 `glslAlign` 里就地判掉：
**我们真有的**算定义着、别的算没有，切掉的行换成空行（行号不动）。

`ken/mipmap.pss` 是唯一一份这么写的：`#ifdef GL_ARB_shader_texture_lod` 里头用
`texture2DLod(tex0,t.xy,dep)` 自己挑 mip 层、`#else` 是普通 `texture2D`。走错哪条
整张图都不一样（清清楚楚的棋盘地面 vs 糊成几条横带）。RMSE 70.7 → 52.3
（剩下的差还没定根因：两边都是 `glGenerateMipmap` + `LINEAR_MIPMAP_LINEAR`）。

## 26. 参考那一侧的一处口径差：**它的 `gl_Position` 是 NDC，不是裁剪空间**

`c_impl/src/render/gl_renderer.c:1148` 有一格优化叫 `mvp_bake`：顶点着色器里**没提过
`gl_Vertex`** 的时候，它把 MVP 在 CPU 上乘进顶点里（注释说这是 "bit-exact"）。
可那一步**连透视除法一起做了**，于是着色器里 `p = gl_Position` 拿到的是
**NDC + w=1**，而不是真 GL 的裁剪空间值。

判据（`/tmp/pz.pss` 那一份探针，两边同一份脚本、同一台 GPU）：一个 `gltranslate(0,0,-5)`
的满屏四边形，片元里印 `p.z*0.1` / `p.w*0.1` / `(p.z/p.w)*0.5+0.5` ——

* 我们：`(122,128,250)` ⇒ `p.z = 4.78`、`p.w = 5.02`（w 就是深度 5，真 GL 的样子）
* 参考：`(24,26,250)`  ⇒ `p.z = 0.94`、`p.w = 1.02`（NDC + w=1）
* 第三格两边都是 250 ⇒ **z/w 相同**，所以光栅化一样、只有那格 varying 不一样。

`polydraw_src` 那一侧 `ftransform()` 就是 `gl_ModelViewProjectionMatrix * gl_Vertex`
（固定管线，裁剪空间）⇒ **我们这一侧是对的**。

这一差只在两件事同时成立时看得见：**MVP 不是单位**（`glquad` 那一族是 NDC + 单位矩阵，
所以 `metaballs` 那类满屏后处理两边一样）**且**片元里按 `p` 的**尺度**算东西。
语料里 30 份把 `gl_Position` 写进 varying，踩上这一格的是
`town textured`（`100/pow(p.z,1.5)`）、`menger sponge`（`4000/pow(p.z,10)`）、
`funky`（`min(100/pow(p.p,3),4.8)`）这一类。

**结论（2026-09-25 查实）：这不是"它的 varying 是 NDC"这么一件小事 —— `mvp_bake`
那条路与参考自己的 uniform 那条路根本对不上**，见 §26.1。判据因此改成**把它关掉**
（`PD_NO_MVP_BAKE=1`）。

### 26.1 `mvp_bake` 与参考自己的 uniform 路对不上（尺子换档）

`town textured` 我们一格都没画出来，参考铺满 60% —— 四步二分下来不是着色器、不是批：

1. `--gfx null`（录制设备）数得出 **3528 格批**（14×14 栋 × 3 层 × 6 面），几何是发出去的；
2. 换成**常白**片元着色器：参考照旧铺满、我们照旧全黑 ⇒ 与 `p` 那格 varying 无关；
3. 把 `@v`/`@f` 两段删掉（走固定管线那一档，顶点在语言侧就变成裁剪空间）—— 还是全黑
   ⇒ 与"物体坐标 + `batchmvp`"那条路也无关；
4. **`PD_NO_MVP_BAKE=1` 让参考也变成全黑** —— 与我们逐像素相同。

于是把两边的裁剪坐标直接量出来对（`polydraw-render` 有 `PD_TRACE=x.json`，一趟把每格批的
`mvp` 与每个顶点的 `ox..cw` 全印出来；我们这侧用一份 30 行的 stub 设备接住 `gfxbatch`）：

    脚本：gltranslate(0,0,-10); glrotate(90,0,0,1); 四边形 (1,0,0)…
    我们：clip = (0, -1, 9.802, 10)
    参考（uniform 那条路）：clip = (0, -1, 9.802, 10)   ← **逐位相同**

而开着 bake 时那张 MVP 的 **z/w 两行是反号的**（拿 `PD_TRACE` 里的 16 个数与 numpy 里
`P·R20·R90·T52` 逐格比：x/y 两行一致、z/w 两行符号全反），于是它用**负的 w** 去除 ——
等于把镜头背后的东西也画出来。参考那 8 份里有 5 份两条路不一致
（`town textured` 0.60/0、`menger sponge` 0.43/0.089、`funky` 0.15/0.093、
`tree` 0.072/0.033、`clock` 0.0072/0.0052），一致的 3 份（`town no texture` /
`sphere ellipsis` / `disco ball`）说明这一格只在"MVP 不是单位 + 着色器没提 `gl_Vertex`"
时触发。

**判据因此在 `tests/eval/correct.js` 里给参考加了 `PD_NO_MVP_BAKE=1`**（理由抄在那儿；
想量回默认那一档：`OMNI_PD_BAKE=1`）。换档之后：`menger sponge` 215 → 45.4、
`funky` 48.4 → 27.6、`tree` 39.4 → 14.0。

**这一格换档还暴露了判据自己的一个洞（2026-09-25 补）**：`town textured` 换档之后从
RMSE 183 变成"逐像素相同" —— 那是**参考也变全黑了**，不是我们画对了。"两张全黑图相同"
什么都没证明，判据却给它记了一分（连着 `dominos` / `particules sparks` /
`ribbons invasion` / `snake tube` 一共五份 —— 那四份是**第 0 帧本来就没东西**：
`t = klock()` 给 0 ⇒ 粒子一个都没生、蛇缩成一个点）。现在多了一档 **`都不画`**
（两边非黑都 < 0.2% 就计红），要放行必须进 `REF_WRONG` 并写清"这一帧本来就没东西"。
那四份在第 30 帧两边都有东西（`dominos` 23.2、`particules sparks` 28.3、
`snake tube` 27.8、`ribbons invasion` **我们全黑**）—— 所以这一族的正事是
**把帧挪到有东西的那一帧**，不是让它在第 0 帧白过。

**第二条放行线也是这一趟加的**：`--pxdiff`（默认 0.5%）。RMSE 是全图平均，一小撮亮格子
差满 255 就能把它顶过线，而"一小撮"恰好是两个渲染器必然分家的那一类 ——
`05_explicit_main_and_funcs.pss` 是标本：468 格（0.46%）有差、全是那 145 个树梢小方块
近乎侧看的顶面，其余 99.54% **逐位相同**；根因是 MVP 乘在哪儿（我们按一份模型在语言侧
用 double 乘进顶点，参考关掉 bake 之后是 GPU 上 float 乘 uniform），不是画错。

**顺手记一个读数陷阱**：`magick -format "%[fx:mean]"` 把 alpha 也算进去 —— 全黑 + alpha=1
的图印出来是 `mean=0.25 max=1`，看着像"画了东西"。要看有没有画就用 `%[fx:mean.r]`。

### 26.2 `OMNI_GFX_TRACE=n`：我们这一侧也能印裁剪坐标

对账要比的是**裁剪坐标**，不是像素 —— 像素差只说明"哪儿不一样"，裁剪坐标说明"谁算错了"。
参考那侧有 `PD_TRACE=x.json`（每格批的 `mvp` + 每个顶点的 `ox..cw`），我们这侧以前得
现写一份 stub 设备接住 `gfxbatch`；现在两处设备各有一格 `OMNI_GFX_TRACE=n`
（`host/gfx-cpu.js` 的 `traceV` 与 `runtime/omni_fmt.c` 的 `gfx_tracev`，逐句相同），
印前 n 段批：`#trace 类 批号 顶点号 x y z w r g b a`。`--gfx gl` 也照印
（三档设备都从那一格过）。**一段批都没印出来**本身就是一格答案：语言那一侧把它丢了。

## 27. `glrotate` 是**转置**的 —— 我们和参考都是（2026-09-25 改回规范）

`town textured` 我们一格都没画出来，顺着 §26.2 那一格印下去，追到的不是纹理、不是着色器，
是 **`glrotate` 建的矩阵**。

### 27.1 判据：真 OpenGL 的固定管线

原版 `glrotate` 就是 `glRotated`（`polydraw.c:2141` 的 `qglRotated` —— 那张 `myext[]`
是宿主 API 的正本），所以这一格的正本就是 GL 规范。本机 20 行 C + CGL 直接问：

    glMatrixMode(GL_MODELVIEW); glLoadIdentity();
    glRotated(45, 0, 1, 0); glTranslated(0, 0, -10);
    glGetDoublev(GL_MODELVIEW_MATRIX, m);   ⇒ (2,2,0) 落在 (-5.6569, 2, -8.4853)

我们那时给的是 `(8.4853, 2, 5.4580)` —— 也就是 `R` 的**转置**（= 按 `-角度` 转）。

### 27.2 两边都错在同一处，所以"逐像素相同"没发现

* 我们这一侧：`gl-rt.js` 的 `gl_rotate` 按转置填，注释写的理由是"我们这一侧顶点是行向量"——
  **那句话是错的**：`gl_mvmul`（`gl_mv · gl_tm`）、`gl_xf`（`gl_mv · v`）、`gl_translate`
  （平移放 `m[12..14]`）整条路都是 GL 的列向量那一套，只有这一格反着。当时的"证据"是
  拿参考对的（差 2 像素）—— 那是**用错的尺子量**。
* 参考那一侧：`c_impl/src/render/gl_renderer.c` 的 `mat4_rotate` 那张 `t[16]`
  **字面量按行写、数组按列用**（注释还写着 "standard column-major"）。它的 `mat4_mul` /
  `mat4_translate` / 投影与我们逐句相同 —— **只有这一格错**。

于是两边同错、逐像素相同，而且**大多数例子在第 0 帧转角是 0**（`glrotate(t*40,…)`），
所以这一格一直藏着：58 份里只有 8 份在第 0 帧受它影响。

### 27.3 改完之后的账（两边都按规范）

判据要量"转角那一族"就得有一把对的尺子：`node tests/eval/mkref.js` 把参考整棵抄到
`.omni-cache/pdref/` 再补那一格（`make -j8` 约 40s），判据**有就自己用**
（也可以 `OMNI_PD_REF=…`）。补过之后参考画 `town textured` 从全黑变成铺满 80.5%。

我们改回规范之后（都是"两边都对"的对照）：

* `tree` 14.0 → **8.27**、`disco ball` 89.8 → **67.1**、
  `05_explicit_main_and_funcs` 9.97 → **8.96（过）**；
* `town textured` 从"两边都不画"变成两边都画（RMSE 145 —— 这一份底下还有别的问题）；
* `funky` 27.6 → 81.1、`town no texture` 91 → 111：**两处错从前互相抵掉了一部分**，
  现在露出来的是我们自己另一格没对上的东西（下一步查这两份）；
* 20 份逐像素相同一份没丢（那 20 份在第 0 帧的转角本来就是 0）。

## 28. 再两刀：`%` 不是 `fmod`、`setfov` 要到下一帧（2026-09-25）

### 28.1 `%` 是"按 |除数| 向下取整的模"

`eval.c:5141`（与 5709 那份逐字相同）：

    case PERC: p0 = (*p1) - floor((*p1) / fabs(*p2)) * fabs(*p2);

永远落在 `[0,|b|)`。我们从前当 `fmod`（向零截断），**只在负的被除数上分家** ——
`town no texture` 的楼高是 `(i*895 + j + 2) % 10`，`i = -5` 时我们 -8、正本 2，
左半城整个是另一批楼。落成生成出来的 `pd_mod(a,b)`（式子里 `a`/`b` 各出现两次，
展开会把 `rnd % 3` 那类副作用做两遍）；**编译期折常量那一格也要同一条公式**。
`FMOD(a,b)` 是另一个东西（2 参函数），照旧是真 fmod。
结果：`town no texture` 111.1 → **0**、`town textured` 145.1 → **0**。

### 28.2 `w <= 0` 不许整格丢

`gl_vertex4` 在内建着色器那条路上把 `w<=0` 的**顶点**丢掉 —— 丢一个顶点会把后面整串
顶点错位（四边形变三条边）。我们交给设备的就是裁剪空间顶点，**裁剪是 GPU 的事**
（它按图元沿近平面裁开），所以照样交。

### 28.3 `setfov` 的两格口径（参考那侧补上之后 6 份变成逐像素相同）

原版 `ksetfov`（`polydraw.c:1484`）：

    gfov = tan(fov*PI/360) * atan(yres/xres) * 360/PI

而且它**只写下 `gfov`** —— 投影是每帧开头那句 `gluPerspective(gfov,…)`
（`polydraw.c:3578`，在跑脚本**之前**）才重算：所以脚本里调 `setfov()`
**要到下一帧才生效**，第 0 帧用的还是开机那句 `ksetfov(90)`。我们这一侧本来就是这样。

参考两格都不同（实参当 fovy 直接用、当场换投影，`gl_renderer.c` 的 `GLCMD_SETFOV`），
所以 `mkref.js` 一起补了。补完这一格的账：
`sphere ellipsis` 98.5 → **0**、`menger sponge` 45.4 → **0**、`snake tube` 27.7 → **0**、
`dominos` 29.6 → **0**、`ballsk` 8.8 → **0**、`funky` 81.1 → 3.89、`balls2k` 25.3 → 0.70。

### 28.4 文件纹理的行序：**不翻**（原版就是上下颠倒着用的）

`kglsettex2`（`polydraw.c:1279`）把解出来的像素用 `kprender(..., tex.sizx*4, ...)`
（**正的 pitch**）写进 `gbmp` 再整块 `glTexSubImage2D` —— **图像第 0 行落在 `t=0`**
（GL 的"下边"）。原版的文件纹理采样起来本来就是上下颠倒的，脚本的纹理坐标照这个写。
我们从前按"CG 的原点在左下"倒着抄了一趟行。

判据（20 行探针 + `earth.jpg`）：原样 RMSE 60.78、**竖翻之后 0.45**（剩下的是两边解码器
的差，最大 5）；再拿图像自己的上下两带对账 —— `t≈0` 那一带该是图像**第 0 行**那一头
（灰度 161），参考给 162.3、我们从前给 214.5（最后一行那一头是 215）。
改完：`orthoglobe` 9.67 → **0.14**、`gspiral` 12.22 → **2.84**（两份都读文件纹理）、
`gears`（不计分）75.0 → 49.7。

**一处诚实的退步**：`cubetex`（文件立方图）39.25 → 75.31。原版立方图那条路除了不翻行，
还按 `cubemapindex = {1,3,4,5,0,2}`（`polydraw.c:1093`，文件那条路在 1338 行用它）挑面，
我们照它补上了（不补是 94.33，更远）。参考那侧的文件纹理走的是**数组那条路**
（`pd_polyhost_tex.c:220` 的 `GLCMD_SETTEXDATA`），顺着 `faces[f]` 来、没有这张表。
三种组合都量过：翻+顺序 39.25 / 不翻+顺序 94.33 / 不翻+那张表 75.31 —— 没一种对上参考，
所以**参考在立方图这一格还有别的口径**。我们这一版照 `polydraw_src` 抄，留着红。

### 28.5 这一轮之后的账

**39 过 / 18 红 / 5 不计**（**27 份逐像素相同**、11 份够近、1 份只差一小撮格子）。
剩下的按族：纹理三份（`texture` 49.2 / `mipmap` 48.4 / `texture3d` 28.8 —— 文件那一格已经
对了，剩下的在**数组/抓屏**那两条路上）、`cubetex` 见 §28.4、几何着色器两份
（`geo_test` / `geo_duptris` 全黑）、四份跑不起来（`curvybuild` / `drawcone2` /
`drawcone2_asm` / `particules morphing`）、`ribbons invasion` 我们全黑、`gpgpu` 参考全黑、
再加 `disco blur` 84.3 / `disco ball` 67.2 / `balls` 26.1 / `heightmap` 14.9 / `tree` 8.3。

`clock.pss` 裁进了不计分：它头一句是 `klock(1)`（打包的**本地日期时间**，
`polydraw.c:1662`），参考**压根不看实参**（`pd_polyhost.c:88`）所以永远 00:00:00，
而我们照正本给真日期 —— 于是**我们自己两趟都不一样**（隔 2 秒两张 `.rgba` 不同，
参考两趟逐字节相同）。前面几刀让它 RMSE 一上一下，全是这一格噪声。
顺带记着：哪天要给 `.pss` 做金标，render 模式下日期那几格也得定一个纪元。



