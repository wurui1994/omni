// tests/eval/mkref.js —— **把参考补上那一格再建一份**（出图正确性判据的尺子）
//
// 为什么要补：`c_impl` 只有 ~80% 正确，而其中有一处错的是**一整类** ——
// `src/render/gl_renderer.c` 里 `mat4_rotate` 那张 `t[16]` 的字面量**按行写、数组按列用**，
// 于是它的 `glrotate` 建出来的是真 GL 那张 `R` 的**转置**（等于按 `-角度` 转）。
// 它的 `mat4_mul` / `mat4_translate` / 投影都与我们逐句相同，**只有这一格**。
//
// 正本是真 OpenGL：原版 `glrotate` 就是 `glRotated`（`polydraw.c:2141` 的 `qglRotated`）。
// 本机拿 CGL 问过固定管线：`glRotated(45,0,1,0); glTranslated(0,0,-10)` 之后
// `(2,2,0)` 落在 `(-5.6569, 2, -8.4853)` —— 与补过的这一份逐位相同。
//
// 这种"尺子自己错成一整类"的事**不能**靠逐个 `REF_WRONG` 记，也不能放宽阈值
// （那等于自己判自己）—— 补一份 fork 当尺子才量得动"转角那一族"。
// 补过之后 `town textured` 从全黑变成铺满 80.5% 的城市。
//
//     node tests/eval/mkref.js          # 建到 .omni-cache/pdref/c_impl/build
//     node tests/eval/correct.js        # 判据自己会用那一份（有就用）
//
// **不改用户那棵 `c_impl`**：整棵抄到缓存里再补。抄的是源码，`make -j8` 约 40s。
// 缓存被清过就再跑一趟（判据找不到那一份会印一行提示，然后退回原版那把尺子）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PSS = process.env.OMNI_PSS_DIR ?? '/Users/wurui/Documents/polydraw';
const SRC = join(PSS, 'c_impl');
const DST = join(ROOT, '.omni-cache', 'pdref', 'c_impl');

/** 那一格的原样与补法 —— **原样对不上就当场停**（他们改过源码就该重新裁一次）。 */
const OLD = `    double t[16] = {
        c + x * x * k,      x * y * k - z * s, x * z * k + y * s, 0,
        y * x * k + z * s,  c + y * y * k,     y * z * k - x * s, 0,
        z * x * k - y * s,  z * y * k + x * s, c + z * z * k,     0,
        0, 0, 0, 1
    };`;
const NEW = `    /* 补过（Omni 判据）：上面那张字面量按**行**写、数组按**列**用 —— 建出来是 R 的转置
       （= 按 -角度 转）。真 GL 的 glRotated 建的是 R（本机 CGL 探针验过），原版
       polydraw 的 glrotate 就是 glRotated（polydraw.c:2141）。 */
    double t[16] = {
        c + x * x * k,      y * x * k + z * s, z * x * k - y * s, 0,
        x * y * k - z * s,  c + y * y * k,     z * y * k + x * s, 0,
        x * z * k + y * s,  y * z * k - x * s, c + z * z * k,     0,
        0, 0, 0, 1
    };`;

/**
 * **第二格：`setfov`。** 参考把实参当 `gluPerspective` 的 fovy 直接用、而且当场换投影；
 * 原版的 `ksetfov`（`polydraw.c:1484`）是
 *
 *     gfov = tan(fov*PI/360) * atan(yres/xres) * 360/PI
 *
 * 而且它**只写下 `gfov`** —— 投影是每帧开头那句 `gluPerspective(gfov,…)`
 * （`polydraw.c:3578`，在跑脚本**之前**）才重算，所以脚本里调 `setfov()`
 * **要到下一帧才生效**。第 0 帧那一帧用的还是开机那句 `ksetfov(90)`。
 * 量出来的差：`setfov(62.79)` 在 320×320 上参考给 `tan(f/2)=0.6103`（= 原样 62.79），
 * 原版第 0 帧是 `1.0`（90°）、第 1 帧起是 `0.5197`（54.94°）——
 * `menger sponge` 于是整个大 1.57 倍（包围盒 57..262 对我们 94..225）。
 * 参考这边改法：只记下 `ksetfov` 变换后的值，投影交给下一帧开头那句（1202 行）。
 */
const OLDFOV = `        case GLCMD_SETFOV:
            rd->fovy = c->a;
            mat4_perspective(rd->proj, rd->fovy, (double)rd->w / rd->h, 0.1, 1000.0);
            update_mvp(rd);
            break;`;
const NEWFOV = `        case GLCMD_SETFOV:
            /* 补过（Omni 判据）：照 polydraw.c 的 ksetfov —— 只记下变换后的 gfov，
               投影由**下一帧开头**那句（本函数上头 mat4_perspective 那行）重算。 */
            rd->fovy = tan(c->a * M_PI / 360.0)
                     * atan((double)rd->h / (double)rd->w) * 360.0 / M_PI;
            break;`;

if (!existsSync(SRC)) {
  process.stdout.write(`这台机器上没有 ${SRC} —— 没东西可补\n`);
  process.exit(1);
}
rmSync(DST, { recursive: true, force: true });
mkdirSync(dirname(DST), { recursive: true });
const cp = spawnSync('cp', ['-R', SRC, DST], { encoding: 'utf8' });
if (cp.status !== 0) {
  process.stdout.write(`抄不过来：${cp.stderr}\n`);
  process.exit(1);
}
rmSync(join(DST, 'build'), { recursive: true, force: true });

const f = join(DST, 'src/render/gl_renderer.c');
const s = readFileSync(f, 'utf8');
if (!s.includes(OLD) || !s.includes(OLDFOV)) {
  process.stdout.write('`mat4_rotate` / `GLCMD_SETFOV` 那两处与记着的原样对不上 ——'
    + ' 参考那边改过源码了，得重新裁一次（别盲目补）\n');
  process.exit(1);
}
writeFileSync(f, s.replace(OLD, NEW).replace(OLDFOV, NEWFOV));
process.stdout.write(`补好了 ${f}（两处：mat4_rotate / GLCMD_SETFOV）\n开始 make（约 40s）…\n`);

const mk = spawnSync('make', ['-j8'], { cwd: DST, encoding: 'utf8' });
const bin = join(DST, 'build/polydraw-render');
if (mk.status !== 0 || !existsSync(bin)) {
  process.stdout.write(`${(mk.stderr ?? '').split('\n').slice(-20).join('\n')}\n建不出来\n`);
  process.exit(1);
}
process.stdout.write(`好了：${bin}\n判据会自己用这一份（也可以 OMNI_PD_REF=… 指别处）\n`);
