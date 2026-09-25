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
> 上面那张表里"本机 OpenGL = 默认"那一半还没到（默认仍是 `host`）；
> **窗口那一格 2026-09-26 落地了**（`--mode view`，正本在 §13.9）。GLSL 也不是"原文直送"了
> —— **编译期翻成对齐后的 GLSL**（§13.2/§13.7）。

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

### 13.10 已落地（2026-09-26）：**窗口与真实时帧循环**（`--mode view`，任务 #24）

`omni run x.pss --mode view` 开一个真窗口、实时跑、**关窗就退**。这一格会自己补上
`--gfx gl` 与 `--backend c`（窗口在本机 OpenGL 设备里，CPU 备选贴不了窗口；
js 腿不 dlopen 插件）。ABI 多这四个（老库上 dlsym 不到就当没有 —— 还是离屏）：

    _win(w,h,标题)        开窗口；与 `_open` **二者只调一个**
    _win_present(rgba)    把宿主合成好的那一帧贴上去 + swap + poll；回 0 = 窗口关了
    _win_input(mx,my,bst,keys[256])  输入快照（画布坐标 / 位掩码 / DOS 扫描码）
    _win_title(串)        标题栏（fps 写这儿）

**四条定下来的选择**：

1. **GLFW 是 `dlopen` 来的，不是链进来的**。这份插件本来就是"顺手编一下、拿不到就回落"
   的东西，链期依赖 `/opt/homebrew/lib/libglfw` 会让**没装 GLFW 的机器连离屏那一半都没了**。
   所以按名字找四个候选路径，找不到只回落窗口这一格；
2. **渲染路径一个字不改**：照旧画进 FBO，窗口只多一步"贴上去"。于是 view 与 render
   两档的画面是同一条路算出来的 —— 判据直接**逐字节比**（第四节，已绿）。
   代价是每帧一次 `glReadPixels` + 一次上传（320×240 = 300KB）；真要省得把宿主 2D
   那层也搬上 GPU，那是另一刀；
3. **上下文仍然由 `g_ctx` 那一格代表**：GLFW 的上下文底下也是 `CGLContextObj`，
   `glfwMakeContextCurrent` 之后 `CGLGetCurrentContext()` 存进 `g_ctx` —— 于是设备里
   几十处 `CGLSetCurrentContext(g_ctx)` 一句都不用动；
4. **`glfwInit` 只在真主线程上叫**。macho 那一档链的时候给了 512MB 主栈
   （`cli.js` 的 `-Wl,-stack_size,0x20000000`），所以 `omni_run_entry` 不开大栈线程、
   程序体就在主线程上 —— 这条腿上成立。不成立就回落（`pthread_main_np()` 先查一次，
   不去赌：`omni_r3_gl.c` 头注里那一课的上半句就是"在大栈线程上 glfwInit 会 SIGTRAP"）。

两格量出来才知道的事：

* **`nextframe` 在 view 档默认没有帧数上限** —— 收摊的是"窗口关了"。`OMNI_FRAMES=N`
  仍然管用（判据要一个能自己停下来的口子）；
* **光标不在窗口上时 GLFW 报的坐标可以是负的或超出画布**，而脚本拿它当下标
  （`drawsph(mousx,mousy,3)`）。所以设备把它**夹回画布里** —— 原版那一档的语义本来
  就是"光标在窗口里"（一开机在正中）。

判据（`tests/gl/run.js` 第四节，**15/15**）：真开出窗口 / 窗口那张帧缓冲里非黑 40892
（读在 swap **之前**，swap 之后后台缓冲未定义）/ **view 与 render 逐字节相同** /
输入那一族 view 听窗口、render 听 `OMNI_MOUSE`（探针按 `mousx,mousy` 画圆，两档重心不同）。

**还欠的一格**：vsync。`glfwSwapInterval(1)` 叫了，可量到的是 1900 fps ——
这个进程不是 .app 包、窗口没被激活，合成器没有节流它。当量尺用是好事（真帧成本），
当"看"用会白烧 CPU；要治得另开一刀（自己按时间睡，或者做成 .app 包）。

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

**一处诚实的退步**（2026-09-25 已了结，见下）：`cubetex`（文件立方图）39.25 → 75.31。
原版立方图那条路除了不翻行，
还按 `cubemapindex = {1,3,4,5,0,2}`（`polydraw.c:1093`，文件那条路在 1338 行用它）挑面，
我们照它补上了（不补是 94.33，更远）。参考那侧的文件纹理走的是**数组那条路**
（`pd_polyhost_tex.c:220` 的 `GLCMD_SETTEXDATA`），顺着 `faces[f]` 来、没有这张表。
三种组合都量过：翻+顺序 39.25 / 不翻+顺序 94.33 / 不翻+那张表 75.31 —— 没一种对上参考，
所以**参考在立方图这一格还有别的口径**。我们这一版照 `polydraw_src` 抄，留着红。

**了结（2026-09-25）**：那"别的口径"找到了，而且它是**尺子错成一整类**，不是我们的事 ——
`c_impl/src/render/gl_renderer.c` 挑面写的是 `int row = (5 - f) * fh;`
（注释："faces are stored bottom-to-top in the strip"），也就是置换 `{5,4,3,2,1,0}`；
原版那张表是 `{1,3,4,5,0,2}`。两边那一竖条在内存里次序相同（都是自上而下，§28.4 已对齐），
所以只差这一格置换。按"尺子错成一整类就补 fork"的规矩，`tests/eval/mkref.js` 加了**第三格**
补丁（照 `polydraw.c:1093` 那张表挑面），我们这一侧**一个字没改**：
**75.31 → 0.79**（有差 27.4%、最大差 29 —— 剩下的是两边 jpeg 解码器的差）。
账因此到 **43 过 / 6 红 / 13 不计**。


### 28.6 别人函数体里那格 `static` 不算这一份的全局

原版的名字表是**一张平表**（`eval.c:1802` 的 `newvarhash`，重名当场报 "already defined"），
但它是**边解析边建**的：一个名字只有在它那句 `static` **之前已经登记过**的时候才解析成
那格 static，否则赋值就地造一格函数局部量。我们把所有 `static` 一次收齐再降级，
于是"后面某个函数里的 `static v[3]`"盖住了"前面某个函数里当标量用的 `v`" ——
`ken/curvybuild.pss` 第 48 行 `for(v=0,…)` 是主函数的局部标量、第 256 行
`static v[3]` 在另一个函数里，我们于是报 `'v' 是 arr<real>，赋的值是 real`，整份跑不起来。

改法：`bodyOf` 多收一格"这是哪一份函数"，**函数体里**声明的 static 只对那一份算全局
（`文件级` 那一档照旧是真全局 —— `ken/*.pss` 的相机状态全靠它跨函数看得见）。

顺带治好一格**已经成块的又被装箱**：`static v[3]` 拿 `getperpvec(v,a,b)` 传出去时，
装箱那一趟把它改成长度 1 的箱子 ⇒ 跑起来 `array index out of range: 1 (length 1)`。
`C.arrs` 里有真长度的不许再装箱。

`curvybuild` 因此从"跑不起来"变成能量了（RMSE 85.55，下一步查）。

### 28.7 一段 `glbegin`/`glend` 超过 1024 个顶点会被静默截断

原版这儿是真 GL 的立即模式（没有上限），我们要先攒成一块再交给设备，所以 `gl-rt.js` 里有
一格 `VMAX`（缓冲一次开好 `VMAX × 16` 个 double）。它从前是 **1024**，而
`tigrou/ribbons invasion.pss` 的一条 `GL_TRIANGLE_STRIP` 是 **4000 个顶点**
（`n = 2000`，每格发两个）—— 超出的**被静默丢掉**。

这一份还偏偏把有值的槽放在尾巴上（`k = (j + nframes) % n`，写过的只有 0..帧号），
于是我们画出来**整张黑图**。追这一格的过程值得记：批还在发（124 段）、颜色也对、
`OMNI_GFX_TRACE` 印出来的顶点**全是 0**；把同一份脚本里的状态用一格探针四边形读出来
（`vx[0][0]`/`py[0]`/`ly[0][0]`）与参考**逐位相同** —— 也就是说"算得对、画不出来"。
判据上看得见的记号是**每段批 3066 个顶点**（1024 个 strip 顶点摊成 1022 个三角 = 3066），
那个数字就是上限。

改成 16384 之后 `ribbons invasion` **逐像素相同**（原来是全黑）。
**还是有上限**：更长的一段仍会截断 —— 真正的修法是"攒满就按 mode 的规矩交一段再接着攒"
（strip/fan 要把最后一两个顶点带过去、quads/triangles 要对齐），还没做。
`particules sparks` 28.3 → 29.5 是同一格的另一头（它也被截过，现在画得比参考多了一点）。

### 28.8 参考的 `noise()` 是它自己写着的"占位实现"（`heightmap` / `texture` 不计分）

`c_impl/src/eval_impl/ed_misc.c:96`："Simple hash-based noise. Not as good as Ken's,
but functional."、`:101`："Use sin-based pseudo-noise for now." —— 也就是说参考这一格
**明写着不是原版那套**。我们这一侧是照 `polydraw.c:852-960`（Tom Dobrowolski 的梯度噪声）
逐条写的，连置换表都按原版 `noiseinit()` 用的 MSVC `rand()` 重算
（`ext/polydraw/noise-rt.js` 的头注记着两处明写的偏差：float/double、`dtol` 的取整）。

一格三元探针（`noise(1.5,2.5)` / `noise(.25,7.75,3.5)` / `noise(13.125)` 塞进颜色）：
我们 (255,100,128)、参考 (209,255,133) —— **三个元数全不一样**。

于是 `heightmap`（高度场整个由 noise 定）与 `texture`（三张纹理里的第 1 张是 noise 生的、
片元里 `mod(c.x+p.x+p.y,3)` 把三张混起来）裁进不计分。`texture` 那一条**会盖住它别的差**
（抓屏那张、混合次序），修完噪声那一族之后要重裁。`curvybuild` 也用 noise（256² 的地毯纹理），
但它这一轮才刚跑起来、还没查过别的，**先留着红**。

### 28.9 `nrnd` 要把第二个正态数存下来（顺带：参考那一格有无符号回绕）

`eval.c:504-523` 的 `nrnd()`：Box-Muller 一趟出两个数，**另一个用 `static srand2` 存着，
下一次调用直接回它、一格 `krand()` 都不取**（`snormstat` 那格标志，`ksrand` 会清它）。
我们从前每趟都重算两个 —— 第二次调用起序列就与正本分家。
`ken/balls.pss` 每个球取两次 `nrnd`（16384 个球），于是整张图每个像素都不一样
（RMSE 26.07、**非黑格数只差 40**：覆盖一样、颜色全错，这个形状就是"随机序列错位"的指纹）。

**参考那一侧另有一格**：`c_impl/src/eval/pd_interp.c:46` 写的是
`(double)(pd_krand() - 1073741824u)`，而 `pd_krand()` 回 `unsigned long`（这台机器 64 位）
⇒ 取到的数小于 2^30 时**整个回绕成约 1.8e19**，`r = x²+y²` 当场 ≥ 1、那一对被拒 ——
它的 Box-Muller 只收得下"两个数都 ≥ 2^30"的采样（等于只取第一象限）。
正本那儿是 **signed long**，x/y 落在 -1..1。所以 `balls` / `particules sparks` 进不计分，
`particules sparks` 那一条**会盖住它别的差**（`glalphaenable` 那一族），以后要重裁。

### 28.10 `gllinewidth` 是 no-op —— **可是 `tree` 那 8.27 不是它**（2026-09-25 量翻了）

`tree.pss` 画两趟：`GL_QUADS` 那趟抓进槽 0、`GL_LINE_STRIP` 那趟**先 `gllinewidth(2)`**
再抓进槽 1，最后拿着色器 1 把两张合起来。我们这一侧 `gllinewidth/1` 在名字表里直接是
`gl_nop1`（`ext/polydraw/gl-rt.js:226`），于是原来的判断是"线只有 1 像素宽 ⇒ 合成出来不一样"，
下一步该"在语言那一侧把宽线摊成三角带"。

**这条判断错了。**一份三行探针（三条线，`gllinewidth(1)` / `(5)` / `(11)`，别的全一样）：

* 参考：三条线**各 160 格**（= 320 宽的一半、**都只有 1 像素**）；
* 我们：**逐格相同**（也是 160 / 160 / 160）。

也就是说**参考也没做宽线** —— core profile 里 `glLineWidth>1` 本来就被钳成 1
（它那句 `glLineWidth(c->a)`（`gl_renderer.c:1347`）在这台机器上是空转）。
所以这一族**没有判据，也没有活要做**：照抄"摊成三角带"反而会让我们比参考粗、把账做坏。
（真要与**原版**对齐是另一回事 —— 原版跑在兼容管线上，宽线是真的。哪天有了原版的输出
再说，那时也该顺手把 §28.13 那一族一起重裁。）

`tree` 那 8.27 的真形状：两边覆盖几乎一样多（我们 5707 格、参考 5533 格），
而且**互有独占**（我们独有 848、参考独有 674）—— 是"同样多的东西落在稍微不同的格子上"，
不是"我们细一半"。两趟抓屏 + 着色器合成那条路上还有别的口径，留着红、根因未定。

### 28.11 **面剔除**那一族（接上了；`disco ball` 67.2 **不是**它）

`glEnable(GL_CULL_FACE)` 在 `gl_enable` 里只认 `GL_DEPTH_TEST`、别的 cap "收下不管"，
而 `glcullface/1` 在名字表里直接是 `gl_nop1`（`ext/polydraw/gl-rt.js:225`）——
**剔除这一族一格都没接**。`tigrou/disco ball.pss` 第 7 行就是
`glcullface(GL_FRONT); //helps a lot`（一颗由小面拼的球，剔掉正面才看得见里侧那些镜片），
我们把两面都画上去 ⇒ RMSE 67.2。语料里还有三份用它：
`ken/texture.pss`（两趟交替 `GL_BACK`/`GL_FRONT`）、`ken/curvybuild.pss`、`ken/heightmap.pss`
—— 也就是说这一格同时压着现在还红的 `disco ball` / `curvybuild`（`texture`/`heightmap`
已因噪声不计分）。

接法照 `gldepth` 那一格的先例（状态一变先 `gl_flush` 再转给设备）：加一格
`(gfxcall "glcull" 0|1|2)`（关 / 剔背面 / 剔正面），四处设备各补一小段
（`runtime-gl/omni_ev_gl.c` 真 `glEnable(GL_CULL_FACE)`+`glCullFace`、
`runtime/omni_fmt.c` 的转发表、`studio/gfx-gl.js` 的 WebGL、`host/gfx-cpu.js` 的 CPU 备选
按定向面积判）。**试着接过一趟又退回来了（2026-09-25）**，量出来的结论值得记：六处都接上
（`gl_cullface` -> `(gfxcall "glcull" 模式)`、本机 GL 的 `glEnable(GL_CULL_FACE)+glCullFace`、
C 腿转发表、napi、WebGL、CPU 备选收下不管）之后

* 默认的 `glFrontFace(GL_CCW)`：`disco ball` 67.2 → **118.4**（我们非黑 9583 对参考 23309 ——
  **剔掉的正是该留的那一半**）、`curvybuild` 85.6 → **188（几乎全黑）**；
* 改成 `glFrontFace(GL_CW)`：`disco ball` 67.05、`curvybuild` 85.55 ——
  **与压根不剔几乎一样**（也就是说这一档下几乎没有面被剔掉）。

两头都不对 ⇒ **我们这一侧三角的绕向与 GL 的正面约定不是一件事**（很可能出在 mode 展开那一步：
四边形拆两个三角、strip/fan 的奇偶次序）。绕向没理清之前接剔除只会把账做坏，所以这一趟
`git checkout` 退回去了。**正事的次序是：先把展开后的绕向对齐真 GL，再接剔除。**

**（2026-09-25 续）绕向那一格查出来并且改了**：`GL_TRIANGLE_STRIP` 的第 k 个三角，
GL 定的是 k 为奇数时**前两个顶点换位**（`(k+1, k, k+2)`），为的是整条带绕向一致。
我们从前一律 `(i-2, i-1, i)` ⇒ 一半的三角是反的。光栅化看不出来（三个点一样、
颜色按重心插值也一样），所以那 28 份逐像素相同的例子一份都没变
（`ribbons invasion` / `snake tube` / `sphere ellipsis` / `sphere` 重量过，照旧 0.00）——
**只有剔除会让它现形**。这一格已经照 GL 改了。

**（2026-09-25 再续，这一族接上了）先纠一条我自己记错的**：上面那句"`polydraw.c:1598` 的
`kglCullFace` 只有 `glEnable` + `glCullFace`、正面是 GL 默认的 CCW"是**错的** ——
正本第 1605 行明明白白就是 `glFrontFace(GL_CW);`：

```c
double kglCullFace (double mode)
{
	int imode; imode = (int)mode;
	if (imode == GL_NONE) { glDisable(GL_CULL_FACE); return(0.0); }
	glEnable(GL_CULL_FACE);
	glCullFace(imode);
	glFrontFace(GL_CW);                 /* polydraw.c:1605 —— 正面是顺时针 */
	return(0.0);
}
```

也就是说**这门语言的正面约定是 CW，不是 GL 默认的 CCW**；参考 `c_impl` 在这一格上是**忠实的**
（它那句注释也没说错），第三趟"把 fork 里的 CW 去掉"本身就是照着我记错的那条去量的 ——
量出来两边一起剔空，恰恰是因为**两边都被我改错了**。

**判据用一份最小探针立起来了**（照抄就能再跑一趟 —— 三份只差 `glcullface` 那一句：
`GL_NONE` / `GL_FRONT` / `GL_BACK`）：

```c
()
{
   glClear(GL_COLOR_BUFFER_BIT);
   glcullface(GL_FRONT);
   gltranslate(0, 0, -2);
      //左：红，屏幕上逆时针（y 朝上）
   glcolor(1,0,0); glbegin(GL_QUADS);
   glvertex(-1.0,-0.5); glvertex(-0.1,-0.5); glvertex(-0.1,0.5); glvertex(-1.0,0.5);
   glend();
      //右：绿，屏幕上顺时针
   glcolor(0,1,0); glbegin(GL_QUADS);
   glvertex(0.1,-0.5); glvertex(0.1,0.5); glvertex(1.0,0.5); glvertex(1.0,-0.5);
   glend();
}
```

（参考：`PD_NO_MVP_BAKE=1 polydraw-render x.pss --frame 0 --w 320 --h 240 --fovy 73.7398 -o x.png`；
我们：`node src/cli.js run x.pss --gfx gl --frame 0 --w 320 --h 240 -o x.rgba`。）两边各跑一趟：

* `glcullface(GL_FRONT)`：**红（CCW）留、绿（CW）剔** —— 两边都是，位置逐格相同（x 80..151）；
* `glcullface(GL_BACK)`：**绿留、红剔** —— 两边都是（x 168..239）；
* `glcullface(GL_NONE)`：**我们两个都留**（照 `polydraw.c:1602` 关掉剔除），
  **参考只留绿的** —— 它那格 `GLCMD_CULLFACE`（`gl_renderer.c:1339`）**压根没判 mode 0**，
  于是 `glEnable(GL_CULL_FACE)` + `glCullFace(0)`（非法值，状态照旧 `GL_BACK`）。
  这是参考的一格偏差；语料里**没有一份用 `GL_NONE`**（4 份用它的全是 `GL_FRONT`/`GL_BACK`），
  所以不影响账。

于是六处照口径接上（`gl_cullface` -> `(gfxcall "glcull" 0|1|2)`、本机 GL 与 WebGL 两台设备
各自 `glEnable(GL_CULL_FACE)+glFrontFace(GL_CW)+glCullFace(…)`、C 腿转发表、napi、
CPU 备选收下不管），量出来：

* `ken/texture.pss`（不计分）：**49.18 → 8.20**（那一份最大的一块就是这个）；
* `tigrou/disco ball.pss`：67.24 → **67.05**（我们非黑 26448 → 26233、参考 23309）——
  **这一份的差不是剔除**：两边在探针上逐格一致，可同一个模式下我们只剔掉 215 格、
  参考剔掉 3000 多格 ⇒ 差在**发出去的几何**（那些镜片的顶点次序/朝向），得另查；
* `ken/curvybuild.pss` 85.55、`ken/heightmap.pss` 14.92：**都没动**（各自另有根因）。

判据：`tests/lower/run.js polydraw evaldraw` 44/44、`tests/gl/run.js` 11/11 照旧。

**上面第二、三趟那两段结论作废**（留着当记录）：第二趟说"尺子多钉了一句原版没有的
`glFrontFace(GL_CW)`"、第三趟照那条把 fork 里的 CW 去掉之后量到"`curvybuild` 两边一起剔空、
`disco ball` 122.41"，**根子都是我把正本第 1605 行看漏了**。尺子在这一格上没错，
第三格 fork 补丁不该加（已退回，尺子照旧只补 `mat4_rotate` / `setfov` 两格）。

留下的教训一条：**"参考错"这个判断要指到源码的行号上**，指不到就先当自己错 ——
这一族为此白绕了两趟。

### 28.12 这一轮之后的账

**40 过 / 13 红 / 9 不计**（**28 份逐像素相同**、11 份够近、1 份只差一小撮格子；
跑不起来从 4 份降到 3 份、全黑从 3 份降到 2 份）。**（2026-09-25 续：剔除与几何段两刀之后
是 40 过 / 11 红 / 11 不计** —— `geo_test` / `geo_duptris` 从"黑图"变成"参考错"，见 §28.14。）
剩下的按族：纹理三份（`texture` 49.2 / `mipmap` 48.4 / `texture3d` 28.8 —— 文件那一格已经
对了，剩下的在**数组/抓屏**那两条路上）、`cubetex` 见 §28.4、几何着色器两份
（`geo_test` / `geo_duptris` 全黑）、四份跑不起来（`curvybuild` / `drawcone2` /
`drawcone2_asm` / `particules morphing`）、`ribbons invasion` 我们全黑、`gpgpu` 参考全黑、
再加 `disco blur` 84.3 / `disco ball` 67.2 / `balls` 26.1 / `heightmap` 14.9 / `tree` 8.3。

`clock.pss` 裁进了不计分：它头一句是 `klock(1)`（打包的**本地日期时间**，`polydraw.c:1662`），参考**压根不看实参**（`pd_polyhost.c:88`）所以永远 00:00:00，
而我们照正本给真日期 —— 于是**我们自己两趟都不一样**（隔 2 秒两张 `.rgba` 不同，
参考两趟逐字节相同）。前面几刀让它 RMSE 一上一下，全是这一格噪声。
顺带记着：哪天要给 `.pss` 做金标，render 模式下日期那几格也得定一个纪元。

### 28.13 尺子的第四格偏差：**固定管线那条路上，矩阵一变、后面那一批就不见了**

查 `disco ball` 的 67 时顺手量出来的，判据是一份三格探针（`tigrou/` 底下临时放、量完删）：
同一个四边形画两次（红一次、绿一次），中间夹一句矩阵操作。

```c
()
{
   glClear(GL_COLOR_BUFFER_BIT);
   gltranslate(0, 0, -4);
   glcolor(1,0,0); glbegin(GL_QUADS);
   glvertex(1.4,-0.2); glvertex(2.0,-0.2); glvertex(2.0,0.2); glvertex(1.4,0.2);
   glend();
   gltranslate(-3.4, 0, 0);          //<- 换成 glrotate(45,轴) / glscale(.5,.5,1) 都一样
   glcolor(0,1,0); glbegin(GL_QUADS);
   glvertex(1.4,-0.2); glvertex(2.0,-0.2); glvertex(2.0,0.2); glvertex(1.4,0.2);
   glend();
}
```

量出来（320×240、fovy 73.7398、第 0 帧）：

* `gltranslate`：我们绿块落在 x80..103（**与"直接把四边形写在 -2.0..-1.4"那一份逐格相同**，
  所以我们这一档有旁证）；**参考只有红块，绿块整个不见**；
* `glrotate(45,轴)`（三个轴都试了）：我们绿块落在 x194..221 / y58..85 ——
  中心 (207.5, 71.5) 与手算的 (208, 72) 对得上（`+x` 转到 `+y`，**真 GL 的逆时针**，
  这也再一次证明 §27 那一刀改对了）；**参考三个轴都只有红块**；
* `glscale(.5,.5,1)`：我们绿块变小；参考仍然只有红块；
* **对照两份**：中间什么都不夹（两个四边形写在不同位置）两边**逐格相同**；
  中间夹 `glpushmatrix(); glrotate(45,0,0,1); glpopmatrix()`（净变化为零）两边也相同。

也就是说：**净变化为零就好，一变就丢** —— 丢的是"矩阵变了之后那一段批"。
`PD_NO_MVP_BAKE=1` 与参考默认（bake 开着）**两档都这样**，所以不是 bake 那一格。
机理在它那侧（`batch_append` 的 MVP 一变就 `flush_batch`，`gl_renderer.c:730`；
默认 program 那条路上 `rd->u_mvp` 与 batch 的 MVP 对不上），不深追——
**要紧的是这一族的判据不可信**：脚本**没有 `glsetshader`**（走内建那对）**而且矩阵与图元交错**时，
参考那张图是缺东西的。已知落在这一族里的：`02-gl.pss` / `02_primitives_noshader.pss`
（早就在 `REF_WRONG` 里，原因这回算是找着了）、`tigrou/ribbons invasion` 等几份。
**不按名字一刀切**（同一族里 `town textured` / `sphere` / `examples/opengl/*` 大多是
"每帧先摆好矩阵再画" ⇒ 只有一批 ⇒ 判据仍然有效，现在也确实逐像素相同）——
要逐份拿证据再裁，规矩见 §28.11 末尾那条。

顺带排掉的两条：`disco ball` 那 2924 格差**不是**剔除、**也不是** `glrotate` 转向
（两份探针都逐格对上参考）。它剩下的形状是：同一档 `GL_FRONT` 下我们的覆盖是参考的
**严格超集**（参考独有 0 格）、而 `GL_BACK` 那一档我们只剩 9583 格（参考 24976）——
下一步得按批对照（glspy 那种手法，`reference_glspy_tool`）才看得清。

### 28.14 几何着色器那两份：按正本接上了（参考压根没有几何段）

`ken/geo_test.pss` / `ken/geo_duptris.pss` 现在的账是"黑图"（我们 0 格、参考 8312 / 11342 格）。
动手之前先查了两边，两侧**各有一格错**：

**正本的口径**（`polydraw.c:2210`）：`GLSETSHADER($,$,$)` 是 **(v, g, f)** ——
`kglsetshader3(st0,st1,st2)` 把三个名字分别当**顶点 / 几何 / 片元**查
（`polydraw.txt:350` 也写着 `glSetShader("vnam","gnam","fnam")`）。
段首那一行是 `@g,输入图元,输出图元,最大顶点数:名字`（`polydraw.txt:203-205`）。

**参考错在两处**：`rh_glSetShader`（`pd_polyhost_tex.c:352`）的注释写的是
`glsetshader(vname, fname[, gname])` —— 它把**第二个实参当片元名**查、第三个**压根不看**；
而且整份 `c_impl` 里 `PD_SEC_GEOMETRY` 只在切段那儿赋过值
（`pd_section.c:54`），**没有一处消费它** —— 它从来不编、也不挂几何段。
所以参考那两张图是"顶点 + 第 0 号片元"画出来的**普通三角**，不是几何段的输出。

**我们错在**：`splitSections` 的段首正则 `^@([vgfh]?)(?::([A-Za-z0-9_$]+))?`
（`ext/polydraw/adapter.js:178`）碰上 `@g,GL_TRIANGLES,GL_TRIANGLE_STRIP,15:g`
只吃到 `@g`、**名字与那三个参数一起丢了**（段落拿到内部名 `$N`）⇒
`glsetshader("v","g","f")` 找不着 `g` ⇒ 这一趟什么都没画（还是**静默**的，连一句话都没报）。

**所以这一族不能拿参考当尺子**（照它做等于把几何段扔掉 —— 那是"对着错的答案抄"）。
按正本做，三步都在编译期那一层（设备只多了"挂第三段"那一句）—— **2026-09-25 落地了**：

1. 段首那一行照 `polydraw.txt:203` 解出**名字 + 三个参数**（`splitSections` 的正则加了
   `((?:,[^:\n]*)?)` 那一格，参数落在 `geo` 上）；翻译时写成
   `layout(triangles) in; layout(triangle_strip, max_vertices = 15) out;`；
2. `glslGeom`（`ext/polydraw/glsl.js`）：`gl_VerticesIn` -> `gl_in.length()`、
   `gl_PositionIn[i]` -> `gl_in[i].gl_Position`、`gl_FrontColorIn[i]` / `gl_TexCoordIn[i][0]`
   -> 顶点段那两格跨段量的数组形式、`gl_FrontColor` / `gl_TexCoord[0]`（写）-> 这一段的 out、
   `gl_ModelViewProjectionMatrix` -> `u_mvp`；`#version 1xx` 与 `#extension` 那两行换成空行
   （行号不动）。段里自带 `#version 3xx/4xx` 的原样回。
3. **跨段量的名字**按一条链走：顶点出 `gv_*` -> 几何 `in gv_*[]` / `out v_*` -> 片元读 `v_*`。
   `hasGeom` 是**整份脚本**的属性（段落都来自同一份文件，而 `glsetshader` 的配对是运行期的事）。
   由此带来一格**明写偏差**：正本里 `glsetshader(v,f)` 与每帧那句 `qglsetshader(0)` 的 gshad 都是
   -1（旧式 GLSL 的跨段量全是内建名，随便配都接得上），而我们显式声明之后，这条链上的 v/f
   **只有经过几何段才接得上** —— 所以设备那侧补了一句：`gi < 0` 而顶点段里有 `gv_col0` 时
   挂上第一份几何段（`omni_ev_gl.c` 的 `ev_use_program`）。
   `glsetshader` 三个实参的次序照正本认成 **(v, g, f)**；几何段那一格**只按名字找、找不着就没有**
   （`ev_sh_name_at`，照 `kglsetshader2` 的空名字那一档），不夹成第 0 份。

**顺手治好的一格：`uniform` 数组的句柄加法。** `geo_duptris` 写
`env = glGetUniformLoc("env"); glUniform4f(env+1, …)` —— 真 GL 里数组元素的位置是**连着的**，
而我们两档设备的句柄是**自己那张表的下标**，于是 `env+1` 指到一个空槽、`env[1]` 从来没被设上
（那一份的片元是 `… * env[1].rgba` ⇒ **整张图全黑**，还是静默的）。
两档都改成：登记 `名字` 时顺手把 `名字[1]`、`名字[2]`… 挨着登记（停在第一个查不着的下标）——
于是句柄上的加法成立。**为什么不直接回 GL 那个位置**：WebGL 的位置是不透明对象，
两档要同一个模型。

**WebGL2 那一档做不到几何段**（GLSL ES 300 压根没有），所以 `useProgram` 里见到
`gv_col0` 就**当场报**"这一档没有几何着色器，只有 `--gfx gl` 跑得了"，不静默链一个错的。

量出来（第 0 帧、320×240）：`geo_test` 我们 12302 格（参考 8312）、
`geo_duptris` 我们 36060 格（参考 11342）。两份都**从全黑变成了讲得通的图**：
`geo_test` 是三个顶点各一个贴图小方块（按各自顶点色染）加中间那张贴图三角；
`geo_duptris` 是输入四边形按 `xyzw`/`yxzw`/两个取反发四趟，出来那个风车形的框 ——
都与几何段里写的那几行一一对得上。两份记进 `REF_WRONG`（证据就是上面那两处源码行号）。
判据：`tests/gl/run.js` 11/11、`tests/lower/run.js polydraw evaldraw` 44/44、`check:self` ok、
`drawsph` / `drawsph_asm` / `metaballs` / `metaballs cube` / `04-shader` 照旧逐像素相同。

### 28.15 `mipmap` 那 48.4：两边跑的不是同一段片元代码（参考掉进 `#else`）

`ken/mipmap.pss` 的正事是"拿鼠标 Y 挑 mip 层"：片元里
`#ifdef GL_ARB_shader_texture_lod` -> `texture2DLod(tex0,t.xy,dep)`、`#else` -> 普通 `texture2D`，
`dep = 2^(mousy/yres*3)-1`。两行探针（同一个 `#ifdef`，有那个扩展画红、没有画绿）量出来：
**参考绿、我们红**。参考把着色器编成 `#version 330 core`，core profile 里那些扩展宏**不定义**
（扩展早并进核心了）⇒ 它走了给老硬件的兜底那条；原版跑在真 GL 的兼容管线上，
驱动是定义那个宏的（`texture2DLod` 在片元里本来就只有那个扩展才有）。
我们照原版走 LOD 那条（`ext/polydraw/glsl.js` 的 `GLSL_HAVE`）⇒ 第 0 帧我们是第 7 层
（256² 的第 7 层 ≈ 一片灰）、参考是清清楚楚的棋盘。**对不上才对**，记进 `REF_WRONG`。

排掉的三个嫌疑（都用探针量的，省得下次重查）：

* **`^` 是幂不是异或**：`eval.txt:76` 明写着，探针 `(2^3)/16` 两边都是 128（= 8/16）——
  两边都对；
* **`xres`/`yres`/`mousy` 两边一样**：探针把它们编进颜色里，两边都是 `(82,61,61)`
  = 320 / 240 / 240；
* **mip 是两边都生成的**：参考 `gl_renderer.c:1608` 与我们 `omni_ev_gl.c` 都在
  `filter >= KGL_MIPMAP` 时 `glGenerateMipmap`；`KGL_MIPMAP*` 那四格的号照正本
  （`polydraw.c:191`，`MIPMAP3=2<<4` … `MIPMAP0=5<<4`）。

**一格还没判的口径**（两边一样所以量不出来）：`mousy` 开局两边都是 240 —— 参考定死
`480/2`（`pd_polyhost.c:22`）、我们照它写的（`host/gfx-cpu.js` 的 `mx/my`），
可正本说的是"光标在窗口正中" ⇒ 320×240 那一档本该是 **(160,120)**。
`mipmap` 这一份对它最敏感（`dep` 直接由 `mousy/yres` 定）。哪天拿到原版的输出要重裁。

### 28.16 `goto` **跳进块里**那一档（`drawcone2` 两份跑起来了）

`ken/drawcone2.pss` 的 `singsph:` 在 `if {}` 里头，而 `goto singsph` 在**函数体那一层**
（`:315`）—— 护卫那一招（`stmtsOf` 头上那段）只退得出去、退不进去，于是从前当场报
"找不到往前跳的那个标号"，两份都跑不起来。

落法是**照抄那一段**：标号到它所在那格语句表末尾的那几句，原样在跳转点再降一份；
**前提是那一段不会走到底**（末句是 `goto`/`return`）—— 不然抄完还要接着往下走，
就不是同一件事了（不满足就照旧报，话里写着为什么）。`drawcone2` 那一段末句正是
`goto skipcone`，而 `skipcone:` 在函数体这一层、`goto` 在它前头 ⇒ 抄进来那句照旧走旗子
那条路。原处那一段照旧留着（顺着走下来的那条路要用），代价是代码多一份。
标号那张表（`C.innerLabels`）**按函数算**，另有一格 `C.expanding` 防自套。

顺手补上 `glprogramlocalparam`（5 个实参）：**ARB 汇编专用**（`polydraw.c:2110`，走
`glProgramLocalParameter4fARB`），与已有的 `glprogramenvparam` 同一句话 —— core profile
没有 ARB 汇编那条路，参考也是 no-op（`pd_polyhost_tex.c:613`），收下不管。
`drawcone2_asm` 就卡在这一格上（跳转那一刀之后才露出来）。

量出来：`drawcone2_asm` **7.77、只差 247 格（0.24%）⇒ 过**（"够近"那条线）；
`drawcone2` 10.13、差 2409 格（3.1%）—— 还红着，但从"跑不起来"变成了"差一小撮"。
判据：`tests/lower/run.js polydraw evaldraw` 44/44（`.kc` 那几份 goto 照旧）、`check:self` ok。

### 28.17 **换行当分号**（最后一份"跑不起来"没了）

`tigrou/particules morphing.pss:49` 的 `glscale(3,3,3)` 后头漏了一个分号。正本的解析器
不是文法驱动的：它按 `;` 把一块块切开、一块一块 `parsefunc`（`polydraw_src/eval.c`），
所以两个调用挤在同一块里它照样认。

我们是 GLR —— **硬往文法里加"分号可省"会把语句串成一片歧义**，所以改成在**卡住的那一刻**补：
分析失败、而且卡住那一格记号与上一格之间**有换行**（且上一格不是 `;`/`{`/`}`），
就在那儿插一格 `;` 再来一趟，最多 16 次；还是过不去就拿**原文那一趟**的诊断报
（不是插过分号那一趟的 —— 那会把人引到错的行上）。

**本来能过的程序一个字都不会变**（只有失败才走到这条路上）—— 这是这格口径最要紧的一点，
也是为什么它不该长在文法里。落点：`lower/drive.js` 的 `asiParse`，开关是登记处
（`lower/langs.js`）那一行的 `asi: true`（EVAL 两门都开）；公共 GLR 驱动只多一格
**出参** `hint.failAt`（卡在哪一格记号上，不影响分析）。

量出来：`particules morphing` 从"跑不起来"直接到 **0.00 逐像素相同**。
于是 **"跑不起来"那一档清零**，账到 **42 过 / 8 红 / 12 不计**。
判据：`tests/lower/run.js polydraw evaldraw` 44/44、`check:self` ok。

### 28.18 `curvybuild` 那 85.55 裁进"参考错"（两条都指到源码上）

**几何是对的**：两张图摆在一起看，轮廓、那块高光的位置逐格对得上 —— 差全在表面的图案上。

1. **它那两张纹理全是 `noise()` 生出来的**（`:44-59`：地毯那张整张、木纹那张一半），
   而参考的 `noise()` 是它自己写着的占位实现（§28.8）—— 这一族早裁过（`heightmap` / `texture`）；
2. **参考还把纹理槽认错了**：脚本 `glbindtexture(0)` 画一组、`glbindtexture(1)` 画另一组
   （`:94`/`:130`），正本 `qglBindTex`（`polydraw.c:1464`）是 `glBindTexture(tex[i].tar, i)`
   —— 槽号就是纹理对象号。我们那一大片是**木板纹**（`min(x%32,15)*0x040302` 那一段
   与噪声无关，所以板缝一定看得见），参考那一片是**没有板缝的灰噪点** = 地毯那张（0 号槽）。
   一份探针（0 号槽全红、1 号槽全绿，两个四边形各绑一个）：我们左红右绿、逐格对；
   参考那一趟两个四边形**都是白的**（它连纹理都没采上）。

账到 **42 过 / 7 红 / 13 不计**。剩下 7 红：`disco blur` 84.3 / `cubetex` 75.3 /
`disco ball` 67.1 / `texture3d` 28.8 / `drawcone2` 10.1 / `tree` 8.3 / `gpgpu`（参考全黑）。
（`cubetex` 在 2026-09-25 靠"补尺子第三格"了结 —— 见 §28.5 末尾，账因此到
**43 过 / 6 红 / 13 不计**。）

### 28.19 `texture3d` 那 28.8：**"摊平下标"这个旧结论作废**，下一步在 3D 上传那一格

两张图摆在一起：参考是一盏形状干净、颜色平滑渐变的台灯；我们的灯罩**摊开了**、
颜色还分成一块块硬边（红/绿/黄）。灯座与灯柱两边一样。

排掉的两个嫌疑（都用探针量的）：

* **三维数组给一格下标是"摊平"** —— 从前把这一格记成这一份的根因（`static buf[SIZ][SIZ][SIZ]`
  却写 `buf[i]`）。探针：`static a[2][3][4]; a[5]=1;` 之后读 `a[0][1][1]`（= 0*12+1*4+1）
  与 `a[0][0][5]`，两边都是 `(255,0,255)` ⇒ **两边一样、都摊平，这条作废**；
* **几何** —— 那一大堆视平面切片的位置只由 `mousx`/`mousy` 定（`ha = mousx/xres*2π`、
  `dep = mousy/yres*4`），两边的 `xres/yres/mousx/mousy` 已经量过是一样的（§28.15）。

剩下的形状：脚本按 `iz -> iy -> ix`（x 最快）写满那块 64³，正好是 `glTexImage3D` 要的次序；
着色器采的是 `texture3D(tex0, vec3(t.s,t.t,t.p))`。我们这一侧的 3D 上传是直白的
`glTexImage3D(GL_TEXTURE_3D, 0, GL_RGBA8, w, h, d, …)`（`omni_ev_gl.c:697`）。

**混合那一格也排掉了**：参考的 `glAlphaEnable` 与我们同口径（`pd_polyhost_render.c:112`：
关深度 + 开混合 + `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`）。
**纹理里的 alpha 我们是认的**：一份探针（2×2 全 `rgba(255,0,0,48)` 的数组纹理，
开 `glAlphaEnable` 画在黑底上）我们出 `(48,0,0)` —— 正是 48/255 混上去该有的数。

**顺带记一格探针上的怪事**（下一轮的线头）：那两份**数组纹理**的最小探针
（这一份与 §28.18 那份绑槽的）在参考那侧都画成**纯白** —— 它连纹理都没采上，
而同样用数组纹理的 `curvybuild` / `texture3d` 它却采得上。也就是说参考的
`glsettex(槽, 数组, …)` 在某种最小写法下会静默失效；查清了才好拿它当这一族的尺子。

## 29 实时性那一轴：`disco ball` 从 370ms/帧 推到 183ms/帧（第一轮两刀）

判据是 `tests/eval/perf.js` 的实时那一栏（每帧 ≤ 16.7ms = 60fps；四份重例子）。
起点（`tigrou/disco ball.pss`、60 帧、320×320）：**js 370.1ms/帧、c 235.5ms/帧，参考 36.6ms**。

**先量**（`npm run prof:self -- run … --gfx gl --frames 12`）：`batch` 自用 40%
（那一栏里含着 N-API 与 GL 的时间）、`env` 5%（**热路径上读环境变量**）。
再用 `OMNI_GFX=null --perf` 数设备调用：一帧 **179742 句**
（`gfxbatch` 19970、`batchmvp`/`batchmv` 各 79880 = 一段批 8 句）。

### 29.1 两刀

**一、设备那一层别重复发**（`src/runtime-gl/omni_ev_gl.c`）：

* `u_mvp`/`u_mv` 与四格属性的位置**按 program 记住**（`g_loc`）——
  从前每段批 6 句**按名字查**（驱动那侧是字符串比较，微秒级）；
* float 缓冲**复用**（`g_vbuf` + `realloc`）—— 从前每段批一次 `malloc`/`free`；
* 属性指针只在"换了 program 或常量属性动过"时重设（`g_vattr_dirty`）——
  从前画完把四格数组全 disable、下一段又全设一遍；
* 深度 / 剔除 / 混合 / program / 视口 / FBO 走**影子状态**，只在真变了时才发。

**二、断批的线从 `glEnd` 挪到"矩阵要变"**（`ext/polydraw/gl-rt.js` 的 `gl_mvdirty`）：
可编程管线那一档位置是物体坐标、变换随批走，所以真正要断批的是**矩阵变了**那一刻，
不是 `glEnd`。一片镜片是 `push/translate/rotate/rotate/scale` + **5 组 `glBegin/glEnd`** + `pop`
—— 五组之间矩阵一个字没变，从前断成 5 段、矩阵发 5 遍。
（宿主那侧同时把 `recOn()`/`traceV()` 读环境变量那两句改成只读一次。）

### 29.2 量出来的账（同一条命令、同一台机器）

* 设备三刀之后：js 370.1 → **274.7**、c 235.5 → **208.8**；
* 批合并之后：js → **182.9**、c → **127.3**（设备调用 179742 → **35958**，批 19970 → 3994）。

**正确性一格没动**：`tests/gl/run.js` 11/11、`tests/lower/run.js polydraw evaldraw` 44/44，
`disco ball` 67.05 / `texture3d` 28.82 / `tree` 8.27 与改之前逐位相同，
`town textured` / `drawsph` / `snake tube` / `menger sponge` / `creepers_asm` / `04-shader` /
`06-texture` 照旧逐像素相同。

### 29.3 下一轮的线头（按预计收益排）

1. **语言那一半**：现在每帧还要写 ~120k 个顶点 × 16 个 double。c 腿 127ms 里
   `--gfx null`（设备零成本）量到 154ms/帧 ⇒ **瓶颈已经从设备挪到语言侧的顶点装配**。
   两条路：顶点结构体一次写满（别走通用的 `$aset` 边界检查）、或者
   **`batchmvp`/`batchmv` 一句发 16 个数**（现在一句发一列 = 一段批 8 句宿主调用）；
2. **jit 那一档修好**：`--backend jit` 现在报 `gfx_call.string 要 14 个实参，实得 1`
   —— 它是"改完立刻能跑"那条路（不等 cc），实时那一栏最该跑的就是它；
3. `interp` 那一档在这一份上跑不起来（另有账）。

### 29.4 第二轮三刀：`int()` 内联 / 名字按指针认 / 一整张矩阵一句（2026-09-25）

**先量再改**。`--gfx null`（设备零成本）那一档用运行期采样器量原生腿：

```
node src/cli.js build "…/disco ball.pss" -o /tmp/db.bin
OMNI_GFX=null OMNI_FRAMES=30 OMNI_PROF=sample:997 OMNI_PROF_OUT=/tmp/db.folded /tmp/db.bin
```

第一张表把上一轮的猜想**推翻了**：栈顶 52.4% 是 `omni_trunc`，`omni_gfx_call` 那串
101 个 `strcmp` 只有 0.2% —— 录制那一档在链子的第一格就回了，压根走不到那串比较。

三刀（按量出来的顺序）：

1. **`int(real)` 在调用点内联**（`src/runtime/omni.h` + `omni_int.c`）。方言里 real 是唯一的数，
   所以每个 `a[i]` 都要过一趟 `int()`：一帧 12 万顶点 × 16 格 ⇒ 一个跨编译单元的真调用
   （`isfinite` + `trunc` + 两次范围判，-O0 的 clang 与 tcc 都内联不了）。
   宏的快路只认 **|v| < 2^53**：那一段里 `(int64_t)v` 与 `trunc(v)` 逐位相同，一次比较就够；
   NaN/Inf 与 2^53 以上落 `omni_trunc_oob`，判断与从前**逐句相同**。真符号照旧留着
   （run-llvm 那条腿发的是 `call omni_trunc`），定义它的 TU 用 `OMNI_INT_IMPL_TU` 关掉宏。
   **112 -> 71ms/帧**（`--gfx null`，30 帧取最好）。
2. **图形调用的名字按指针认**（`omni_fmt.c` 的 `gfx_name`）。生成的代码递进来的是
   `.rodata` 上的字面量，（指针, 长度）就是名字的身份 —— 先前每趟一份 `omni_cstr`
   （arena 上抄一份带 NUL 的副本），第二张表里那是 21.6%（`omni_gfx_call;_platform_memmove`）。
   128 格直接映射的槽，连"这格是不是查询"一起记着。**71 -> 66ms/帧**。
3. **一整张矩阵一句**：`(gfxarr "batchmvp16" 0 0 0 0 gl_mp)` / `batchmv16`，替掉八句
   `(gfxcall "batchmvp" 列 m0..m3)`。一帧 3994 段批 ⇒ 31952 句矩阵变成 7988；
   三档设备（`host/gfx-cpu.js`、`runtime/omni_fmt.c`、`studio/gfx-gl.js`）收到这一句
   照旧按列摆下去，语义与那八句逐字相同。单位矩阵那一档（满屏四边形）照旧走老路四句。
   **66 -> 64ms/帧**（这一刀主要是省调用次数；`gl_mvpsend` 里贵的那一半是
   `gl_mp = gl_pj · gl_mv` 那 64 个乘法，不是那八句）。

判据那两栏（`node tests/eval/perf.js --only "disco ball"`）：

* **c 腿 127.3 -> 93.9ms/帧**（参考 36.3ms，比参考 3.37x -> **2.59x**）；
* js 腿 182.9 -> 167.9ms/帧（js 那条腿吃不到第一刀 —— 那是 C 运行时里的事）。

**正确性一格没动**：`node tests/eval/correct.js` 全跑 **42 过 / 7 红 / 13 不计**，
七个红的 RMSE（84.33 / 75.31 / 67.05 / 51.85 / 28.82 / 10.13 / 8.27）与改之前**逐位相同**；
`tests/gl/run.js` 11/11、`tests/lower/run.js polydraw evaldraw` 44/44。

剩下的账（`--gfx null` 64ms/帧里的栈顶）：`gl_tri` 35.6%、`gl_mvmul` 23.9%、
`gl_vertex4` 14.4%、`gl_mvpsend` 12.3% —— 全是语言这一侧的数组搬运：
每格顶点 16 个 double 抄两趟（`gl_vb` -> `gl_ob`），每格矩阵操作一趟通用 4×4 乘法。
下一刀是把这两处的**下标基址提成局部量**、`gl_mvmul` 直接写回 `gl_mv`（不再过 `gl_ta`）：
两处都是"同一个整数值算一次还是算十六次"，答案逐位不变。

### 29.5 第三轮：下标走 int —— `disco ball` c 腿追平参考（2026-09-25）

三刀，一刀比一刀狠，都在**语言这一侧**（`ext/polydraw/{ir,gl-rt}.js`），三刀合起来
`--gfx null` 从 **57 -> 21ms/帧**：

1. **基址提成局部量**（`copyV` / `gl_push` / `gl_pop`）+ **`gl_mvmul` 落局部量再写回**
   （`gl_ta` 那格全局数组删掉了）。先前 `copyV` 十六句里每句都重算 `i * 16` 与 `cnt * 16`。
   **57 -> 47ms/帧**。
2. **`(gfxarr …)` 那条路的名字也按指针认**（`omni_gfx_arr`）：矩阵改成一句之后它是每段批
   两次，那份 `omni_cstr` 又占了 8.7%。顺手把"录制那一档"的早退提到认名字之前 ——
   那一档连名字都不用认。**47 -> 45ms/帧**。
3. **下标全程走 int**（这一刀最值）。语言的值只有 real 一种，所以 `a[i]` 每次都要
   `toint` 一趟，落到 C 上是 `omni_arr_f64_get(a, omni_trunc(base + 1.0))` ——
   一格顶点 32 次。两处改动：
   * `ir.js` 的 `ix()` 认两格不必绕的情形：**已经是 int** 的表达式、与**取整数值的 real
     字面量**（`num(3)` 这种，下标里满地都是）直接给 int 字面量（`toint(3.0)` ≡ `3`）；
   * 批那几格的基址存成 **int 局部量**（`letI` / `agetI` / `asetI`，标准 IR 里本来就有
     `{kind:'int'}` 这一格，这门语言先前没用过），于是 `base + k` 全在整数上算。
   发出来的 C 从 76K 掉到 63K，**45 -> 21ms/帧**。

判据那两栏（`node tests/eval/perf.js --only "disco ball"`）：

* **c 腿 93.9 -> 36.7ms/帧 = 27fps，比参考 2.59x -> 0.97x** —— 这一份最难的例子上
  我们**与正本的 C 实现一样快了**（参考 37.7ms）；
* js 腿 167.9 -> 154.1ms/帧（`ix` 那一刀 js 也吃到一点，但它的瓶颈在别处）。

**正确性照旧一格没动**：`correct.js` 42 过 / 7 红 / 13 不计，七个红的 RMSE 与上一轮
逐位相同；`tests/gl` 11/11、`tests/lower polydraw evaldraw` 44/44。

下一轮的线头：**js 那条腿现在是最慢的一条**（154ms/帧，4.09x 参考）；c 腿要再快 2.2 倍
才够 60fps，剩下的账要重新采一遍（上一张表里的四个名字这一轮都改过了）。

### 29.6 js 腿：顶点与矩阵整块过界 —— `snake tube` 进 60fps（2026-09-25）

§16.3 当年那句话（"一格 `napi_get_element` ≈ 50ns，一帧几千格顶点也在预算里"）
在 `disco ball` 上**不成立**：一帧 12 万顶点 × 16 格 = **400 万次跨界**。
量法是把同一份程序跑两遍：`--gfx null` 54ms/帧、`--gfx gl` 169ms/帧 ⇒
那 115ms 全在插件那道门上（同一份 GL 代码 c 腿只花 18ms）。

两刀：

1. **顶点整块过去**：`host/gfx-cpu.js` 把一段批写进一块复用的 `ArrayBuffer`
   （`DataView.setFloat64`，小端），插件那一侧一次 `napi_get_arraybuffer_info`
   拿指针、**零拷贝**（`jsBatch` 里判 `napi_is_arraybuffer`，递数组那一路留着当回落）。
   **169 -> 108ms/帧**。
   * 这**不是**"在这一层绕"：`ArrayBuffer` / `DataView` 本来就在 `check:self` 那个子集里
     （ADR-0011），要扩的是 `Float64Array`，而量过 —— 190 万格 `setFloat64` 暖起来之后
     ~2ms，与 `Float64Array` 逐格写同价，所以不必为这件事扩子集。
2. **矩阵也整块过去**：新增 `mat(哪张, ArrayBuffer)`（16 个小端 double，内部按列摆四次）
   —— 一段批从 8 次跨界变成 2 次。这一刀单独看在噪声里（这台机器上 js 腿一帧的抖动
   ±40ms），留着是因为"少 3/4 的跨界"这件事本身是结构上的。

判据：

* **`snake tube` js 腿 29.1 -> 11.5ms/帧 = 87fps，进了 60fps 那一档**（先前是红的）；
* `disco ball` js 腿 169.2 -> **83.7ms/帧**（4.37x -> 2.02x 参考），c 腿 39.1ms（0.94x）；
* `correct.js` 42 过 / 7 红 / 13 不计，七个红的 RMSE 逐位相同；`tests/gl` 11/11、
  `check:self` ok。

现在四份 HEAVY 的账（每帧 avg，参考在括号里）：`drawsph` c 2.0 / js 8.7（10.7）、
`snake tube` c 5.4 / js 11.5（13.7）、`balls2k` c 10.8 / js 7.3（4.7）、
`disco ball` c 39.1 / js 83.7（41.4）—— **只剩 `disco ball` 一份不到 60fps**。

### 29.7 `disco ball` 剩下那 37ms 拆成三段，三条路量过是死路（2026-09-25）

**先把一帧拆开**（js 腿，30 帧取最好那一帧；两个临时开关插在插件的 `omni_ev_gl_batch`
里、量完就撤了）：

* 全开 **72ms**；
* 不发 `glDrawArrays` **59ms** ⇒ **4000 句 draw call ≈ 13ms**（每句 3.2µs —— CGL 上
  一句 GL 调用就这个价）；
* 连顶点上传也不发 58ms ⇒ **`glBufferData` 那一句总共只 ~1ms**；
* 剩下的 58ms 是**语言这一侧**（同一份程序 `--gfx null` 量到 54ms）。

c 腿同一份账：语言 22ms + draw 13ms + 零碎 ≈ 37ms（判据 36.7~39.1ms 对得上）。
所以要进 60fps 得两边一起砍：语言 22 -> 8ms、draw call 13 -> 4ms。

**三条量过之后放弃的路**（都是"改完更慢或没动"，留着省下一次重试）：

1. **顶点 VBO 当环形缓冲**（一块 4MB 开着、每段批 `glBufferSubData` 往后接 +
   `glDrawArrays(mode, first, n)`）：`disco ball` 从 108 掉到 **520ms/帧**。
   往**正在用着的**那块里写会逼一次隐式同步，4000 段批就是 4000 次等 GPU；
   现在这句"每段批 `glBufferData` 弃一块"才是对的（弃块不必等）。真要省这一句只能走
   `glMapBufferRange` + `GL_MAP_UNSYNCHRONIZED_BIT`。
2. **把批那两条数组的句柄提成局部量**（省掉每格元素一次全局装载）：22.0 -> 22.1ms/帧
   （没动）。数组元素访问的价钱在**边界判**上，不在取句柄。
3. **我们自己的 -O1**（`OMNI_OPT=1`）：0.66 vs 0.67s/30 帧，中性（第二次确认）。

**留下的那一格状态缓存**（这一轮唯一保住的改动）：两张矩阵与上一段批**逐字节相同就不发**
（`u_mvp`/`u_mv` 是按 program 存着的，所以换 program 要重发）。`disco ball` 每段批矩阵都变，
这一格对它没用；矩阵不动的那些脚本每段批省两句 `glUniformMatrix4fv`。

**下一刀只剩"把批并起来"**，而挡在前面的是"顶点是物体坐标、变换随批走"这条约定。
做法（还没做）：语言这一侧把顶点**烘到眼空间**（`MV · v`）、法向烘成
`NormalMatrix · n`，然后 `u_mv` 发单位矩阵、`u_mvp` 只发投影 ——
`ftransform()` / `gl_ModelViewMatrix * gl_Vertex` / `gl_NormalMatrix * gl_Normal`
这三种写法的结果**一个字不变**，于是矩阵变了也不必断批，一帧 3994 段变成 ~40 段
（顶点上限 3072 那一格才断），draw call 13ms -> 0.1ms。
两个前提：
* **要在编译期判"这份着色器能不能烘"**：`gl_Vertex` 只许出现在上面那三种乘法里
  （`ken/cubetex.pss` 那种 `v = gl_Vertex` 直接当物体坐标用的**不能烘**）——
  我们本来就在 `glslAlign` 里改写这几个名字，判据就在那儿；
* **精度**：烘是 double 算完再转 float，GPU 那条是 float 里算 —— 差在 1e-7 量级，
  现在逐像素相同的那十几份会掉到"差几格 ±1"（仍然过 RMSE ≤ 8，但会丢"逐像素相同"那个记号）。
  所以这一刀要连"判据里那个记号怎么记"一起想清楚再动。

### 29.8 js 腿：整数加减在调用点展开 —— 语言那一半 57 -> 36ms/帧（2026-09-25）

这一格不在 EVAL 那一层，在**公共的 js 后端**（`src/core/backend-js/emit.js`）。
下标走 int 之后（§29.5），`base + k` 在 js 腿上落成一句 `$iadd(base, k)` —— 一格顶点 32 次、
一帧 12 万个顶点 ⇒ **每帧 380 万次函数调用**。`$iadd` 本身只有"两个 typeof + 一次浮点加 +
一次范围查"，贵的是那趟调用。

改法与 prelude 里 `$aget`/`$aset` 那一格**同一条**（那段话就写着"跨编译单元的真符号
内联不了，所以在这儿手展开"）：`+`/`-` 在调用点展开成
"两个 typeof + 一次加 + 范围查 ? 那格临时 : 真函数"，判断与 prelude 那一份逐句相同
（2^53 以外照旧交给真函数）。那格临时（`$T`）在 prelude 里，赋完立刻读，嵌套也安全
（里层先赋完、外层再赋）。**只对"两边都是名字或整数字面量"的式子展开** ——
慢路那一趟要把实参写第二遍，复杂式子重算一遍可能有副作用。

量出来（`disco ball`，`--gfx null` + `--perf`，30 帧）：
**语言那一半 55~61 -> 35~38ms/帧**（avg 64~91 -> 39~44），`--gfx gl` 那一栏
83.7 -> **56~57ms/帧**（min）。

判据（这一刀动的是**所有语言的 js 腿**，所以要宽着跑）：
`tests/lower/run.js` 全跑 **320/320**、`tests/go/run.js` **46/46 与 `go run` 逐字节相同**
（int64 回绕那一族最吃这一刀）、`correct.js` **43 过 / 6 红 / 13 不计**（六个红的 RMSE 不动）、
`npm run check:self` ok。

**踩过一次的坑**：`prelude.js` 是一份 `String.raw` 反引号模板 —— 注释里写反引号会把
整份文件切开（当场 `SyntaxError`）。那条本来就记在 `feedback_comment_delimiters` 里，
这一轮又撞了一次。

**这一刀之后 js 腿的栈顶**（`--gfx null`，60 帧，自用）：`$aset` **24.4%** +
`$aget` **18.6%** = **43% 在这两格上**，其次 `s_gl_tri` 23.7%（它自己那一摊）、
`s_gl_vertex4` 6.8%、`s_gl_mvmul` 2.1%、`$trunc` 1.6%。
`$aget`/`$aset` 在 emit 那一层**仍是真调用**（`emit.js` 的 `ArrGet`/`ArrSet` 两格；
prelude 里"手展开"那句说的是函数**体内**少跳一层，不是调用点）。

**下一刀（js 腿）**：把 `ArrGet`/`ArrSet` 也在调用点展开。比加减那一格麻烦一处：
下标已经是展开过的式子（不是简单名字），慢路要用到它两次 ⇒ 得先甩进一格临时；
而**临时不能只有一格**——外层的下标临时会被"值"那一侧嵌套的同名临时盖掉。
办法是按**表达式嵌套深度**发 `$I0/$I1/…`（emit 那一层知道深度），或者只在
"下标与数组都简单"时展开、其余照旧走函数。








## 30. 第三根尺子：**原版 polydraw**（MSVC x86 + x87 JIT）

先前实时那一栏的"参考"来自 `c_impl` 的 `framebench`。**那个参考本身是被改慢过的实现** ——
`c_impl` 没有原版的 x87 JIT，而工作树里的 `polydraw_src/eval.c` 也**不是原版**
（8254 行、`__asm` 计数 0；原版 6122 行、3 处 `__asm`，`kasm87` 把脚本编成 x87 机器码）。
为了在 clang 下编过，那一份把 JIT 换成了约 2100 行 C 解释器。所以这一节建的是真原版。

### 30.1 怎么建的（可复现）

* **源码**：`cd ~/Documents/polydraw && git show 559ed7a:polydraw_src.zip`（`add origin source code`
  那个提交里的 zip 才是原始版本，不要用工作树里的 `polydraw_src/`）；
* **编译**：`ssh wurui@computer.local`（Windows 11 + VS 18 Community），
  `vcvars32.bat` → `cl /O2 polydraw.c eval.c kplib.c /link /FORCE:MULTIPLE opengl32 glu32 …`。
  **必须 x86**：`kplib.c` 有 9 处 32 位内联汇编。`/FORCE:MULTIPLE` 是因为 `mysrand` 在
  `polydraw.c:1736` 与 `eval.c:7785` 各定义一次（原版就这样，语义相同）——**不改源码**；
* **`/bench:N` 那五处补丁**（注释用英文与原文一致）：全局三个量 / 命令行认 `/bench:` /
  `if (!ActiveApp) Sleep(100)` 那道门在基准档不挡（ssh 会话拿不到焦点）/ 交帧后计帧
  （第 1 帧 `wglSwapIntervalEXT(0)` 关垂直同步、**前 30 帧预热**、满 N 帧写
  `polydraw_bench.txt` 再退）/ **跳过那句礼让 `Sleep(1)`**（见下）。

### 30.2 两个口径陷阱（都咬过一次）

1. **`Sleep(1)` 是 15.6ms**。原版主循环里"脚本没有 `@f` 片元段就 `Sleep(1)`"
   （`if ((!shadn[2]) || (!gevalfunc))`）在默认定时器粒度下实际睡 15.6ms，把**所有无着色器
   的脚本钉死在 ~63.4fps**。第一趟量出来十几份整整齐齐 15.75~15.79ms，全是这个，不是渲染成本。
   跳过那一句之后：`examples/opengl/28_peaks` 15.795 -> **0.107ms/帧**。
2. **带空格的文件名被 `Start-Process -ArgumentList` 拆成两个实参**，静默跳过 —— 17 份
   （`snake tube` / `disco ball` / `town textured` 全在里头，正好是我们最在意的那几份）。
   要包一层引号。

### 30.3 同口径（都 320×240）那四份 HEAVY

* `tigrou/balls2k`：原版 **0.636ms** / 我们 c 腿 10.8ms（**17.0x**）/ js 腿 7.3ms
* `ken/drawsph`：原版 **0.823ms** / c 2.0ms（2.4x）/ js 8.7ms
* `tigrou/snake tube`：原版 **1.331ms** / c 5.4ms（4.1x）/ js 11.5ms
* `tigrou/disco ball`：原版 **5.656ms** / c 36.7ms（6.5x）/ js 56ms

**分辨率对原版几乎没影响**（`balls2k` 0.627→0.636、`disco ball` 6.52→5.66、`tree` 与
`curvybuild` 纹丝不动）⇒ **原版的瓶颈也在语言/CPU 那一侧，不在填充率**。所以我们那几倍
差距同样不能靠少画像素解决，只能从语言侧与批数上砍。

### 30.4 整份语料的形状（103 份，表在 `tests/eval/pdref-fps.tsv`）

最快一档 **0.089ms/帧**（`examples/opengl/04_rect`、`06_five_circles`）；
原版自己**低于 60fps 的只有两份**：`tigrou/tree` 10.288ms、`ken/curvybuild` 32.353ms ——
这两份不该进"实时"那一栏的判据，应当单列（`curvybuild` 正是我们裁过"参考错"的那一份，
原版自己也只有 30fps，说明它本身就重）。

同一场景走不走脚本着色器差 **37 倍**：`disco ball shader` 0.177ms、
`disco blur shader +blur` 0.432ms，而固定管线那份 `disco ball` 6.517ms（640×480）——
**原版也是靠"把活儿丢给 GPU"取胜的**，与 §29.7 那一刀（把批并起来、少发 draw call）同一个方向。

### 30.5 因此要改的两件事

1. `tests/eval/perf.js` 那一栏的参考数（10.7 / 4.7 / 13.7 / 38.8ms）**系统性偏慢 2~16 倍**，
   换成 30.3 这一份。换完那三行会从"比参考快"变成"比参考慢 2.4~17 倍" —— 账更难看，但是真的；
2. 下一刀的靶子从 `disco ball` 换成 **`balls2k`（17x）**：它走脚本自己的 `drawsph` + 着色器、
   每球一个四边形，是"语言那一半"最纯的对照（`disco ball` 还混着 4000 段批的 draw call）。

## 31. `balls2k` 那一轮：两刀，一刀赚一刀白做（2026-09-25）

靶子是 §30.5 定下的 `balls2k`（175 个球、每帧 O(n²) 碰撞 + 每球一个三角扇）。
量法：`OMNI_GFX=null OMNI_FRAMES=200 <二进制>` —— 设备那一档零成本，量的就是语言那一半。

### 31.1 赚的那一刀：`x^2` / `x^3` 折成乘法

`^` 从前一律落成 `(rmath pow)`。剖出来 `pow` 占 **17%** 的栈顶样本 —— 这门语言里
`cz^2`、`ballr[i]^2`、`planes[k][0]^2` 这种整数次幂满地都是（`balls2k` 一个 `drawsph`
里就有四处）。只折**底是名字或字面量、指数是字面 2 或 3** 那两格：底要被重发两三遍，
带副作用的算式不许折。`0.5` 刻意没折 —— `sqrt(x)` 与 `pow(x,.5)` 不保证逐位相同，
而出图那一轴的判据是**逐像素**。

200 帧 1.10s -> 0.78s（min-of-3 交错），也就是 **5.5 -> 3.9ms/帧**。

### 31.2 白做的那一刀（但留着）：装箱按函数算，不按名字算

`&x` 那一族（`C.boxed`）从前是**整份程序一张名单**：一个名字在任何一个函数里被 `&` 过，
**所有**函数里的同名局部量都跟着落成一格长度 1 的数组。`balls2k` 正踩这一格 ——
`rotate(&x,&y,r)` 把 `x`/`y` 钉成了箱子，而 `drawsph` 里的 `x`/`y` 只是椭圆中心那两格
局部量：每次调用白开两格数组，一帧 175 个球 ⇒ 350 次 `omni_arr_f64_new`。
剖出来那一格占 **7.76%** 的栈顶样本（同一份程序早一版上是 24.1%）。

改法在 `ext/polydraw/adapter.js` 的 `boxedFor`：整份程序那张单只用来决定**模块级**的量
要不要改成 `(arr real)`（那必须整份一致），函数体那一张**各算各的**（`collectBoxed`
只走这一棵子树）。装箱本来就该是"那一格变量的属性"，不是"名字的属性" ——
这门语言没有闭包，局部量不出函数。

**机制成了，墙上时间没动**：`omni_arr_f64_new` 7.76% -> 0.21%（探针证据），
而 200 帧 0.79s -> 0.79s、1000 帧的**用户态 CPU** 3.80s -> 3.77s（各 min-of-5 交错）。
原因是分配走的是 arena 撞指针，350 次/帧本来就不值钱 —— 那 7.76% 是采样器
把调用序列的样本记到了叶子上。**这是"先探针再归因"那条规矩的又一例**：
栈顶百分比不等于省下来的时间，7.76% 的叶子换不来 7.76% 的墙上时间。

改动留着：少一层数组间接、少 350 次分配，判据上逐像素中性（correct.js 五个红的 RMSE
与账上逐位相同），代价是零。但**不许当性能战果记账**。

### 31.3 **尺子搞错了一整轮**：ms/帧 不许用我们自带的后端量（2026-09-25，用户纠正）

`omni build x.pss` 默认印的是 `via self -O0` —— 自带的 C 后端，而公共 MIR 优化管线
（ADR-0039）缺省也不跑。**这条腿不是性能基线**（它在测试轴上的角色是"另一份语义实现"），
拿它量出来的 ms/帧 去和原版 polydraw（MSVC + x87 JIT）对照，等于把我们后端的欠账
算成别人的功劳。同一份 `tigrou/balls2k.pss`、同一条命令
（`OMNI_GFX=null OMNI_FRAMES=200`，min-of-5 用户态 CPU）：

* `self -O0`（默认）：**3.75 ms/帧**
* `self` + `OMNI_MIR_OPT=2`：**3.50 ms/帧**（指令数 -27.3%，墙上只 -7%）
* **`OMNI_CC=clang OMNI_OPT=2`：0.25 ms/帧** —— 比默认档快 **15 倍**

于是 §30.5 立的那个"`balls2k` 差 17 倍"**作废**：那 17 倍里绝大部分是自带后端的 -O0。
换成真编译器、再把判据那侧的暖态账修对（§31.5）之后，整条腿（含 GL 设备）是
**avg 0.3~0.4ms/帧、max 0.6~1.1ms、启动 0.9s**（`OMNI_CC=clang OMNI_OPT=2
node tests/eval/perf.js --only balls2k`）—— 对 §30.3 那个同口径参考 0.636ms 是 **0.09x**，
也就是**比原版快一个数量级**，早就在 60fps 线里头。

连带的三条：

1. **§31.1 那一刀（`x^2` 折乘法）的收益要重量**：17% 的 `pow` 样本是在 -O0 的二进制上剖的，
   clang -O2 会自己把 `pow(x,2.0)` 变成乘法（它认 `__builtin_pow` 的这一格），
   所以那一刀在真编译器上大概率是 0 —— 但它对**默认档与 js 腿**仍然有效，留着；
2. **剖样本也要在 clang -O2 的二进制上剖**：两档的热点排序不是一回事；
3. 自带后端的优化是**另一笔账**（那条 MIR 管线、-O0 的代码质量）。要做，
   但它的判据是"自带后端与 clang 的差距"，不是某个 `.pss` 的帧时间。

顺手补上的一格：运行时那 21 个 `.o` 的暖存键里从前没有 `OMNI_MIR_OPT`
（`cli.js` 的 `runtimeObjectsSelf`）—— 谁在冷缓存上用 `OMNI_MIR_OPT=2` 编过一趟，
后面所有默认档的构建都会安静地端到那份优化过的运行库。已补进键里。

### 31.4 实时性判据的现状（`--only balls2k`，clang -O2）

| 档 | 启动 | 每帧 avg / max | 对参考 | 账 |
| --- | --- | --- | --- | --- |
| c（clang -O2） | 0.9s（不判） | **0.3 / 0.6ms** | 0.09x | 在线内，快原版一个数量级 |
| js | 0.52~0.58s | **7.7 / 9.0ms** | ≈1.4x | 在 60fps 线内；`ArrSet` 调用点展开（§29.8）还没做 |
| interp | 0.8~0.9s | **200 / 235ms** | ≈40x | 解释器，本来就不是实时那一档 |
| jit | — | — | — | **跑不起来** —— 这是缺口不是慢 |
| self -O0 | — | 3.75ms（语言那一半） | — | 自带后端那笔账，独立追 |

### 31.5 判据自己的两笔账：**一份 ≤ 10s**，以及"暖态"不许被头一帧污染（2026-09-25，用户纠正）

`node tests/eval/perf.js --only balls2k` 从前要 **59s**，而且给出的每帧数是错的。两个病因：

1. **帧数按份数给**（一律 120 帧）：一条 200ms/帧 的解释器光帧时间就 24s，
   而那 120 个数里没有一个是新信息 —— 前 10 个就够了。
   现在按**时间**给：探针 4 帧 → 按它的 `min` 把帧数补到够 250ms（上限 60 帧）。
   一份例子一份墙上预算（`--case-ms`，缺省 9000），**按档发、快的档把没花完的还回去**
   （平分会饿死要先编一趟的 `c` 档；先到先得会让解释器把后面全挤掉 —— 两头都踩过）。
   量出来：59s → **8.5s**，而且四档全都量到了（从前 jit/interp 那两档只印"跑不起来"）。
2. **头一帧污染了 avg**：第一帧要编着色器、建 FBO、暖纹理。同一条 js 腿在同一台机器上
   4 帧量出 **42ms**、8 帧 11.4ms、27 帧 6.5ms —— 帧数越少数字越坏，于是"少跑几帧"
   与"量得准"看着是矛盾的。**其实不是**：那一帧本来就不属于"每帧"，它属于"启动"。
   所以运行时那行 `#perf gfx` 改成 avg/min/max **只统暖态**（跳过头 `OMNI_GFX_PERF_SKIP`
   帧，缺省 1），`total` 照旧是全部，另外多报 `warm=<帧数> warmtotal=<ms>`；
   判据那侧的启动就是 `real − warmtotal` —— 头一帧的编译落在启动那一栏。
   两侧都要改（`src/runtime/omni_fmt.c` 与 `src/core/host/gfx-cpu.js` 那两份是逐句对着写的）。
   改完 4 帧的探针量出 7.7ms，与 60 帧的 4.6~7.7ms 同一个量级 —— 探针可信了。

顺带一条判据口径：**时间片不够要印 `--`、不算红**。"它慢"与"它坏"分不开的时候，
一条 200ms/帧 的路会被报成"跑不起来"（踩过一次）。

## 32. **主要基准是 LLVM JIT**（要与原版的 x87 JIT 平齐；clang 是上限）

用户 2026-09-25 定的口径。理由与 §15 那一节的第 3 条是同一件事：这门语言是**改一个字
就要看见画面**的，出成品那条 cc 路的整趟时间不重要 —— 所以真正要做好的是 jit 那一档。
对照的两端：**下界**是原版 polydraw 的 x87 JIT（`balls2k` 同口径 0.636ms/帧，§30.3），
**上界**是同一份程序走 clang -O2（0.3~0.4ms/帧，§31.3）。

### 32.1 它从前**一个 GL 脚本都跑不起来**（四格，全是缺口不是慢）

`node tests/eval/perf.js --only balls2k` 里那句 `FAIL [jit] 跑不起来` 背后是四个独立的洞，
一个接一个挡着（每修一个才看得见下一个）：

1. `llvm: gfx_call.string 要 14 个实参，实得 1` —— `(gfxcall 名字 实参…)` 是**"个数 + 补零"**
   那一档（不是变参）：运行时的真符号是平的（名字 + 个数 + 十二格 double）。
   backend-c 在 HIR 那一层补零（`case 'gfx_call'`），而这条腿从 MIR 出发，得自己补。
2. `llvm: gfx_frame_fn.int 要 1 个实参，实得 0` —— `(gfxframefn …)` 把函数名放在 `func` 上、
   `args` 是空的。这条腿上**记下不用**（与 interp 同口径：原生这侧自己有帧循环），
   递一格空指针过去。
3. `the jit host failed to build with clang: initializer element is not a compile-time constant`
   —— `omni_jit_symbols.c` 里 `{ "omni_arena_ptr", &omni_arena_ptr }`：那是**线程局部**量的
   地址，不是编译期常量。挪进 `omni_jit_symbol()` 里现取（那一趟就跑在建表这条线程上，
   比"建表时取一次"更准）。注意这一格卡住的不是某个脚本，是**整条腿**。
4. `omni-jit: unresolved: omni_r_cos`（一份脚本就缺 6 个）—— 宿主符号表里只有"代数"那几格，
   超越函数一族与 `omni_gfx_arr` 都不在。照 omni.h 抄全（别只补眼下报缺的那几个）。

修完：`balls2k` jit 跑起来了，**出的 PNG 与 c 腿逐字节相同**。

### 32.2 第一刀：LLJIT **不跑任何中端通道**（5.5 -> 3.9ms/帧）

`LLVMOrcCreateLLJIT` 只做 codegen —— 它一个 IR 通道都不跑，于是这条腿等于
"clang -O0 的中端 + 后端的寄存器分配"。既然它是主要基准，就在 `omni_jit.c` 里把
`LLVMRunPasses(mod, "default<O2>", tm, opts)` 摆在 `AddLLVMIRModule` 之前（与 clang -O2
**同一条管线**），`OMNI_JIT_OPT=0..3` 选档、缺省 2。

坑一格：**档位要进对象码缓存的名字**（`omni_objcache` 后面接 `.O<档>`）。那份缓存的键是
IR 的内容、不含档位 —— 不带上它的话 `OMNI_JIT_OPT=0` 会安静地端上一份 O2 编好的对象码
（与 cli.js 里 `runtimeObjectsSelf` 那一格同一类"会跑错程序的缓存"）。

判据那一行（`--only balls2k`，clang -O2 那一趟）：

```
  启动(ms)  每帧avg(ms)  每帧max(ms)   fps  参考(ms)   比参考   模式
      1818          4.0          4.3   250       5.2    0.78x   jit
       432          6.0          8.0   167       5.2    1.16x   js
       652        176.0        189.0     6       5.2   34.11x   interp
       909          0.4          0.5  2500       5.2    0.08x   c
```

两件事看得见：
* 每帧 4.0ms 已经在 60fps 线里头，对 framebench 那一栏是 0.78x；但对 §30.3 那个
  **真 x87 JIT 的 0.636ms 还差 6.3 倍** —— 那才是要平齐的线；
* **启动 1818ms 红了**（线是 1000ms）：中端管线 + JIT 编译的钱花在这儿。对象码缓存
  （`--objcache`）救得了复跑，救不了"改完一个字"那一趟 —— 这一格是下一轮要单独算的账
  （候选：只给热函数上 O2、或者 O1 起步再按需升档）。

### 32.3 第二刀：**那三族在 IR 里就地展开** —— 4.0 -> 0.7ms/帧（追平上限、越过参考）

同一份 `balls2k` 的 jit IR（8614 行）里原来有：

* `omni_arr_f64_get` **484** 处、`omni_arr_f64_set` **330** 处
* `omni_trunc` **552** 处（下标取整）

这三族在 **C 那条腿上是宏**（`omni.h` 的 `OMNI__AGET` / `OMNI__ASET` / `omni_trunc`），
clang 直接内联成"一次无符号比较 + 一条 load"；而这条腿发的是 `call @omni_arr_f64_get`，
**函数体不在模块里 ⇒ `default<O2>` 也内联不了**，LICM/GVN 更看不穿它。
1366 次不可内联的调用就是那一个数量级。

改法：在发射的模块里补 `define private … alwaysinline` 的函数体，
**逐句照 omni.h 那三个宏**（`arrFastHelpers` / `TRUNC_HELPER`）——
空判走 `omni_err_null`、越界是一次 `icmp uge`（负数转 u64 是个大数，一次比较判两边）、
`set` 回写进去的那个值；`int()` 的慢路径调的是**同一个** `omni_trunc_oob`。
为什么发成 `alwaysinline` 的函数而不是在调用点直接展开：越界检查带分支，而调用点在
结构化控制流里 —— 展开会把 `this.live`/`regions` 那套记账搅乱（与 `bufHelpers` 同一个理由）。
交给内联器是白拿的：O0 时它们仍是三条 call（语义不变），O2 时全展开。

只给 **int / real** 两族做（`arrFast`）：它们的格子就是 8 字节标量，一条 load/store 完事，
而热路径全在这儿。`bool` 在 C 里是 1 字节而 IR 里是 `i1`（位宽与存储宽不是一件事）、
`string` 是 `[2 x i64]` 的聚合 —— 这两族留在运行时符号上，省掉一个本来不必回答的问题。

两格连带的坑（各自表现为"整条腿不跑"）：`omni_err_null` / `omni_err_range` /
`omni_trunc_oob` 三个符号从前**不在 JIT 宿主表里**（错误路径以前在 omni_arr.c 里，
IR 不引用它们），要补；`declare` 那三条照旧留着（没人调的 declare 是空的）。

账（`balls2k`，`OMNI_FRAMES=8`，暖态）：

| 这一刀 | 每帧 avg | 对 x87 参考 0.636ms |
| --- | --- | --- |
| 修好之前 | **跑不起来** | — |
| 接上 O2 管线（§32.2） | 5.5 -> 4.0ms | 6.3x |
| 数组三条就地展开 | 4.0 -> **3.3ms** | 5.2x |
| `int()` 也展开 | 3.3 -> **0.7ms**（min 0.4） | **0.9x ~ 1.1x** |

也就是说：**jit 这条腿现在与 clang -O2 那个上限（0.3~0.4ms/帧）同一档，并且已经追平原版的
x87 JIT**。出的 PNG 与 c 腿**逐字节相同**（每一刀之后都验）。

`omni_trunc` 那 552 处是这一轮里最大的一格（3.3 -> 0.7，×4.7）—— 与 §29.4 在 C 腿上
量到的"`omni_trunc` 占 52% 栈顶样本"是同一件事的另一侧。

### 32.4 四份 HEAVY 的现状（`OMNI_CC=clang OMNI_OPT=2 node tests/eval/perf.js`）

```
  启动(ms)  每帧avg(ms)  每帧max(ms)   fps  参考(ms)   比参考   模式    例子
       828          0.7          0.8  1429      14.5    0.05x   jit     drawsph.pss
       631          9.7         16.0   103      14.5    0.67x   js      drawsph.pss
       919          0.3          0.4  3333      14.5    0.02x   c       drawsph.pss
       878          0.6          0.7  1667       6.0    0.10x   jit     balls2k.pss
       615         21.7         44.0    46       6.0    3.63x   js      balls2k.pss
      1528          0.6          0.7  1667       6.0    0.10x   c       balls2k.pss
       835          1.8          2.2   556      16.7    0.11x   jit     snake tube.pss
       621         13.0         15.0    77      16.7    0.78x   js      snake tube.pss
       968          0.8          1.0  1250      16.7    0.05x   c       snake tube.pss
       691         16.3         19.2    61         —        —   jit     disco ball.pss
       525         61.7         65.0    16         —        —   js      disco ball.pss
      1108         20.7         21.0    48         —        —   c       disco ball.pss
```

* **jit 四份全过两条线**（每帧 ≤ 16.7ms、启动 ≤ 1000ms）。`disco ball` 上它 16.3ms
  比 AOT 的 c 腿 20.7ms 还快 —— 一个模块一起过 O2，没有跨编译单元那道墙；
* 启动那一格从 §32.2 那趟的 1818ms 落回 **691~878ms**：那 1818 是冷对象码缓存那一趟；
* 剩下的红全不在 jit 上：`js` 在 `balls2k`/`disco ball` 上 21.7/61.7ms（`ArrSet`
  调用点展开那一刀还没做，§29.8），`interp` 一族本来就不是实时那一档。

### 32.5 下一格：启动延迟

### 32.6 再下一步：**自己那台 JIT**（ADR-0045）

性能这一格 LLVM 那一档已经够了（与 clang -O2 同档）。剩下两件事它给不了：
**它是 100MB 级的外部依赖**（没装 LLVM 的机器上主要基准直接不存在），
**中端管线那趟要花掉启动预算**（冷缓存 1.8s，而原版那台 x87 JIT 编同一份脚本是几毫秒级、
整个 `polydraw.exe` 只有 300KB）。

所以下一步照 `kasm87` 的**做法**自己做一台：线性 IR + 两遍发射 + 补丁表 + 零依赖。
形状、缺口清单、三把尺子与分档都在 **`docs/design/adr-0045-own-jit.md`**；
读原版源码要用 `~/Documents/polydraw-bench` 那棵工作树（`origin-bench` 分支 ——
`master` 上那份被后来的提交去掉了 x87 汇编，不是正本）。



