/**
 * **首页那一屏**（展示模式）的清单 —— `docs/design/omni-serve-studio.md` §4.1。
 *
 * 展示模式**不是"IDE 把编辑关掉"**。它是首页：一屏卡片，每格一张**真跑出来的图**。
 * 所以这一份是**策展的清单**，不是"把树上的例子都摆出来" —— 树上一百多份 `.asy` 里
 * 绝大多数是算术与打印（`01-arith.asy` 印 `22 12 85 …`），它们上首页只会让首页变成
 * 一墙空白卡片。**没有图的例子不上首页**，这是这一份存在的全部理由。
 *
 * 为什么是手写的清单而不是"跑一遍看谁出图"：后者要把整棵树跑一趟（分钟级），而首页
 * 要在两百毫秒内出现。判据那一侧反过来 —— `tests/serve` 会把这张表里每一格真跑一趟，
 * 确认它**确实出图**（`kind: 'asy'` 那几格的 stdout 必须以 `%!PS` 起头）。
 * 于是"清单是人挑的、清单没骗人是机器判的"。
 *
 * 住在 `src/studio/` 而不是 `src/core/studio/`：服务那侧的静态文件只从这一个目录发
 * （`serve.js` 的 `studioDir`），而这一份要能被页面 import。
 *
 * 一格的形状：
 *   `path`  仓库里的相对路径（必须在 `TREE_ROOTS` 的白名单里 —— 首页点一下要能打开它）
 *   `kind`  怎么出图：`asy`（跑一趟，EPS 翻成 SVG）/ `svg`（跑一趟，stdout 本身就是 SVG）/
 *           `glsl`（WebGL2 编译着色器）/ `html`（就是一份网页，塞进 iframe）
 *   `title` 卡片上的名字（不是文件名 —— 文件名是给判据用的）
 *   `note`  一句话说这格在画什么
 *
 * 往后加"那一族"（logo / turtle 那种艺术绘图）就是往这张表里加几格 + 它们各自的腿。
 */

export const GALLERY = [
  /* ---- asy：真跑一趟，EPS 翻成 SVG（`src/studio/render.js` 的 `epsToSvg`） ---- */
  {
    path: 'tests/asy/draw/tri.asy', kind: 'asy', title: '三角与填充',
    note: 'size / draw / fill / shipout —— 绘图层的第一刀',
  },
  {
    path: 'tests/asy/draw/colors.asy', kind: 'asy', title: '三档颜色',
    note: 'cmyk / rgb / 灰各走各的算子，笔的状态是增量发的',
  },
  {
    path: 'tests/asy/draw/curve.asy', kind: 'asy', title: '三次曲线',
    note: '`..` 出来的段发 curveto，坐标印到 9 位有效数字',
  },
  {
    path: 'tests/asy/draw/xform.asy', kind: 'asy', title: '旋转与定标',
    note: 'rotate(30) 在降级前就把点算好了 —— EPS 里只看见算完的坐标',
  },
  {
    path: 'tests/asy/draw/implicit.asy', kind: 'asy', title: '隐式出图',
    note: '一行 shipout 都不写，退出时补出来',
  },

  /* ---- glsl：在页面上用 WebGL2 编译并画满一格（`glslSource` 把 330 core 改成 300 es） ---- */
  {
    path: 'tests/glsl/cases/pretty.frag', kind: 'glsl', title: '渐变与圆',
    note: '片元着色器：按屏幕坐标算颜色',
  },
  {
    path: 'tests/glsl/cases/vispy-disc.frag', kind: 'glsl', title: 'vispy：抗锯齿圆点',
    note: '复刻 vispy 的 marker_disc + filled（有符号距离场）',
  },
  {
    path: 'tests/glsl/cases/vispy-stroke.frag', kind: 'glsl', title: 'vispy：描边',
    note: '同一套距离场，画的是线不是面',
  },
  {
    path: 'tests/glsl/cases/vispy-colormap.frag', kind: 'glsl', title: 'vispy：色表',
    note: '一维色表查表上色，两头各留一段落在区间外',
  },

  /* ---- html：浏览器自己的本事，原样塞进 iframe ---- */
  {
    path: 'ext/html/examples/02-canvas.html', kind: 'html', title: 'canvas 动画',
    note: 'requestAnimationFrame 画 Lissajous 曲线',
  },
  {
    path: 'ext/html/examples/01-box.html', kind: 'html', title: 'CSS 渐变卡片',
    note: '渐变 + keyframes，一行脚本都没有',
  },
  {
    path: 'ext/html/examples/03-svg-form.html', kind: 'html', title: 'SVG 与表单',
    note: '内联 SVG + 原生控件联动',
  },

  /* ---- svg：跑一趟，stdout 本身就是一张 SVG（`std/plot.omni` 那一层） ---- */
  {
    path: 'ext/omni/examples/scicomp.omni', kind: 'svg', title: '二次拟合',
    note: '矩阵 + 最小二乘 + 出图，三层都是 Omni 自己写的',
  },
];

/** 这张表里的路径（判据与"某一格在不在首页上"两处用）。 */
export const galleryPaths = () => GALLERY.map((g) => g.path);
