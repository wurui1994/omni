// src/core/host/gfx-cpu.js —— **图形设备的 CPU 备选**（EVAL 两门语言的宿主面，JS 那一族共用）
//
// 这一份是 `docs/design/eval-realtime-gpu.md` 里那张表的第三行：**备选**。
// 默认那两档是真 GPU（浏览器 WebGL2、本机 OpenGL）；这一份只在
// `--gfx=cpu` / 没有 GL 的机器 / 判据要逐字节可比的那几格上跑。
//
// ## 为什么在宿主这一侧，而不是生成出来的 IR
//
// 第一版把光栅器写成"生成出来的标准 IR"（`ext/polydraw/gfx-rt.js`）——三条腿逐字节相同，
// 但它**默认就是模拟渲染**，而且着色器那一族永远没有落点。翻过来之后：语言那一侧只发
// `(gfxcall "名字" 实参…)`，宿主这一侧才是设备 —— 于是同一份脚本换个设备就是换个后端。
//
// ## 一格设备的状态与那张名字表
//
// 名字与语义照 `evaldraw_ref.md`（EvalDraw 的 2D 那一档）：坐标左上角原点、y 往下、
// 颜色分量 0..255。像素落在 `fb`（一格一个 `0xRRGGBB` 的数）；`refresh` 把这一帧写成
// `#rgba <w> <h>\n` + 裸 RGBA 的表面文件，stdout 上只留一行指针。
//
// **像素算法与 `ext/polydraw/gfx-rt.js` 逐句相同**（Bresenham、中点画圆、沿线铺圆）——
// 那是有意的：换路之后同一份例子的表面要**逐字节相同**，这条才是"搬家不改语义"的判据。

import { writeBinary, mkdirAll, stdout, stderr, env, nowMs, localStamp } from './native.js';
import { pngFromRgba, surfaceKind } from './png.js';
import { dlopenAddon } from './ffi_host.js';

/** 设备的那几格状态。**一格进程一格设备**（EVAL 的宿主本来就是这个形状）。 */
const D = {
  w: 0, h: 0, fb: null, col: 0xffffff, x: 0, y: 0, on: false,
  out: '.omni-cache/gfx/frame.png',
  /* 帧循环那三格：`fno` 是已经开始画的帧数（脚本里的 `numframes` = fno-1，第一帧是 0）、
     `frames` 是这一趟要画几帧（`OMNI_FRAMES`，默认 1）、`dirty` 是"这一帧动过没有"
     —— 没动过就不重复写表面（脚本自己调 `refresh()` 之后帧末那一次就免了）。 */
  fno: 0, frames: -1, dirty: false,
  /* **两个模式**（`--mode`，`docs/design/eval-realtime-gpu.md` 第 7 节）：
     `render` 是默认 —— 离屏画定几帧、klock 是"帧号/60"的确定性时钟；
     `view` 是"有窗口地跑"，那一档在这条腿上没有窗口（任务 #24），只把时钟换成墙上时间。
     `only` 是 `--frame N`（只交出第 N 帧，照 c_impl 的 `polydraw-render`），-1 = 每帧都交。 */
  mode: '', only: -1,
  /* 性能那几格（`--perf`）：一帧的墙上时间是两次 `nextframe` 之间那一段。 */
  perf: -1, tPrev: 0, tSum: 0, tMin: 0, tMax: 0, tn: 0,
  /* 输入那几格（`mousx`/`mousy`/`bstatus`/`keystatus[256]`）。`keys` 是"还没开"的记号。
     **开局那个位置是 (320,240)**：原版一开机光标就在窗口正中（默认窗口 640×480），
     参考也是这么定死的（`c_impl/src/pd_polyhost.c:22`，注释写着 "original starts the
     cursor at window center"）—— 它按的是 640×480 那个默认尺寸，**不随 `--w/--h` 变**。
     13 份 `.pss` 读这两格（`orthoglobe` 的 `z = mousy/yres*4` 给 0 就整张图退化成一条线），
     所以这一格是判据上最大的一处"开局状态"口径，不是随手写的 0。 */
  mx: 320, my: 240, bst: 0, keys: null,
};

/** 一格整数旗子（环境变量那一档，读不出数就用默认）。 */
function intEnv(name, dflt) {
  const v = env(name);
  if (v === undefined || v === null || v === '') return dflt;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : dflt;
}

/** `render`（默认）还是 `view` —— `OMNI_GFX_MODE`（CLI 的 `--mode` 落成它）。 */
function modeOf() {
  if (D.mode === '') D.mode = env('OMNI_GFX_MODE') === 'view' ? 'view' : 'render';
  return D.mode;
}

/**
 * **录制那一档**（`OMNI_GFX=null`）：名字 -> 这一趟发了几次，**一个像素都不画**。
 *
 * 两个用处，都不是"少画点省时间"：
 *
 * 1. **量语言这一半**（与 c_impl 的 `bench` 同一个口径）：一帧的时间里去掉光栅化那一截，
 *    剩下的就是脚本本身 + 宿主调用的开销 —— 我们三条腿（js / interp / c）拿它互比，
 *    也拿它与参考实现的 interp/llvm 两档比。
 * 2. **量覆盖**：这一档**认所有名字**（记一笔、回 0），于是一份脚本能一路跑到底，
 *    账上那串名字就是"它到底要哪几格 API"。撞上第一个没有的名字就报那种查法，
 *    一份脚本要查十几遍才知道还缺什么。
 *
 * 查询那一族（`xres`/`numframes`/`klock`/输入那几格）在这一档里**照旧给真答案** ——
 * 脚本靠它们分支，回 0 会让整份脚本走上另一条路（那时量的就不是同一件事了）。
 */
let REC = null;
/**
 * `OMNI_GFX=null` 那一档只判**一次**（-1 还没判 / 0 不是 / 1 是）。
 *
 * **为什么要记住**：`recOn()` 在每一格图形调用、每一段批、每一张纹理上都问一次，
 * 而 `process.env[…]` 在 node 里是**原生存取器**（一次约一微秒）—— 量出来
 * `disco ball` 那一份里 `env` 自用 72ms / 1398ms（5%），全是这一句问出来的。
 * 环境在一趟进程里不变，所以记住是安全的。
 */
let REC_MODE = -1;
function recOn() {
  if (REC_MODE < 0) REC_MODE = env('OMNI_GFX') === 'null' ? 1 : 0;
  if (REC_MODE === 1 && REC === null) REC = new Map();
  return REC !== null;
}

/** 录制那一档里**仍然要给真答案**的那几格（脚本靠它们分支 / 帧循环靠它转）。 */
const QUERY = new Set(['nextframe', 'numframes', 'klock', 'xres', 'yres',
  'mousx', 'mousy', 'bstatus', 'setbstatus', 'keystatus', 'setkeystatus', 'rgb']);

/**
 * **`klock(i)` 的日期那一族**（口径照 `polydraw_src/polydraw.c:1662` 的 `myklock`）：
 *
 *   i = 0        从开跑起的秒数（render 模式下是"帧号/60"的确定性时钟，见下面那一格）
 *   |i| in 1..9  日期分量：**i>0 本地时间、i<0 UTC**
 *     1 = YYYYMMDDHHMMSS.sss（那个打包的数 × .001）  2 = 年   3 = 月
 *     4 = 星期（0 = 周日）  5 = 日   6 = 时   7 = 分   8 = 秒   9 = 毫秒
 *   别的 i      0
 *
 * 本地那一档走宿主的 `localStamp()`（封闭 ABI 里现成的一格："读一次时钟"回 14 位数字），
 * UTC 那一档从 `nowMs()` 用整数算（`civil_from_days` 那套算法）—— 两条都不碰 `new Date()`
 * （它不在我们自己那台 JS 前端认的构造里，写了自举那一路就编不过）。
 */
function klockParts(i) {
  const ms = nowMs();
  const msec = Math.trunc(ms) % 1000;
  let y = 0;
  let mo = 0;
  let d = 0;
  let h = 0;
  let mi = 0;
  let s = 0;
  if (i < 0) {
    /* UTC：从 epoch 毫秒往回算（Hinnant 的 civil_from_days，整数运算）。 */
    const days = Math.floor(ms / 86400000);
    const secOfDay = Math.floor(ms / 1000) - days * 86400;
    h = Math.floor(secOfDay / 3600);
    mi = Math.floor(secOfDay / 60) % 60;
    s = secOfDay % 60;
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
      - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    mo = mp < 10 ? mp + 3 : mp - 9;
    y = yoe + era * 400 + (mo <= 2 ? 1 : 0);
  } else {
    const st = localStamp();                    /* YYYYMMDDHHMMSS（本地、同一个瞬间） */
    y = Number(st.slice(0, 4));
    mo = Number(st.slice(4, 6));
    d = Number(st.slice(6, 8));
    h = Number(st.slice(8, 10));
    mi = Number(st.slice(10, 12));
    s = Number(st.slice(12, 14));
  }
  /* 星期：Sakamoto 那张表（0 = 周日）。 */
  const T = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = mo < 3 ? y - 1 : y;
  const dow = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400)
    + T[mo - 1] + d) % 7;
  const k = Math.abs(Math.trunc(i));
  if (k === 1) {
    return ((((((y * 100 + mo) * 100 + d) * 100 + h) * 100 + mi) * 100 + s) * 1000 + msec) * 0.001;
  }
  if (k === 2) return y;
  if (k === 3) return mo;
  if (k === 4) return dow;
  if (k === 5) return d;
  if (k === 6) return h;
  if (k === 7) return mi;
  if (k === 8) return s;
  if (k === 9) return msec;
  return 0;
}

/**
 * **输入那一族的来源**：CPU 这一档没有窗口，所以从环境变量读一次 ——
 * `OMNI_MOUSE=x,y,按键位`、`OMNI_KEYS=0xc8,0x1d`（按住的扫描码，逗号分隔）。
 *
 * 这么定有两个好处：判据能真跑输入那一族（不是永远读到 0），而且**三条腿逐字节相同**
 * 的口径仍然成立（输入是这一趟的常量）。GL 那两档里来源是真事件（canvas / 窗口）。
 *
 * 脚本写回去也生效（`bstatus--`、`keystatus[k]=0`）—— PolyDraw 的说明书里
 * "消掉一次点击/一次按键"就是这么写的（`polydraw.txt:381`、`:388`）。
 */
function needInput() {
  if (D.keys !== null) return;
  const keys = [];
  for (let i = 0; i < 256; i++) keys.push(0);
  D.keys = keys;
  const m = env('OMNI_MOUSE');
  if (m !== undefined && m !== null && m !== '') {
    const p = String(m).split(',');
    const n0 = Number(p[0]);
    const n1 = Number(p[1]);
    const n2 = Number(p[2]);
    D.mx = Number.isFinite(n0) ? n0 : 0;
    D.my = Number.isFinite(n1) ? n1 : 0;
    D.bst = Number.isFinite(n2) ? Math.trunc(n2) : 0;
  }
  const k = env('OMNI_KEYS');
  if (k !== undefined && k !== null && k !== '') {
    for (const s of String(k).split(',')) {
      const c = Math.trunc(Number(s));
      if (Number.isFinite(c) && c >= 0 && c < 256) D.keys[c] = 1;
    }
  }
}

const rnd = (v) => Math.floor(v + 0.5);
const clamp255 = (v) => {
  const i = rnd(v);
  return i < 0 ? 0 : (i > 255 ? 255 : i);
};
const rgb = (r, g, b) => clamp255(r) * 65536 + clamp255(g) * 256 + clamp255(b);

/** 第一次画之前自动开一块（EVAL 的脚本里没有"开设备"那一句 —— 窗口是宿主给的）。
 *  尺寸：默认 320×240，`--w`/`--h`（`OMNI_GFX_W`/`OMNI_GFX_H`）能换。 */
function need(w, h) {
  if (D.on) return;
  D.w = intEnv('OMNI_GFX_W', w);
  D.h = intEnv('OMNI_GFX_H', h);
  /* **普通数组**（不是 Int32Array）：这一份要能被我们自己那台 JS 前端降级，
     子集里还没有 TypedArray（`feedback_check_self_gate.md` 那条纪律：撞上就扩，
     但这一格用普通数组没有代价 —— 它不在热路径的最内层）。 */
  const n = D.w * D.h;
  const fb = [];
  for (let i = 0; i < n; i++) fb.push(0);
  D.fb = fb;
  D.on = true;
  D.col = 0xffffff;
  D.x = 0;
  D.y = 0;
  /* GL 那一档（`OMNI_GFX=gl`）：尺寸定下来了才开得出离屏那一格。挂不上就照旧 CPU 备选。 */
  if (glWant()) glNeed();
}

function px(x, y, c) {
  const xi = rnd(x);
  const yi = rnd(y);
  if (xi < 0 || yi < 0 || xi >= D.w || yi >= D.h) return;
  D.fb[yi * D.w + xi] = c;
  D.dirty = true;
}

/* ── **本机 GL 那一档**（`OMNI_GFX=gl`）：走 N-API 扩展转给 `libomnigl` 里那台设备 ────
 *
 * 口径 `docs/design/eval-realtime-gpu.md` §16。这一格让 **js 腿与解释器腿也能走 GPU** ——
 * 那两条是"改完立刻能跑"的路（没有 cc、没有链接），实时那一栏靠的就是它们。
 *
 * **与 `runtime/omni_fmt.c` 里那条转发支路逐句对应**（那边是 dlopen + 函数指针、
 * 这边是 `process.dlopen` 装一份 N-API 扩展）：所以两条腿的行为天然一致，
 * 帧循环 / 输入 / `present` / 两层合成全都复用这一份现成的，一个字都不用另写。
 *
 * **两层怎么合**：GPU 画顶点批；`setpix`/`lineto`/`drawsph` 那一族仍落在 `D.fb` 上
 * （语言那一侧没把它们变顶点）。所以 GL 开着时 `D.fb` 的初值是 **-1 = 这一格没人画**，
 * 交帧时 GPU 那一层当底、`D.fb` 盖上去。
 */
const G = {
  tried: false, on: false, m: null,
  /* 设备还没开起来之前登记的那几份串（着色器原文与名字表）—— 开起来之后一趟补过去。 */
  defs: [],
  /* **名字表**（下标 -> 串）：文件纹理那一档要在这一层把下标还原成文件名、再按脚本所在的
     目录拼成路径（目录只有宿主知道，见 `texPath`）。 */
  names: [],
  /* 读回那一格（一格一个 0xRRGGBB，与 `D.fb` 同形）：一帧只读一次，数组复用。 */
  gpu: null,
};

const glWant = () => env('OMNI_GFX') === 'gl';

/** 装那份扩展并开设备（尺寸定了才开得出来 —— 所以由 `need` 叫）。回 true = GL 这一档活着。 */
function glNeed() {
  if (G.tried) return G.on;
  G.tried = true;
  if (!glWant()) return false;
  const p = env('OMNI_EV_GL_ADDON');
  if (p === undefined || p === null || p === '') {
    stderr('#gfx gl 挂不上（OMNI_EV_GL_ADDON 没指到那份 .node）—— 这一趟走 CPU 备选\n');
    return false;
  }
  let m = null;
  try {
    m = dlopenAddon(p);
  } catch (e) {
    stderr(`#gfx gl 装不上那份扩展（${e && e.message ? e.message : e}）—— 这一趟走 CPU 备选\n`);
    return false;
  }
  if (m === null || m === undefined || typeof m.open !== 'function') {
    stderr('#gfx gl 那份扩展里没有 open —— 这一趟走 CPU 备选\n');
    return false;
  }
  if (m.open(D.w, D.h) !== 0) {
    stderr(`#gfx gl 开不出来（${m.error()}）—— 这一趟走 CPU 备选\n`);
    return false;
  }
  G.m = m;
  G.on = true;
  GFX_CPU.kind = 'native-gl';
  for (let i = 0; i < G.defs.length; i++) {
    const d = G.defs[i];
    m.def(d[0], d[1], d[2]);
  }
  glClearHost();
  return true;
}

/** GL 开着时：宿主那格帧缓冲清成"没人画"（-1），GPU 那一层自己清。 */
function glClearHost() {
  const n = D.w * D.h;
  for (let i = 0; i < n; i++) D.fb[i] = -1;
}


function cls(r, g, b) {
  const c = rgb(r, g, b);
  if (G.on) { G.m.cls(c); glClearHost(); D.dirty = true; return; }
  const n = D.w * D.h;
  for (let i = 0; i < n; i++) D.fb[i] = c;
  D.dirty = true;
}

/** Bresenham。两头都画（与 EvalDraw 的 `lineto` 一样是闭区间）。 */
function line(x0, y0, x1, y1, c) {
  let x = rnd(x0);
  let y = rnd(y0);
  const xe = rnd(x1);
  const ye = rnd(y1);
  const dx = Math.abs(xe - x);
  const dy = Math.abs(ye - y);
  const sx = x > xe ? -1 : 1;
  const sy = y > ye ? -1 : 1;
  let err = dx - dy;
  for (;;) {
    px(x, y, c);
    if (x === xe && y === ye) return;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

/** 填充圆：逐行算半弦长，一行一段。 */
function disc(cx, cy, r, c) {
  const ri = rnd(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const dx = Math.floor(Math.sqrt(ri * ri - dy * dy));
    for (let x = -dx; x <= dx; x++) px(cx + x, cy + dy, c);
  }
}

/** 描边圆：中点画圆 + 八分对称。 */
function circ(cx, cy, r, c) {
  let x = rnd(r);
  let y = 0;
  let err = 1 - x;
  while (x >= y) {
    px(cx + x, cy + y, c);
    px(cx + y, cy + x, c);
    px(cx + x, cy - y, c);
    px(cx + y, cy - x, c);
    px(cx - x, cy + y, c);
    px(cx - y, cy + x, c);
    px(cx - x, cy - y, c);
    px(cx - y, cy - x, c);
    y += 1;
    if (err < 0) err += 2 * y + 1;
    else { x -= 1; err += 2 * (y - x) + 1; }
  }
}

/** `drawcone(x,y,r,x2,y2,r2)` 是**粗线**：沿线铺圆（形状对、边缘比真梯形略毛）。 */
function cone(x0, y0, r0, x1, y1, r1, c) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.floor(Math.hypot(dx, dy) + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    disc(x0 + t * dx, y0 + t * dy, r0 + t * (r1 - r0), c);
  }
}

/** 这一帧的**裸 RGBA**（一字符一字节、第 0 行在上、alpha 恒 255）—— 两个出口都从它来。 */
function rgbaBytes() {
  const rows = [];
  for (let y = 0; y < D.h; y++) {
    let row = '';
    for (let x = 0; x < D.w; x++) {
      const i = y * D.w + x;
      /* GL 那一档：`-1` 是"这一格宿主没画" ⇒ 取 GPU 那一层读回来的那一格（§16）。 */
      const raw = D.fb[i];
      const v = (raw < 0 ? (G.gpu === null ? 0 : G.gpu[i]) : raw) & 0xffffff;
      row += String.fromCharCode((v - v % 65536) / 65536)
        + String.fromCharCode((v % 65536 - v % 256) / 256)
        + String.fromCharCode(v % 256) + String.fromCharCode(255);
    }
    rows.push(row);
  }
  return rows.join('');
}

/** 备选那个出口的字节（`#rgba <w> <h>\n` + 裸 RGBA）。 */
export function gfxSurfaceBytes() {
  return `#rgba ${D.w} ${D.h}\n${rgbaBytes()}`;
}

/** 设备现在多大（`xres` / `yres` 那两格量、与贴 canvas 那一侧都要问它）。 */
export function gfxSize() { return { w: D.w, h: D.h, on: D.on }; }
export function gfxOut() { return D.out; }
export function gfxSetOut(p) { D.out = p; }
/** 默认画布尺寸：EvalDraw 的窗口是宿主给的，这条腿上定 320×240（判据也按它）。 */
export function gfxOpen(w = 320, h = 240) { D.on = false; need(w, h); }

/**
 * 帧循环那几格旗子读一次（第一次问 `nextframe` 的时候）。
 *
 * 两条互斥的算法：`--frame N`（`OMNI_GFX_FRAME`）是"走到第 N 帧、**只交出那一帧**"
 * —— 照 c_impl 的 `polydraw-render`（脚本靠 `numframes` 动画，要看第 30 帧就得把前 30 帧
 * 真跑过去）；没给就照 `OMNI_FRAMES`（默认 1）每帧都交。
 */
function frameSetup() {
  const one = intEnv('OMNI_GFX_FRAME', -1);
  D.only = one;
  const n = one >= 0 ? one + 1 : intEnv('OMNI_FRAMES', 1);
  D.frames = n > 0 ? n : 1;
  D.perf = env('OMNI_GFX_PERF') === '1' ? 1 : 0;
}

/** 一帧末：记一笔时间，再看这一帧要不要交出去。 */
function frameEnd() {
  const dt = nowMs() - D.tPrev;
  D.tSum += dt;
  D.tn += 1;
  if (D.tn === 1 || dt < D.tMin) D.tMin = dt;
  if (dt > D.tMax) D.tMax = dt;
  /* **点着名要的那一帧一定交**（`--frame N`）：PolyDraw 的窗口每帧都在，
     一个像素都没画的脚本给出的是**一张清过的图**，不是"没有图"。
     `ken/multiarb_asm.pss` 整份只有 `@v`/`@f` 两段、一句脚本都没有 ——
     从前我们什么都不写、判据记成"跑不起来"，参考给的是一张 64×64 的清屏图。 */
  if (D.only >= 0 && D.fno - 1 === D.only) {
    need(320, 240);
    present();
    return;
  }
  if (D.dirty && D.only < 0) present();
}

/** 一位小数（`toFixed` 不在我们那套 JS 子集里 —— 而且这一格三条腿都要有同一份）。 */
function ms1(v) {
  const r = Math.round(v * 10) / 10;
  const w = Math.trunc(r);
  return `${w}.${Math.round((r - w) * 10)}`;
}

/**
 * 这一趟的**性能账**（`--perf` / `OMNI_GFX_PERF=1` 才印，落在 **stderr** 上）。
 *
 * 为什么不落 stdout：那一股上只许有指针行（判据按行比）。格式与 Studio 那一侧
 * 显示的是同一组数（帧数 / 总时间 / 每帧平均 / 最快最慢 / fps）。
 *
 * 录制那一档（`OMNI_GFX=null`）多印一行 **调用账**：总次数 + 最多的那几个名字。
 * 那一行同时是两件事的答案：「这份脚本每帧发多少次宿主调用」（性能）与
 * 「它到底要哪几格 API」（覆盖）—— 后者比"撞上第一个没有的名字就报"准得多。
 */
function perfReport() {
  if (D.perf !== 1 || D.tn === 0) return;
  D.perf = 2;
  const avg = D.tSum / D.tn;
  stderr(`#perf gfx ${modeOf()} frames=${D.tn} total=${ms1(D.tSum)}ms`
    + ` avg=${ms1(avg)}ms min=${ms1(D.tMin)}ms max=${ms1(D.tMax)}ms`
    + ` fps=${ms1(avg > 0 ? 1000 / avg : 0)}\n`);
  if (REC !== null) {
    let n = 0;
    for (const v of REC.values()) n += v;
    const top = [...REC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, v]) => `${k}:${v}`).join(' ');
    stderr(`#perf calls total=${n} names=${REC.size} ${top}\n`);
  }
}

/**
 * **一格宿主调用**：名字 + 一串 double 实参，回一个 double（EVAL 的宿主面就是这个形状）。
 *
 * 认不出的名字**当场炸**，并把这一格设备有哪些名字说出来 —— 不许静默回 0
 * （那是"图不对但没人知道"的来源）。
 */
export function gfxCall(name, args) {
  const a = (i) => Number(args[i] ?? 0);
  const key = `${name}/${args.length}`;
  /* **录制那一档**（`OMNI_GFX=null`）：记一笔，画图那一族就到此为止。
     查询与帧循环那几格照旧往下走 —— 脚本靠它们分支（见 `recOn` 的头注）。 */
  if (recOn()) {
    REC.set(key, (REC.get(key) ?? 0) + 1);
    if (!QUERY.has(name)) return 0;
  }
  switch (key) {
    case 'cls/3': need(320, 240); cls(a(0), a(1), a(2)); return 0;
    /* `cls(打包好的颜色)`：EvalDraw 里最常见的写法（`cls(0)`）—— 与 `setcol/1` 同一档。 */
    case 'cls/1': {
      need(320, 240);
      const c = Math.trunc(a(0)) & 0xffffff;
      if (G.on) { G.m.cls(c); glClearHost(); D.dirty = true; return 0; }
      const n = D.w * D.h;
      for (let i = 0; i < n; i++) D.fb[i] = c;
      D.dirty = true;
      return 0;
    }
    case 'setcol/3': need(320, 240); D.col = rgb(a(0), a(1), a(2)); return 0;
    /* **深度测试**（语言那一侧的 `gl_enable(GL_DEPTH_TEST)` 转过来的）：CPU 备选那一档
       **没有 z 缓冲**，所以收下记着不用；GL 那一档转过去（GPU 的 z 缓冲只有设备做得到）。 */
    case 'gldepth/1':
      if (G.on) G.m.depth(Math.trunc(a(0)) !== 0 ? 1 : 0);
      return 0;
    /* **面剔除**（语言那一侧的 `glcullface` 转过来的，0 关 / 1 剔背面 / 2 剔正面）：
       CPU 备选这一档没有真管线（三角是按扫描线填的，没有绕向那一格），收下不管；
       GL 那一档转过去。 */
    case 'glcull/1':
      if (G.on && typeof G.m.cull === 'function') G.m.cull(Math.trunc(a(0)));
      return 0;
    case 'setcol/1': need(320, 240); D.col = Math.trunc(a(0)) & 0xffffff; return 0;
    case 'setpix/2': need(320, 240); px(a(0), a(1), D.col); return 0;
    case 'moveto/2': need(320, 240); D.x = a(0); D.y = a(1); return 0;
    case 'lineto/2':
      need(320, 240);
      line(D.x, D.y, a(0), a(1), D.col);
      D.x = a(0);
      D.y = a(1);
      return 0;
    /* `drawsph(x,y,r)`：**半径为负是描边**（`evaldraw_ref.md` 那句话）。 */
    case 'drawsph/3':
      need(320, 240);
      if (a(2) < 0) circ(a(0), a(1), -a(2), D.col);
      else disc(a(0), a(1), a(2), D.col);
      return 0;
    case 'drawcone/6':
      need(320, 240);
      cone(a(0), a(1), a(2), a(3), a(4), a(5), D.col);
      return 0;
    case 'rgb/3': return rgb(a(0), a(1), a(2));
    /* `refresh()`：**交出这一帧**。CPU 这一档就是写表面 + 印一行指针
       （GL 那两档在各自的设备里是交换缓冲）。 */
    case 'refresh/0': need(320, 240); present(); return 0;
    /**
     * **帧循环的那一格**（`(gfxcall "nextframe")`）：产物自己 `while` 着问它
     * "还画不画下一帧"，于是**循环在设备里**（design 文档第 3 节）：
     *
     * * CPU / 离屏这一档：画 `OMNI_FRAMES` 帧（默认 1），每帧末把动过的那一帧交出去；
     * * 本机 OpenGL 那一档（往后）：poll 事件 + 交换缓冲 + 窗口没关就回 1 —— 真实时循环；
     * * 浏览器那一档（往后）：页面驱动，这一格的形状还要再定（worker + OffscreenCanvas，
     *   或者把帧函数交出去）。
     *
     * `numframes` 与它配套：脚本里第一帧是 0（EVAL 的脚本靠 `if (numframes == 0)` 做初始化）。
     */
    case 'nextframe/0': {
      need(320, 240);
      if (D.frames < 0) frameSetup();
      if (D.fno > 0) frameEnd();
      if (D.fno >= D.frames) { perfReport(); return 0; }
      D.fno += 1;
      D.tPrev = nowMs();
      return 1;
    }
    case 'numframes/0': need(320, 240); return D.fno > 0 ? D.fno - 1 : 0;
    /**
     * `klock()`：秒。**render 模式下是确定性时钟**（帧号 / 60，照 c_impl 的
     * `pdrl_set_clock_scale(ctx, 1/60)`）—— 离屏画一帧要出一份能逐字节比的图，
     * 墙上时间在那儿是噪声。`view` 模式（有窗口地跑）才是真墙上时间。
     */
    case 'klock/0':
      return modeOf() === 'view' ? nowMs() / 1000 : (D.fno > 0 ? D.fno - 1 : 0) / 60;
    /* `klock(i)`：0 与 klock() 同；|i| 在 1..9 是日期分量（见 `klockParts` 的头注）。 */
    case 'klock/1':
      if (Math.trunc(a(0)) === 0) {
        return modeOf() === 'view' ? nowMs() / 1000 : (D.fno > 0 ? D.fno - 1 : 0) / 60;
      }
      return klockParts(a(0));
    /* `FRAMEINIT`（`evaldraw.txt:40`）：第一帧回 1、之后回 0 —— 脚本拿它当"这一帧
       要不要重新初始化"。`refresh`/`nextframe` 那一格推帧号，所以这儿只读。 */
    case 'frameinit/0': need(320, 240); return D.fno <= 1 ? 1 : 0;
    /* `getpix(x,y)`：读一格像素（`gethlin` 那一族靠它）。出界回 0。 */
    case 'getpix/2': {
      need(320, 240);
      const gx = Math.trunc(a(0));
      const gy = Math.trunc(a(1));
      if (gx < 0 || gy < 0 || gx >= D.w || gy >= D.h) return 0;
      const c = D.fb[gy * D.w + gx];
      /* GL 那一档里 -1 是"这一格宿主没画"（GPU 那一层要等交帧才读回来）——
         读那一格回背景 0，不为一次 `getpix` 去读一整帧。 */
      return c < 0 ? 0 : c;
    }
    case 'xres/0': need(320, 240); return D.w;
    case 'yres/0': need(320, 240); return D.h;
    /* ── 输入那一族（读四格、写两格）。写的两格照说明书：`bstatus` 与 `keystatus[k]`
       脚本改得动（"消掉一次点击"），`xres`/`mousx` 那几格只读 —— 赋值在 adapter 那层就报。 */
    case 'mousx/0': needInput(); return D.mx;
    case 'mousy/0': needInput(); return D.my;
    case 'bstatus/0': needInput(); return D.bst;
    case 'setbstatus/1': needInput(); D.bst = Math.trunc(a(0)); return 0;
    case 'keystatus/1': {
      needInput();
      const k = Math.trunc(a(0));
      return k >= 0 && k < 256 ? D.keys[k] : 0;
    }
    case 'setkeystatus/2': {
      needInput();
      const k = Math.trunc(a(0));
      if (k >= 0 && k < 256) D.keys[k] = a(1);
      return 0;
    }
    /* ── 收下但这一档做不到的那几格（**不静默画错**：语义是"这一档没有这件事"）────
       深度那一族（`clz` 清 z 缓冲、`gldepth` 开关）：这一档没有 z 缓冲 —— 3D 只对
       "没有互相遮挡"的图成立，真 3D 要 GPU 那两档。
       `framebegin`：每帧初态。GL 的状态机在语言那一侧（`gl-rt.js` 的 `gl_framebegin`），
       设备这一侧要做的只有"把画布清掉" —— 着色器那一族的脚本走的是这一格。
       剩下几格（点大小 / 剔除 / alpha 测试 / 垂直同步 / 线宽 / sleep）在这一档没有意思，
       收下记着不用 —— 与 `gl-rt.js` 里那几格 `gl_nop*` 同一句话。 */
    case 'framebegin/0': {
      need(320, 240);
      if (G.on) { G.m.cls(0); glClearHost(); D.dirty = true; return 0; }
      const n = D.w * D.h;
      for (let i = 0; i < n; i++) D.fb[i] = 0;
      D.dirty = true;
      return 0;
    }
    /* ── **可编程管线与纹理那一族**：GL 那一档转给那份扩展（§16），CPU 备选照旧往下走。
       句柄那两格（uniform / attrib）回的是设备给的数，脚本原样拿着再递回来。
       这几格可能是这一趟的第一句图形调用（`glsetshader` 在清屏之前），所以先 `need`。 */
    case 'glsetshader/1': case 'glsetshader/2': case 'glsetshader/3': {
      need(320, 240);
      if (!G.on) break;
      const av = [];
      for (let i = 0; i < args.length; i++) av.push(a(i));
      if (G.m.shader(av) !== 0) throw new Error(`本机 OpenGL：${G.m.error()}`);
      return 0;
    }
    case 'glgetuniformloc/1':
      need(320, 240);
      if (!G.on) break;
      return G.m.uniloc(a(0));
    case 'glgetattribloc/1':
      need(320, 240);
      if (!G.on) break;
      return G.m.attrloc(a(0));
    case 'gluniform1f/2': case 'gluniform2f/3': case 'gluniform3f/4': case 'gluniform4f/5':
    case 'gluniform/2': {
      need(320, 240);
      if (!G.on) break;
      const v = [];
      for (let i = 1; i < args.length; i++) v.push(a(i));
      while (v.length < 4) v.push(0);
      return G.m.uni(a(0), args.length - 1, v);
    }
    /* `gluniform1i(句柄, 整数)`：整数那一档（采样器与开关位走它 —— `ken/drawsph.pss`）。 */
    case 'gluniform1i/2':
      need(320, 240);
      if (!G.on) break;
      return G.m.uni1i(a(0), a(1));
    case 'glvertexattrib1f/2': case 'glvertexattrib2f/3':
    case 'glvertexattrib3f/4': case 'glvertexattrib4f/5': {
      need(320, 240);
      if (!G.on) break;
      /* 少给的那几格照 GL 的默认补（x,y,z 是 0、w 是 1）。 */
      const v = [a(1), args.length >= 3 ? a(2) : 0, args.length >= 4 ? a(3) : 0,
        args.length >= 5 ? a(4) : 1];
      return G.m.attr(a(0), v);
    }
    case 'glbindtexture/1':
      need(320, 240);
      if (!G.on) break;
      G.m.bindtex(Math.trunc(a(0)));
      return 0;
    /* **文件纹理**（`glsettexfile 槽 名字下标 colmode`，§20）：路径在这一层拼
       （目录只有宿主知道），解码与上传在设备。 */
    case 'glsettexfile/3': {
      need(320, 240);
      if (!G.on) break;
      const p = texPath(Math.trunc(a(1)));
      if (p === null) return 1;
      const rc = G.m.texfile(Math.trunc(a(0)), p, Math.trunc(a(2)));
      /* **读不到就要说话**：静默失败等于"图不对但没人知道"（那正是这一层最贵的错）。 */
      if (rc !== 0) stderr(`#gfx 文件纹理没上去：${p}（${G.m.error()}）\n`);
      return rc;
    }
    case 'glactivetexture/1': {
      need(320, 240);
      if (!G.on) break;
      /* 实参是 `GL_TEXTURE0 + i`（0x84c0）或者直接是 i —— 两种写法都有。 */
      const u = Math.trunc(a(0));
      G.m.activetex(u >= 0x84c0 ? u - 0x84c0 : u);
      return 0;
    }
    case 'clz/1': return 0;
    /* ── **收下但这一档画不出来的那几族**（2026-09-24 第七刀）────────────────────
       纹理与贴图（`glsettex`/`glbindtexture`/`glactivetexture`/`glcapture`/`drawspr`/
       体素那几格）、画布文字（`setfont`/`printg`/`printchar`）：这一档是个平面的帧缓冲，
       没有纹理采样也没有字模 ⇒ **收下记着不用**。
       为什么不报：这些脚本的主体是几何（3D 的球/锥/线），贴图与文字只是点缀 ——
       报了整份图都出不来，收下则"图能出、少了贴图与文字"。这一条偏差明写在
       `docs/design/eval-realtime-gpu.md` 第 12 节，真要贴图与文字得走 GPU 那两档设备。 */
    /* **抓屏那一族**（`glcapture` / `glcaptureend`，§22）：GL 那一档真做（换视口 +
       一次 `glCopyTexImage2D`），CPU 备选收下不管（这一层没有纹理采样）。
       语言那一侧发的是一参那两格（边长 / 槽）—— 矩阵那一半在它那儿。 */
    case 'glcapture/1': {
      need(320, 240);
      if (!G.on) return 0;
      return G.m.capbegin(Math.trunc(a(0)));
    }
    case 'glcaptureend/1': {
      need(320, 240);
      if (!G.on) return 0;
      return G.m.capend(Math.trunc(a(0)));
    }
    case 'pic/1': case 'pic/2': case 'pic/3': case 'pic/4': case 'pic/5': case 'pic/6':
    case 'glsettex/1': case 'glsettex/2': case 'glsettex/3': case 'glsettex/4':
    case 'glsettex/5': case 'glsettex/6':
    case 'glgettex/4': case 'glgettex/5':
    case 'glbindtexture/1': case 'glactivetexture/1':
    case 'glcapture/0': case 'glcapture/4': case 'glcaptureend/0':
    case 'mountzip/1': case 'mountzip/2': case 'glulookat/9':
    case 'drawspr/4': case 'drawspr/5': case 'drawspr/6':
    case 'drawkv6/4': case 'drawkv6/5': case 'drawkv6/7': case 'drawkv6/8':
    case 'drawvox/4': case 'drawvox/5':
    case 'setfont/2': case 'setfont/3':
    case 'printg/1': case 'printg/2': case 'printg/3': case 'printg/4': case 'printg/5':
    case 'printchar/1': case 'printchar/2': case 'printchar/3':
    case 'printchar/4': case 'printchar/5': case 'printchar/6':
    case 'setview/4': case 'setview/7':
    case 'glnormal/3': case 'gltexcoord/2': case 'gltexcoord/3': case 'gltexcoord/4':
      return 0;

    /* ── **批上带的那点状态**（第四刀）。这一档没有可编程管线，所以 `batchprog` 非零是
       **当场报**（不静默按内建那对画 —— 那就成了"图不对但没人知道"）；那张 `u_mvp`
       与混合开关在这一档没有落点，收下记着不用。 */
    case 'batchprog/1':
      if (G.on) { G.m.prog(Math.trunc(a(0)) !== 0 ? 1 : 0); return 0; }
      if (Math.trunc(a(0)) !== 0) {
        throw new Error('这格设备（CPU 备选）没有可编程管线 —— 脚本挑了自己那格'
          + ' program（glsetshader），顶点是**物体坐标**，这一档接不了；'
          + ' 要 GPU 那两档设备（浏览器 WebGL2 / 本机 OpenGL）');
      }
      return 0;
    case 'batchmvp/5':
      if (G.on) G.m.mvp(Math.trunc(a(0)), a(1), a(2), a(3), a(4));
      return 0;
    /* 模型视图那一格（`u_mv`）—— 与 `batchmvp` 逐字同形，见 §18.4。 */
    case 'batchmv/5':
      if (G.on) G.m.mv(Math.trunc(a(0)), a(1), a(2), a(3), a(4));
      return 0;
    case 'batchblend/1':
      if (G.on) G.m.blend(Math.trunc(a(0)));
      return 0;
    case 'glpointsize/1': case 'glcullface/1': case 'gllinewidth/1':
    case 'glswapinterval/1': case 'glalphaenable/1': case 'glalphadisable/1':
    /* `glklockstart` / `glklockelaps`：GPU 那一侧的计时（`polydraw.c` 的 GLKLOCK*）——
       脚本拿它印自己的帧耗时。这一层收下：时间那一格由 `klock` 那一族统一给
       （render 模式是确定性时钟，见 `klockParts` 的头注）。 */
    case 'glklockstart/0': case 'glklockelapsed/0':
    /* `gltextdisable`：关掉画布文字那一层（`polydraw.c` 的 myext[]）—— 我们没有那一层。 */
    case 'gltextdisable/0':
    /* `glprogramenvparam(目标, 序号, x,y,z,w)` / `glprogramlocalparam(…)`：**ARB 汇编专用**
       （`polydraw.c:2110`/`:2111` 那两行就写着 "for arb asm"，一个走
       `glProgramEnvParameter4fARB`、一个走 `glProgramLocalParameter4fARB`）。
       core profile / WebGL 都没有 ARB 汇编那条路，参考实现也把这两格写成 no-op
       （`c_impl/.../pd_polyhost_tex.c:547`/`:613`）—— 收下不管。
       ARB 汇编那几段着色器由设备认出来退回内建那对，见 §19.2。 */
    case 'glprogramenvparam/5':
    case 'glprogramlocalparam/5':
    case 'sleep/1':
      return 0;
    default:
      throw new Error(`这格设备（CPU 备选）上没有 '${name}'（${args.length} 个实参）——`
        + ' 有的是 cls/setcol/setpix/moveto/lineto/drawsph/drawcone/rgb/refresh/'
        + 'nextframe/numframes/klock/xres/yres/mousx/mousy/bstatus/keystatus；'
        + ' **GL 立即模式与可编程管线（着色器）只有 GPU 那两档设备有**'
        + '（浏览器 WebGL2 / 本机 OpenGL）—— 见 docs/design/eval-realtime-gpu.md');
  }
}

/* ---------------------------------------------------------------- 装成宿主那格设备
 *
 * 产物（发射出来的 JS）拿不到这份模块，所以约定一格**全局**：`globalThis.__OMNI_GFX`，
 * 形状是 `{ call(名字, 实参数组) -> number, present() -> void, kind }`。
 * 谁评估产物谁负责装上它 —— node 这边 import 这份模块就装上了（`lower/drive.js`），
 * 浏览器那边由页面装 **WebGL2 那一档**（默认，见 design 文档第 2.2 节）。
 * 没人装设备的独立产物**当场报**，不静默不画。
 */

/** 表面的落点：`OMNI_GFX_OUT` 能换（与 `ext/js/lib/ege.js` 同一格开关）。 */
function outPath() {
  const p = env('OMNI_GFX_OUT');
  return p === undefined || p === null || p === '' ? D.out : p;
}

/**
 * CPU 备选那一档的"交出一帧"：写图 + stdout 上印一行指针。
 *
 * **默认写 PNG**（`.omni-cache/gfx/frame.png`）—— 双击能开、`magick`/`compare` 直接吃；
 * 落点后缀是 `.rgba` 才走裸表面那个备选出口（它没有编码那一层，逐字节判据最直接）。
 * 指针那一行把种类也带上：`#gfx png <路径> <宽> <高>` / `#gfx rgba …`。
 */
function present() {
  if (!D.on) return;
  /* GL 那一档：把 GPU 那一层读回来（一帧只读一次），宿主那一层（-1 = 没人画）盖上去 ——
     合成在 `rgbaBytes` 里按格做（那儿本来就要逐格取一次）。 */
  if (G.on) {
    if (G.gpu === null) {
      const n = D.w * D.h;
      const buf = [];
      for (let i = 0; i < n; i++) buf.push(0);
      G.gpu = buf;
    }
    G.m.readInto(G.gpu);
  }
  const p = outPath();
  const cut = p.lastIndexOf('/');
  if (cut > 0) mkdirAll(p.slice(0, cut));
  const kind = surfaceKind(p);
  writeBinary(p, kind === 'rgba' ? gfxSurfaceBytes() : pngFromRgba(rgbaBytes(), D.w, D.h));
  stdout(`#gfx ${kind} ${p} ${D.w} ${D.h}\n`);
  D.dirty = false;
}

/* ── 顶点批（`(gfxbatch 类 数 顶点)`）：这一档的落点 ───────────────────────────
 *
 * 只有一个模型（`docs/design/eval-realtime-gpu.md` 第 9 节）：变换 / 拆 mode / 2D 图元
 * 变顶点 / 合批全在**语言那一侧**，交到设备手里的就是一段顶点。GPU 那两档是"上传 +
 * 一次 draw"，这一档软件光栅化同一段。
 *
 * 一格顶点 16 个数：位置 x,y,z,w（**裁剪空间**）、颜色 r,g,b,a（0..1）、纹理坐标 s,t,p,q、
 * 法向 nx,ny,nz,0（这一档还没有纹理与光照，那两摊收下不用）。
 * 类：0 = 线段（两个一组）、1 = 三角（三个一组）。
 * **与 `runtime/omni_fmt.c` 的 `omni_gfx_batch` 逐句相同** —— 三条腿逐字节相同是判据。
 */
const VSTRIDE = 16;

const vxy = (v, i) => {
  const w = v[i + 3] === 0 ? 1 : v[i + 3];
  return [(v[i] / w * 0.5 + 0.5) * D.w, (0.5 - v[i + 1] / w * 0.5) * D.h];
};

const vcol = (v, i) => rgb(v[i + 4] * 255, v[i + 5] * 255, v[i + 6] * 255);

/** 一格三角：包围盒 + 边函数，颜色按重心插值（与 C 那一份同一手）。 */
function tri(v, ia, ib, ic) {
  const [ax, ay] = vxy(v, ia);
  const [bx, by] = vxy(v, ib);
  const [cx, cy] = vxy(v, ic);
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  let x0 = Math.floor(Math.min(ax, bx, cx));
  let x1 = Math.ceil(Math.max(ax, bx, cx));
  let y0 = Math.floor(Math.min(ay, by, cy));
  let y1 = Math.ceil(Math.max(ay, by, cy));
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > D.w) x1 = D.w;
  if (y1 > D.h) y1 = D.h;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px2 = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px2 - ax)) / area;
      const w1 = ((px2 - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
      if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
      const u = 1 - w0 - w1;
      const r = (u * v[ia + 4] + w1 * v[ib + 4] + w0 * v[ic + 4]) * 255;
      const g = (u * v[ia + 5] + w1 * v[ib + 5] + w0 * v[ic + 5]) * 255;
      const b = (u * v[ia + 6] + w1 * v[ib + 6] + w0 * v[ic + 6]) * 255;
      px(x, y, rgb(r, g, b));
    }
  }
}

/**
 * **`OMNI_GFX_TRACE=n`：把前 n 段批的顶点印到 stderr**（与参考那侧的 `PD_TRACE` 同一个
 * 用途 —— 对账要比的是**裁剪坐标**，不是像素；像素差只说明"哪儿不一样"，裁剪坐标说明
 * "谁算错了"）。一行一个顶点：`#trace 类 批号 顶点号 x y z w r g b a`。
 * 三档设备都从这一格过，所以 `--gfx gl` 也照印。
 */
let TRACED = 0;
let TRACE_LIM = -1;
function traceV(kind, n, verts) {
  /* 上限也只问一次环境（同 `recOn` 那条注：这一句从前在**每一段批**上都读一次环境）。 */
  if (TRACE_LIM < 0) TRACE_LIM = intEnv('OMNI_GFX_TRACE', 0);
  if (!(TRACED < TRACE_LIM)) return;
  const id = TRACED;
  TRACED++;
  for (let i = 0; i < n; i++) {
    const o = i * VSTRIDE;
    process.stderr.write(`#trace ${kind} ${id} ${i} ${verts[o]} ${verts[o + 1]} `
      + `${verts[o + 2]} ${verts[o + 3]} ${verts[o + 4]} ${verts[o + 5]} `
      + `${verts[o + 6]} ${verts[o + 7]}\n`);
  }
}

function batch(kind, n, verts) {
  if (recOn()) { REC.set('gfxbatch', (REC.get('gfxbatch') ?? 0) + 1); return n; }
  const have = verts === undefined || verts === null ? 0 : verts.length;
  if (have < n * VSTRIDE) {
    throw new Error(`gfxbatch: 顶点不够（${have} 格，要 ${n * VSTRIDE}）`);
  }
  need(320, 240);
  traceV(kind, n, verts);
  /* GL 那一档：一段批直接上传 + 一次 draw（软件光栅化那一摊一格都不走）。 */
  if (G.on) { G.m.batch(kind, n, verts); D.dirty = true; return n; }
  if (kind === 0) {
    for (let i = 0; i + 1 < n; i += 2) {
      const ia = i * VSTRIDE;
      const [ax, ay] = vxy(verts, ia);
      const [bx, by] = vxy(verts, ia + VSTRIDE);
      line(ax, ay, bx, by, vcol(verts, ia));
    }
    return n;
  }
  if (kind === 1) {
    for (let i = 0; i + 2 < n; i += 3) {
      const ia = i * VSTRIDE;
      tri(verts, ia, ia + VSTRIDE, ia + 2 * VSTRIDE);
    }
    return n;
  }
  if (kind === 2) {
    /* 点那一档：一格顶点一个像素（"一个点多大"是设备的事 —— 语言那一侧不知道像素）。 */
    for (let i = 0; i < n; i++) {
      const ia = i * VSTRIDE;
      const [ax, ay] = vxy(verts, ia);
      px(ax, ay, vcol(verts, ia));
    }
    return n;
  }
  throw new Error(`gfxbatch: 不认识的类 ${kind}（0 = 线段、1 = 三角、2 = 点）`);
}

/* ── 纹理（`(gfxtex 槽 宽 高 层 格 数组)`）：这一档的落点 ─────────────────────────
 *
 * 这一档没有可编程管线（采样在 `batchprog` 那格就当场报了），所以这儿**只记下这一槽
 * 的形状**（宽/高/层/格 + 给了多少个数）—— 像素一个都不抄：抄下来也没人采样，
 * 那是白花一份内存。GPU 那两档才真上传（`docs/design/eval-realtime-gpu.md` 第 11 节）。
 * **与 `runtime/omni_fmt.c` 的 `omni_gfx_tex` 逐句相同** —— 三条腿逐字节相同是判据。
 */
const TEXMAX = 64;
const TEX = new Map();

function gfxTex(slot, w, h, d, fmt, pxs) {
  if (recOn()) { REC.set('gfxtex', (REC.get('gfxtex') ?? 0) + 1); return 0; }
  if (slot < 0 || slot >= TEXMAX) {
    throw new Error(`gfxtex: 槽 ${slot} 出界（0..${TEXMAX - 1}）`);
  }
  if (w <= 0 || h <= 0 || d <= 0) {
    throw new Error(`gfxtex: 尺寸要是正数（${w}×${h}×${d}）`);
  }
  /* 一格像素占几个 double 照原版 `evalvalperpix`：KGL_VEC4（5）是 4 个、别的都是 1 个。 */
  const per = (fmt & 15) === 5 ? 4 : 1;
  const want = w * h * d * per;
  const have = pxs === undefined || pxs === null ? 0 : pxs.length;
  if (have < want) throw new Error(`gfxtex: 像素不够（${have} 格，要 ${want}）`);
  /* GL 那一档：真上传（`glTexImage2D`）。这一层仍记下形状 —— 报错的话里要用。 */
  if (glWant()) need(320, 240);
  if (G.on) {
    if (G.m.tex(slot, w, h, d, fmt, pxs) !== 0) {
      throw new Error(`本机 OpenGL：${G.m.error()}`);
    }
  }
  TEX.set(slot, { w, h, d, fmt, n: want });
  return 0;
}

/**
 * `(gfxarr "名字" [a0 a1 a2 a3] 数组)`：**带一整块数组的宿主调用**（§19.1）。
 *
 * 只有两族：`gluniform{1..4}{f,i}v(句柄, 个数, 数组)` 与 `glgettex(槽, 宽, 高, 分量, 出数组)`
 * （后者是**往里写**的那一档）。两族都只有可编程管线才有 ⇒ CPU 备选收下不管，
 * GL 那一档转给设备。**与 `runtime/omni_fmt.c` 的 `omni_gfx_arr` 逐句相同**。
 */
function gfxArr(name, args, blk) {
  if (recOn()) { REC.set('gfxarr', (REC.get('gfxarr') ?? 0) + 1); return 0; }
  const nm = String(name);
  const a0 = Number(args[0]);
  const a1 = Number(args[1]);
  const a2 = Number(args[2]);
  const n = blk === undefined || blk === null ? 0 : blk.length;
  if (glWant()) need(320, 240);
  /* **一整张矩阵一句**（`batchmvp16` / `batchmv16`，列主序 16 个数）：与四句
     `batchmvp`/`batchmv` **逐字等价**，只是少 7 句宿主调用（见 `ext/polydraw/gl-rt.js`
     里那段话）。数组短于 16 格就当没发（不该发生，这一层不猜）。 */
  if (nm === 'batchmvp16' || nm === 'batchmv16') {
    if (!G.on || n < 16) return 0;
    const put = nm === 'batchmvp16' ? G.m.mvp : G.m.mv;
    for (let c = 0; c < 4; c++) put(c, blk[c * 4], blk[c * 4 + 1], blk[c * 4 + 2], blk[c * 4 + 3]);
    return 0;
  }
  /* `gluniform<N><f|i>v`：名字里第 10 个字符是分量数、第 11 个是 f/i。 */
  if (nm.startsWith('gluniform') && nm.length === 12 && nm[11] === 'v'
      && nm[9] >= '1' && nm[9] <= '4' && (nm[10] === 'f' || nm[10] === 'i')) {
    if (!G.on) return 0;
    const comps = nm.charCodeAt(9) - 48;
    let cnt = Math.trunc(a1);
    if (cnt < 0) cnt = 0;
    if (cnt * comps > n) cnt = Math.trunc(n / comps);
    return G.m.univ(a0, comps, nm[10] === 'i' ? 1 : 0, cnt, blk);
  }
  /* `glgettex(槽, &数组, 宽, 高, 格)`：**写回几格由设备说**（一像素几个 double 只有
     它知道 —— 那一槽自己的格）。这一层把数组本身递过去，设备写回，回 -1 = 没读到。 */
  if (nm === 'glgettex') {
    if (!G.on) return 0;
    return G.m.gettex(Math.trunc(a0), Math.trunc(a1), Math.trunc(a2), blk);
  }
  throw new Error(`gfxarr: 不认识 '${nm}'（有的是 gluniform{1..4}{f,i}v / glgettex）`);
}

/**
 * `(gfxdef 种类 名字 内容)`：往设备上登记一格有名字的串（着色器原文 / 名字表）。
 *
 * CPU 备选用不上，但**GL 那一档要** —— 而这几句在设备开起来之前就到了（产物开头那一摊
 * 登记语句），所以先存下来，`glNeed` 挂上之后一趟补过去（与 `omni_fmt.c` 里那一格同一手）。
 */
function gfxDef(kind, name, text) {
  /* 名字表那一族在这一层也留一份（文件纹理要用，见 `texPath`）。 */
  if (String(kind) === 'name') G.names[Number(name)] = String(text);
  if (G.on) { G.m.def(String(kind), String(name), String(text)); return 0; }
  G.defs.push([String(kind), String(name), String(text)]);
  return 0;
}

/**
 * 文件纹理那一格的路径：**名字表下标 -> 脚本那一格目录底下的那个文件**。
 *
 * `glsettex(0,"earth.jpg")` 里写的是相对路径，而原版是在脚本旁边跑的（`kzopen` 按 cwd）——
 * 判据从仓库根跑，所以这儿按 `OMNI_GFX_DIR`（cli 在 `--gfx` 那一摊里摆上的脚本目录）拼。
 * 绝对路径原样用；反斜杠（语料里有 `..\hei\brick_green.png` 这种）换成正斜杠。
 */
function texPath(idx) {
  const nm = G.names[idx];
  if (nm === undefined || nm === null) return null;
  let s = String(nm);
  let out = '';
  for (let i = 0; i < s.length; i++) out += s[i] === '\\' ? '/' : s[i];
  if (out.startsWith('/')) return out;
  const d = env('OMNI_GFX_DIR');
  return d === undefined || d === null || d === '' ? out : `${d}/${out}`;
}

export const GFX_CPU = {
  call: gfxCall, batch, tex: gfxTex, arr: gfxArr, def: gfxDef, present,
  /* `kind` 是给判据看的一格记号：GL 那一档挂上之后 `glNeed` 把它改成 `native-gl`
     （不然判据分不出"真走了 GPU"与"悄悄回落了 CPU 备选" —— 那是自己判自己）。
     **是可变字段而不是 getter**：这一份要过 `check:self` 那道门，取值器不在那个子集里。 */
  kind: 'cpu',
};
