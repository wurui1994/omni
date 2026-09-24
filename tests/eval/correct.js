// tests/eval/correct.js —— **出图正确性判据**：与 c_impl 逐像素对照
//
// 口径（2026-09-24 用户定的）：**先正确，再谈速度。** 黑图显然不正确、像素差异大也不正确；
// c_impl 自己只有 ~80% 正确 —— 达不到它那种正确，比速度没有意义。细节以原始实现
// `polydraw_src/` 为准（那是唯一的正本，`c_impl` 与 `js_impl` 都有已知偏差）。
//
// ## 一格**必须传对**的东西：fovy
//
// 参考那侧 `polydraw-render` 的 fovy **默认固定 73.74°**（`src/render_main.c:48` 的注：
// "setfov(90) effective, matches the reference" —— 那是 640×480 那台窗口上的值）。
// 而我们照 `polydraw_src` 的 `ksetfov`（`polydraw.c:1484`）用**真实画布的宽高比**算：
// `tan(fovy/2) = 高/宽`。于是在 320×320 上我们是 90°、它还是 73.74° —— 画出来的三角
// 差 1.333 倍，看着像"我们画错了"，其实是**对照口径错**。
//
// 所以这份判据按分辨率把 fovy 算出来递给参考：`fovy = 2·atan(h/w)`（度）。
// 量出来的效果：`01_minimal_noshader.pss` 在 320×320 上 **RMSE 0.00、逐像素相同**。
//
// ## 怎么读两边的像素
//
// 我们出 `.rgba`（裸表面，没有编码那一层）；参考出 PNG，用它自带的 `pd-imgdecode`
// 转成 PPM（P6）再读 —— 都不经过第三方解码器，省掉"解码器差一位"那类假差。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/cli.js');
const OUT = join(ROOT, '.omni-cache', 'evalcorrect');
const PSS = process.env.OMNI_PSS_DIR ?? '/Users/wurui/Documents/polydraw';
/**
 * 参考那两个程序在哪儿。三档：**`OMNI_PD_REF`** > `.omni-cache/pdref`（`mkref.js` 补过的
 * 那一份）> 用户那棵 `c_impl/build`（原样）。
 *
 * 为什么要补一份：`c_impl` 有一处错的是**一整类** —— `mat4_rotate`
 * （`src/render/gl_renderer.c`）那张 `t[16]` 的字面量按**行**写、数组按**列**用，
 * 于是它的 `glrotate` 是真 GL 那张 `R` 的转置（= 按 `-角度` 转）。正本是真 OpenGL
 * （原版 `glrotate` 就是 `glRotated`，`polydraw.c:2141`），本机拿 CGL 问过固定管线。
 * 逐个 `REF_WRONG` 装不下一整类，放宽阈值等于自己判自己 —— 所以
 * **`node tests/eval/mkref.js` 补一份 fork 当尺子**（理由抄在那儿）。
 */
const PATCHED = join(ROOT, '.omni-cache', 'pdref', 'c_impl', 'build');
const REFDIR = process.env.OMNI_PD_REF
  ?? (existsSync(join(PATCHED, 'polydraw-render')) ? PATCHED : `${PSS}/c_impl/build`);
const REF = `${REFDIR}/polydraw-render`;
const DEC = `${REFDIR}/pd-imgdecode`;

const argv = process.argv.slice(2);
const val = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const CFG = {
  w: Number(val('--w', '320')),
  h: Number(val('--h', '320')),
  frame: val('--frame', '0'),
  /* RMSE 的线：**0 是"逐像素相同"**，这个数是"还算同一张图"的上界（两个渲染器）。 */
  rmse: Number(val('--rmse', '8')),
  /**
   * 第二条放行线：**有差的格子占比**。RMSE 是全图平均，一小撮亮格子差满 255 就能把它
   * 顶过线 —— 而"一小撮"恰好是两个渲染器必然分家的那一类：近乎侧看的薄片（几个像素
   * 的边缘覆盖）。`05_explicit_main_and_funcs.pss` 是标本：468 格（0.46%）有差、
   * 全是那 145 个树梢小方块的顶面，其余 99.54% 逐位相同 —— 根因是**MVP 乘在哪儿**
   * （我们按一份模型在语言侧用 double 乘进顶点；参考关掉 bake 之后是 GPU 上 float
   * 乘 uniform），不是画错。所以给一条"占比"的放行线，并且把占比印出来。
   */
  pxdiff: Number(val('--pxdiff', '0.005')),
  only: val('--only', ''),
  budget: Number(val('--budget', '100')) * 1000,
};

/**
 * **已裁定"不计分"的那几份**（依据只有 `polydraw_src` 的语义 + 最小复现）。
 * c_impl 自己只有 ~80% 正确，所以这种分歧必须裁定一次再记进来 —— 不记的话判据会
 * 永远红在别人的 bug 上；乱记又会把我们自己的 bug 藏起来。**每一条都要写清怎么定的。**
 * 里头还有一类不是"参考错"而是**脚本自己是未定义行为**（`gears.pss`）：那种谁也对不上谁。
 */
const REF_WRONG = new Map([
  ['balls.pss',
    '**参考的 `nrnd` 有一处无符号回绕**：`c_impl/src/eval/pd_interp.c:46` 写的是'
    + ' `(double)(pd_krand() - 1073741824u)`，而 `pd_krand()` 回的是 `unsigned long`'
    + '（这台机器 64 位）⇒ 取到的数**小于 2^30 时整个回绕成约 1.8e19**，`r = x²+y²`'
    + '当场 ≥ 1、那一对被拒。于是它的 Box-Muller 只收得下"两个数都 ≥ 2^30"的采样'
    + '（等于只取第一象限）。正本 `eval.c:515` 那儿是 **signed long**，x/y 落在 -1..1。'
    + '这一份每个球取两次 `nrnd`（16384 个球）⇒ 位置/颜色全不一样（RMSE 26.07、'
    + '非黑数只差 40 格：覆盖一样、颜色全错）。我们这一侧照 `eval.c:504-523` 写'
    + '（**包括它把第二个正态数存下来、下一次调用不再取 krand** —— 这一格 2026-09-25 补上了）'],
  ['particules sparks.pss',
    '同 `balls`：每个火花的初速与位置都是 `nrnd`（`x=nrnd*.5; vx=nrnd*1.5; …`），'
    + '而参考那一格有无符号回绕（见那一条）。**这一条会盖住这一份别的差**'
    + '（它还读 `glalphaenable` 那一族、第 30 帧才有东西），修完之后要重裁'],
  ['heightmap.pss',
    '**参考的 `noise()` 是它自己写着的"占位实现"**：`c_impl/src/eval_impl/ed_misc.c:96`'
    + '（"Simple hash-based noise. Not as good as Ken\'s, but functional."）与 `:101`'
    + '（"Use sin-based pseudo-noise for now."）。我们这一侧是照 `polydraw.c:852-960`'
    + '（Tom Dobrowolski 那套梯度噪声）逐条写的，连置换表都按原版 `noiseinit()` 用的'
    + ' MSVC `rand()` 重算（`ext/polydraw/noise-rt.js` 的头注写了两处明写的偏差）。'
    + '一格三元探针量出来：`noise(1.5,2.5)` / `noise(.25,7.75,3.5)` / `noise(13.125)`'
    + ' 我们 (255,100,128)、参考 (209,255,133) —— 三个元数全不一样，对不上也不该对。'
    + '这一份的高度场整个由 `noise` 定，所以不计分'],
  ['texture.pss',
    '同 `heightmap`：三张纹理里的第 1 张是 `noise` 在 CPU 上生的，而参考的 `noise` 是占位'
    + '实现（见那一条）。片元里 `mod(c.x+p.x+p.y,3)` 把三张混起来 ⇒ 大半张图都带着它。'
    + '**这一条会盖住这一份别的差**（抓屏那一张、混合次序），修完噪声那一族之后要重裁'],
  ['clock.pss',
    '**这一份的画面跟着墙上的钟走，两边对不上也没法对**：脚本头一句是 `klock(1)`，'
    + '照 `polydraw.c:1662` 的 `myklock` 那是**打包的本地日期时间**（`YYYYMMDDHHMMSS.sss×.001`），'
    + '脚本再从它切出时/分/秒去画指针。参考那一侧**压根不看实参**'
    + '（`c_impl/src/pd_polyhost.c:88`：`if (n >= 1 && a[0] != 0.0) return now;`）—— '
    + '它回的还是那格确定性时钟，于是永远是 00:00:00。我们照正本给真日期 ⇒ '
    + '同一份脚本我们两趟都不一样（量过：隔 2 秒两张 `.rgba` 不同，参考两趟逐字节相同）。'
    + '要对上只能照抄参考那一格的错。**顺带记着**：我们 render 模式下这一族也因此不可复现，'
    + '哪天要给 .pss 做金标就得给日期那几格也定一个纪元'],
  ['gears.pss',
    '**这一份自己是未定义行为**：后处理那段片元着色器里 `vec4 cc;` 没给初值就 `cc += …`'
    + '（`tigrou/gears.pss` 的 `@f2` 段）—— 于是两边都是一片随机麻点，谁也对不上谁。'
    + '抓屏那一族接上之后（§22）齿轮本身的位置、形状、那层蓝色两边是一样的，'
    + '差都在麻点上（RMSE 48、我们非黑 58780 vs 参考 43038）。要对上只能让那格'
    + '未初始化的量在两边取到同一份垃圾 —— 那不是我们做得到的事'],
  ['mipmap.pss',
    '**两边跑的压根不是同一段片元代码**：脚本那段是'
    + '`#ifdef GL_ARB_shader_texture_lod` -> `texture2DLod(tex0,t.xy,dep)`、`#else` -> 普通'
    + '`texture2D` —— 整份脚本的正事就是"拿鼠标 Y 挑 mip 层"。一份两行探针（同一个 `#ifdef`，'
    + '有那个扩展画红、没有画绿）量出来：**参考是绿的、我们是红的**。参考那侧把着色器编成'
    + '`#version 330 core`，core profile 里那些扩展宏**不定义**（扩展早并进核心了）⇒ '
    + '它掉进了那条给老硬件的 `#else` 兜底；原版跑在真 GL 的兼容管线上，驱动是定义那个宏的'
    + '（`texture2DLod` 在片元里本来就只有那个扩展才有）。我们照原版走 LOD 那条'
    + '（`ext/polydraw/glsl.js` 的 `GLSL_HAVE`，为什么不能靠编译器自己判也写在那儿）。'
    + '于是这一份第 0 帧我们是 `dep = 2^(mousy/yres*3)-1 = 7` 层（256² 的第 7 层 ≈ 一片灰）、'
    + '参考是清清楚楚的棋盘 —— **对不上才对**。'
    + '**顺带记着一格没判的口径**：两边 `mousy` 开局都是 240（参考定死 `480/2`、'
    + '我们照它写的），可正本说的是"光标在窗口正中" ⇒ 320×240 那一档本该是 120。'
    + '两边一样所以现在量不出来，哪天拿到原版的输出要重裁'],
  ['geo_test.pss',
    '**参考压根没有几何段**（两处，都在它自己源码里）：`rh_glSetShader`'
    + '（`c_impl/src/render/pd_polyhost_tex.c:352`）把**第二个实参当片元名**查、第三个不看，'
    + '而正本 `GLSETSHADER($,$,$)` 是 **(v, g, f)**（`polydraw.c:2210` 的 `kglsetshader3`、'
    + '`polydraw.txt:350`）；整份 `c_impl` 里 `PD_SEC_GEOMETRY` 只在切段处赋过值'
    + '（`pd_section.c:54`）、**无一处消费** —— 它那张图是"顶点 + 第 0 号片元"的普通三角。'
    + '我们按正本把 `@g` 那一段翻成 core 的 `layout(...)`+`gl_in[]` 真跑了'
    + '（§28.14）：画面是三个顶点各一个贴图小方块（按各自的顶点色染）加中间那张贴图三角 —— '
    + '与几何段里写的那几行一一对得上。照参考做等于把几何段扔掉'],
  ['geo_duptris.pss',
    '同 `geo_test`：参考没有几何段（证据见那一条）。我们这一份把输入的四边形按'
    + '`xyzw`/`yxzw`/两个取反共四趟发出去（几何段明写着），画出来是那个风车形的框；'
    + '`uniform vec4 env[2]` 那一格也顺手接上了（脚本拿 `glGetUniformLoc("env")+1` 指第 1 格 ——'
    + '真 GL 里数组元素的位置是连着的，我们两档设备现在把元素挨着登记）'],
  ['02_primitives_noshader.pss',
    '脚本 `for (i = 0; i < 6; i++)` 明写 6 个方块：我们画 6 个、参考只有 3 个'
    + '（连通块数出来的，不是看着像）。**机理量清楚了**（§28.13）：没有 `glsetshader`'
    + '那条路上，矩阵一变、后面那一批在参考那侧就整个不见'],
  ['02-gl.pss',
    '参考**压根没画那个青方块**（按颜色数：我们 1976 格、参考 0 格），别的三样'
    + '（渐变三角 / 黄线圈 / 白点列 40 格）两边逐格相同；'
    + '**机理量清楚了**（§28.13）：三格探针（同一个四边形画两次、中间夹'
    + '`gltranslate`/`glrotate`/`glscale`）参考都只剩第一批 —— 夹一对净变化为零的'
    + '`glpushmatrix/glpopmatrix` 才两边相同。从前那条"translate+glRotate 两边一致"的'
    + '最小复现只有一批，所以没试出来'],
  ['multiarb_asm.pss',
    '这一份**一句脚本都没有**（整份就是 `@v:0` / `@f:default` 两段 ARB 汇编）——'
    + '所以应该是一张**清过的图**。原版每帧的清屏色是 `glClearColor(0,0,0,0)`'
    + '（`polydraw.c:3572`），参考自己的默认也是 opaque black'
    + '（`c_impl/src/render/gl_renderer.c:944-945`），可参考出来的是**全白** ——'
    + '与两边的源码都不符（它那趟还先往 stderr 吐了 ARB 的 `syntax error`），'
    + '像是没画过任何东西时读回了未清的那块。我们给黑，照 polydraw.c:3572'],
]);

/** 这一格分辨率下该用多大的 fovy（度）—— 照 `ksetfov`：`tan(fovy/2) = 高/宽`。 */
const fovyOf = (w, h) => (Math.atan(h / w) * 360) / Math.PI;

/**
 * **第 0 帧本来就没东西的那几份**：`t = klock()` 给 0 ⇒ 粒子一个都没生、蛇缩成一个点。
 * 在第 0 帧量它们等于"两张全黑图相同"，什么都没证明（那五份从前就是这么白拿了一分的）。
 * 所以按名字把帧挪到**有东西的那一帧**（两边同一帧，照旧公平）。
 */
const FRAME_OF = new Map([
  ['dominos.pss', '30'],
  ['particules sparks.pss', '30'],
  ['ribbons invasion.pss', '30'],
  ['snake tube.pss', '30'],
]);
const frameOf = (name) => (argv.includes('--frame') ? CFG.frame : (FRAME_OF.get(name) ?? CFG.frame));

/**
 * 例子集：**`polydraw/` 底下全部 `.pss`**（`examples/` + `ken/` + `tigrou/`）+ 我们自己那几份。
 * `--dir` 只跑某一棵（`--dir ken`），`--only` 按名字过滤（**逗号分隔、取并集** ——
 * 按根因分组修的时候一趟就能把那一族都量上：`--only fractal,cubes,tree`）。
 */
function cases() {
  const out = [];
  const dirs = (val('--dir', 'examples,ken,tigrou')).split(',').filter((d) => d !== '');
  for (const d of dirs) {
    let names = [];
    try { names = readdirSync(`${PSS}/${d}`).sort(); } catch { continue; }
    for (const f of names) if (f.endsWith('.pss')) out.push(`${PSS}/${d}/${f}`);
  }
  if (val('--dir', '') === '') {
    for (const f of ['02-gl.pss', '04-shader.pss', '05-shader-geom.pss', '06-texture.pss']) {
      out.push(join(ROOT, 'ext/polydraw/examples', f));
    }
  }
  const pats = CFG.only.split(',').filter((s) => s !== '');
  return out.filter((f) => (pats.length === 0 || pats.some((p) => f.includes(p))) && existsSync(f));
}

/** 我们那一趟：`--gfx gl` 出一张裸表面。回像素（RGBA）或 null + 原因。 */
function ours(src, out, frame) {
  const r = spawnSync(process.execPath,
    [CLI, 'run', src, '--gfx', 'gl', '--frame', frame,
      '--w', String(CFG.w), '--h', String(CFG.h), '-o', out],
    { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  if (r.status !== 0 || !existsSync(out)) {
    const err = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n')
      .find((l) => /error|Error|没有|不过/.test(l)) ?? '跑不起来';
    return { px: null, why: err.trim().slice(0, 150) };
  }
  const b = readFileSync(out);
  return { px: b.subarray(b.indexOf(10) + 1), why: null };
}

/**
 * 参考那一趟：PNG -> PPM -> 像素（RGB）。**fovy 按分辨率算**（见文件头）。
 *
 * **`PD_NO_MVP_BAKE=1` 是有意给的**（口径在 `docs/design/eval-realtime-gpu.md` §26）：
 * 参考默认开着一格叫 `mvp_bake` 的优化（`c_impl/src/render/gl_renderer.c:1148`）——
 * 顶点着色器没提过 `gl_Vertex` 时把 MVP 在 CPU 上乘进顶点。那一步与它自己的 uniform
 * 那条路**对不上**：同一份脚本，`town textured` 开着它铺满 60%、关掉它全黑，
 * `menger sponge` / `funky` / `tree` / `clock` 也各差一截（量过 8 份，5 份不一致）。
 * 谁对：**关掉那一格的那条路**才是走真 GL 管线（与原版的固定管线同形）——
 * 一份控制探针（`gltranslate(0,0,-10); glrotate(90,0,0,1)` 的四边形）量出我们的裁剪坐标
 * 与它**逐位相同**（`(0,-1,9.802,10)`），而开着 bake 时它那张 MVP 的 z/w 两行是反号的
 * （拿负的 w 去除 —— 等于把镜头背后的东西画出来）。
 * 所以尺子取"关掉 bake"那一档；`REF_WRONG` 里那几条也照这一格重新裁。
 * 想量另一档（回到参考的默认）：`OMNI_PD_BAKE=1 node tests/eval/correct.js`。
 */
function ref(src, png, ppm, frame) {
  const env = { ...process.env };
  if (process.env.OMNI_PD_BAKE === '1') delete env.PD_NO_MVP_BAKE;
  else env.PD_NO_MVP_BAKE = '1';
  const r = spawnSync(REF, [src, '--frame', frame, '--w', String(CFG.w),
    '--h', String(CFG.h), '--fovy', fovyOf(CFG.w, CFG.h).toFixed(4), '-o', png],
  { encoding: 'utf8', timeout: 120000, env });
  if (r.status !== 0 || !existsSync(png)) {
    return { px: null, why: `参考也跑不出来：${(r.stderr ?? '').trim().slice(0, 120)}` };
  }
  const d = spawnSync(DEC, [png, ppm], { encoding: 'utf8', timeout: 60000 });
  if (d.status !== 0 || !existsSync(ppm)) return { px: null, why: 'PPM 转不出来' };
  const b = readFileSync(ppm);
  let i = 0;
  let n = 0;
  while (n < 3 && i < b.length) { if (b[i] === 10) n++; i++; }
  return { px: b.subarray(i), why: null };
}

/** 两张图的差：RMSE、两边的非黑格数、有差的格数、最大分量差。 */
function diffOf(a, b) {
  let se = 0;
  let nza = 0;
  let nzb = 0;
  let cnt = 0;
  let mx = 0;
  const n = CFG.w * CFG.h;
  for (let p = 0; p < n; p++) {
    const ai = p * 4;
    const bi = p * 3;
    if (a[ai] | a[ai + 1] | a[ai + 2]) nza++;
    if (b[bi] | b[bi + 1] | b[bi + 2]) nzb++;
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const e = a[ai + k] - b[bi + k];
      se += e * e;
      const ad = e < 0 ? -e : e;
      if (ad > d) d = ad;
    }
    if (d > 0) cnt++;
    if (d > mx) mx = d;
  }
  return { rmse: Math.sqrt(se / (n * 3)), nza, nzb, cnt, mx };
}

mkdirSync(OUT, { recursive: true });
const P = (s) => process.stdout.write(s);
let pass = 0;
let fail = 0;
let skip = 0;
const rows = [];
const t0 = Date.now();

P(`出图正确性（与 c_impl 逐像素对照，${CFG.w}×${CFG.h}，第 ${CFG.frame} 帧，`
  + `fovy ${fovyOf(CFG.w, CFG.h).toFixed(2)}°）：\n`);
P(`  尺子：${REFDIR}${REFDIR === PATCHED ? '（补过 mat4_rotate / setfov 两格）'
  : '（**原样** —— `glrotate` 是转置的、`setfov` 当场就换且不过 ksetfov，那两族量不准；'
    + '跑一趟 tests/eval/mkref.js）'}\n`);
if (!existsSync(REF) || !existsSync(DEC)) {
  P(`  --   这台机器上没有那份参考（${REF}）—— 整份跳过\n`);
  P('\n0 passed, 0 failed（出图正确性）\n');
  process.exit(0);
}

for (const src of cases()) {
  if (Date.now() - t0 > CFG.budget) { skip++; continue; }
  const name = basename(src);
  const tag = name.replace(/[^\w.-]/g, '_');
  const fr = frameOf(name);
  const o = ours(src, join(OUT, `${tag}.ours.rgba`), fr);
  const r = ref(src, join(OUT, `${tag}.ref.png`), join(OUT, `${tag}.ref.ppm`), fr);
  if (r.px === null) {
    /* 参考自己也画不出来 —— 那一份不算我们的红（c_impl 只有 ~80% 正确）。 */
    skip++;
    P(`  --   ${name} 参考画不出来，跳过（${r.why}）\n`);
    continue;
  }
  if (o.px === null) {
    fail++;
    rows.push({ name, cls: '跑不起来', why: o.why });
    P(`  FAIL ${name} 跑得起来\n       ${o.why}\n`);
    continue;
  }
  const d = diffOf(o.px, r.px);
  /* 已裁定"参考错"的那几份：印出来但**不计红**（理由跟着印，免得日子久了当成我们对）。 */
  const verdict = REF_WRONG.get(name);
  if (verdict !== undefined) {
    skip++;
    rows.push({ name, cls: '参考错', ...d });
    P(`  --   ${name} 参考错，不计（RMSE ${d.rmse.toFixed(2)}）\n       ${verdict}\n`);
    continue;
  }
  /**
   * 四档判定。第一档是 2026-09-25 补的**防洗白**那一格：**两边都不画**（各自非黑都
   * 几乎为 0）—— 以前它落在"逐像素相同"里白得一分，可"两张全黑图相同"什么都没证明，
   * 只证明参考也画不出来。换 bake 档的那一趟就是被它骗了：`town textured` 从
   * RMSE 183 变成"逐像素相同"，其实是**参考变黑了**，不是我们画对了。所以单独一档、
   * 计红，要放行必须进 `REF_WRONG` 并写清"这一帧本来就没东西"。
   */
  const blank = CFG.w * CFG.h * 0.002;
  if (d.nza < blank && d.nzb < blank) {
    fail++;
    rows.push({ name, cls: '都不画', ...d });
    P(`  FAIL ${name} 两边都不画（我们非黑 ${d.nza}、参考 ${d.nzb}）—— 这一格什么都没证明\n`);
  } else if (d.nzb > CFG.w * CFG.h * 0.01 && d.nza < d.nzb * 0.1) {
    fail++;
    rows.push({ name, cls: '黑图', ...d });
    P(`  FAIL ${name} 不是黑图\n       我们非黑 ${d.nza}、参考 ${d.nzb}\n`);
  } else if (d.rmse > CFG.rmse && d.cnt > CFG.w * CFG.h * CFG.pxdiff) {
    fail++;
    rows.push({ name, cls: '差异大', ...d });
    P(`  FAIL ${name} RMSE ≤ ${CFG.rmse}\n       RMSE ${d.rmse.toFixed(2)}`
      + `（非黑 ${d.nza} vs ${d.nzb}、有差 ${d.cnt} 格 = `
      + `${((d.cnt / (CFG.w * CFG.h)) * 100).toFixed(2)}%、最大差 ${d.mx}）\n`);
  } else {
    pass++;
    const cls = d.rmse === 0 ? '逐像素相同' : (d.rmse > CFG.rmse ? '一小撮格子' : '够近');
    rows.push({ name, cls, ...d });
    P(`  ok   ${name} ${d.rmse === 0 ? '逐像素相同'
      : `RMSE ${d.rmse.toFixed(2)}、有差 ${((d.cnt / (CFG.w * CFG.h)) * 100).toFixed(2)}%`}\n`);
  }
}

P('\n  RMSE   我们非黑   参考非黑   有差的格  最大差  判定        例子\n');
for (const r of rows.sort((a, b) => (b.rmse ?? 1e9) - (a.rmse ?? 1e9))) {
  P(`  ${(r.rmse === undefined ? '—' : r.rmse.toFixed(2)).padStart(6)}`
    + `  ${(r.nza === undefined ? '—' : String(r.nza)).padStart(9)}`
    + `  ${(r.nzb === undefined ? '—' : String(r.nzb)).padStart(9)}`
    + `  ${(r.cnt === undefined ? '—' : String(r.cnt)).padStart(9)}`
    + `  ${(r.mx === undefined ? '—' : String(r.mx)).padStart(6)}`
    + `  ${r.cls.padEnd(10)}  ${r.name}${r.why ? `  （${r.why.slice(0, 60)}）` : ''}\n`);
}
writeFileSync(join(OUT, 'account.json'),
  `${JSON.stringify({ cfg: CFG, rows }, null, 2)}\n`);
P(`\n账落在 ${join(OUT, 'account.json')}\n`);
P(`\n${pass} passed, ${fail} failed${skip > 0 ? `, ${skip} 跳过` : ''}（出图正确性：`
  + `与 c_impl 逐像素对照）\n`);
process.exit(fail === 0 ? 0 : 1);


