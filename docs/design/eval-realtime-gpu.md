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
