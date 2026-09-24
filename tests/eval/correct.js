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
const REF = `${PSS}/c_impl/build/polydraw-render`;
const DEC = `${PSS}/c_impl/build/pd-imgdecode`;

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
  only: val('--only', ''),
  budget: Number(val('--budget', '100')) * 1000,
};

/**
 * **已裁定"参考错"的那几份**（依据只有 `polydraw_src` 的语义 + 最小复现）。
 * c_impl 自己只有 ~80% 正确，所以这种分歧必须裁定一次再记进来 —— 不记的话判据会
 * 永远红在别人的 bug 上；乱记又会把我们自己的 bug 藏起来。**每一条都要写清怎么定的。**
 */
const REF_WRONG = new Map([
  ['02_primitives_noshader.pss',
    '脚本 `for (i = 0; i < 6; i++)` 明写 6 个方块：我们画 6 个、参考只有 3 个'
    + '（连通块数出来的，不是看着像）'],
  ['02-gl.pss',
    '参考**压根没画那个青方块**（按颜色数：我们 1976 格、参考 0 格），别的三样'
    + '（渐变三角 / 黄线圈 / 白点列 40 格）两边逐格相同；'
    + '最小复现 translate+glRotate(30,0,0,1)+GL_QUADS 两边一致 ⇒ 参考是在多段之后丢了图元'],
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
function ours(src, out) {
  const r = spawnSync(process.execPath,
    [CLI, 'run', src, '--gfx', 'gl', '--frame', CFG.frame,
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

/** 参考那一趟：PNG -> PPM -> 像素（RGB）。**fovy 按分辨率算**（见文件头）。 */
function ref(src, png, ppm) {
  const r = spawnSync(REF, [src, '--frame', CFG.frame, '--w', String(CFG.w),
    '--h', String(CFG.h), '--fovy', fovyOf(CFG.w, CFG.h).toFixed(4), '-o', png],
  { encoding: 'utf8', timeout: 120000 });
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
if (!existsSync(REF) || !existsSync(DEC)) {
  P(`  --   这台机器上没有那份参考（${REF}）—— 整份跳过\n`);
  P('\n0 passed, 0 failed（出图正确性）\n');
  process.exit(0);
}

for (const src of cases()) {
  if (Date.now() - t0 > CFG.budget) { skip++; continue; }
  const name = basename(src);
  const tag = name.replace(/[^\w.-]/g, '_');
  const o = ours(src, join(OUT, `${tag}.ours.rgba`));
  const r = ref(src, join(OUT, `${tag}.ref.png`), join(OUT, `${tag}.ref.ppm`));
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
  /* 三档判定：**黑图**（参考有东西、我们几乎全黑）、**大差异**（RMSE 过线）、其余算过。 */
  if (d.nzb > CFG.w * CFG.h * 0.01 && d.nza < d.nzb * 0.1) {
    fail++;
    rows.push({ name, cls: '黑图', ...d });
    P(`  FAIL ${name} 不是黑图\n       我们非黑 ${d.nza}、参考 ${d.nzb}\n`);
  } else if (d.rmse > CFG.rmse) {
    fail++;
    rows.push({ name, cls: '差异大', ...d });
    P(`  FAIL ${name} RMSE ≤ ${CFG.rmse}\n       RMSE ${d.rmse.toFixed(2)}`
      + `（非黑 ${d.nza} vs ${d.nzb}、有差 ${d.cnt} 格、最大差 ${d.mx}）\n`);
  } else {
    pass++;
    rows.push({ name, cls: d.rmse === 0 ? '逐像素相同' : '够近', ...d });
    P(`  ok   ${name} ${d.rmse === 0 ? '逐像素相同' : `RMSE ${d.rmse.toFixed(2)}`}\n`);
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


