#!/usr/bin/env node
// Omni — asymptote 的**第十六条测试轴**：画出来的东西与真 asy 一样吗（ADR-0014 第八十刀）
//
// 前十五条轴管的是"读得进"（tests/glr）与"跑得对"（tests/asy/run.js 的五方一致）。
// 这一条管的是**主线的验收**：examples 里的每一个例子，我们出的 EPS 与
// `asy -noV -f eps` 出的那份画的是同一张图。
//
// 参考（oracle）落在 `.omni-cache/epsref/<名>.eps`，**一次生成、之后只读** ——
// 它只由例子本身决定。从前这一份放在 /tmp 里，`/tmp` 被系统清掉之后 192 份全没了，
// 所以现在放在仓库的缓存目录里（.gitignore 已经挡了 /.omni-cache/）。
//
// 判据不是逐字节：两边的注释头、字体前言、日期都不同。比的是**画的东西** ——
// 去掉注释与空白、切成"数 + 运算符"的流，运算符逐个相等、数按 1e-3 比。
// BoundingBox 那两行例外：它是画布的尺寸，参与比较。
//
// 用法：
//   node tests/asy/eps.js <examples 目录> [名字…]
//   OMNI_EPS_WHY=1   顺带把"没出图"的那些按**第一条错**归类排一遍（改哪儿最值钱看这个）
//   OMNI_EPS_GEN=1   缺参考的那些现场用真 asy 补一份（很慢，量过 5 分多钟，平时别开）
//   OMNI_EPS_FRESH=1 不认结果缓存，全部重跑
//
// **可续跑**：每个例子的结论逐个落在 `.omni-cache/epsres/<名>.json` 里，键是
// 「编译器的印记 + 这个例子的改动时间/字节数」。被 Ctrl-C 打断不丢已经跑完的那些，
// 下一趟只跑"没跑过的"与"编译器变了之后没重跑的"。一趟全量要好几分钟，而这一轴
// 会被反复问，所以这一格是必须的。
import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REF = join(ROOT, '.omni-cache', 'epsref');
const RES = join(ROOT, '.omni-cache', 'epsres');
const WORK = join(ROOT, '.omni-cache', 'epsrun');
const ASY = '/opt/homebrew/bin/asy';
const ASYBASE = '/opt/homebrew/share/asymptote';
const TOL = 1e-3;
// 一个例子最多跑多久（毫秒）的**下限**。默认 3s —— 全量 194 个，卡住几个整轴就没法反复问了。
// 真正用的预算是 `budgetFor(名字)`：`max(这个下限, 2×上一趟耗时 + 2s)`，也就是"快的例子照旧
// 被 3s 卡着、已知慢的（三维那一族 5~30s）给够"。从前只有这一个全局值，于是整族三维例子
// 被记成 `slow` 并覆盖上一次的真结论 —— 那不是"通过"，是"没量过"（见 budgetFor 的注）。
// 显式给 `OMNI_EPS_T=60000` 仍然一切照旧（下限抬高）。
const LIMIT = Number(process.env.OMNI_EPS_T === undefined ? 3000 : process.env.OMNI_EPS_T);

// **摇骰子的那几个，永远比不出来**：真 asy 的随机数（random.cc:10）用
// `std::random_device` 播种 `std::mt19937_64`，连它自己两趟都不一样 —— 量过：
// 同一份 polardatagraph.asy 连跑两趟，%%BoundingBox 就从 259 345 352 446 变成
// 256 345 355 446。这六个不是我们做错了，是这条对照本身不成立，所以不计分。
// 判据是量出来的（每个都连跑两趟真 asy 对比），不是看源码猜的。
const DICE = new Set([
  'delu', 'Gouraudcontour', 'imagehistogram',
  'pathintersectsurface', 'polardatagraph', 'randompath3', 'floatingdisk',
]);

const exDir = process.argv[2];
if (exDir === undefined) {
  console.error('用法：node tests/asy/eps.js <examples 目录> [名字…]');
  process.exit(2);
}
// 模块搜索路径：例子引的是真的 base/*.asy（与 sweep.js 同一条规矩），**再加上 examples
// 目录本身**。后半句不是给自己开后门，是把 oracle 那一侧的路径原样照过来 ——
// 量过（`asy -noV -v -v` 印的那一行）：
//   Loading lowupint from /opt/homebrew/.../share/doc/asymptote/examples/lowupint.asy
// 也就是真 asy 的默认搜索路径里**本来就有它自己装的 examples 目录**，所以
// lowint / upint / spring0 / spring2 那几份 `import lowupint;` 在 oracle 那边是找得到的。
// 我们这一层的路径只到 base，于是同一句就报"找不到" —— 差的是路径，不是实现。
// 顺带量清了另一件事：asy **不**把主文件所在的目录加进搜索路径（`cd /tmp/msub &&
// asy sub/user.asy` 里的 `import mm;` 找不到 sub/mm.asy，绝对路径也一样），
// 所以 cli.js 那条"按 CWD 找"的规矩是对的，不要去改它。
// **这一轴要用 oracle 自己那份 base，不是参考源码树里的那份。** 量出来的：
// `/opt/homebrew/share/asymptote` 与 `/Users/…/reference/asymptote/base` 有 5 个文件不一样
// （graph3 / graph_splinetype / plain_shipout / slide / three）—— 装着的 asy 比那份源码树新。
// 参考只能读、不能改，而 `.omni-cache/epsref` 里的图是 `asy -noV` 出的，吃的是**装着的**那份。
// 拿源码树那份跑我们这边，等于两侧库版本不同，比出来的差不是我们的：
//   spline.asy 的 `Hermite(monotonic)` —— 源码树 `d[n-1]=(…-h[n-2]*del[n-2])/…`，
//   装着的那份是 `del[n-3]`（MATLAB pchip 的正形），最后一段控制点于是
//   143.375779（oracle）对 156.540136（我们跑源码树）。换成同一份库，这一行就对上了。
// 这里只改这一轴（它是唯一与 oracle 逐字节对照的）；sweep/run 那两轴问的是"库能不能编过"，
// 两份都该编得过，先不动。
const base = existsSync(ASYBASE) ? ASYBASE : join(exDir, '..', 'base');
const env = {
  ...process.env,
  OMNI_ASY_MODS: '1',
  ASYMPTOTE_DIR: `${process.env.ASYMPTOTE_DIR === undefined || process.env.ASYMPTOTE_DIR === ''
    ? base : process.env.ASYMPTOTE_DIR}:${exDir}`,
};

/** 一串字符 -> 16 位十六进制（够当缓存键；这一格不做密码学用途） */
function h16(s) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    a = ((a ^ s.charCodeAt(i)) * 16777619) >>> 0;
    b = ((b + s.charCodeAt(i) * (i + 1)) * 2654435761) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/**
 * 编译器自己那一份的印记：src/core 与 src/lib 底下每个文件的「名字 + 改动时间 + 字节数」。
 * 结果缓存的键里带它 —— 改了前端或后端，这一轴的结论全部作废。
 */
let stampMemo = '';
function srcStamp() {
  if (stampMemo !== '') return stampMemo;
  const parts = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        parts.push(`${p}:${st.mtimeMs}:${st.size}`);
      }
    }
  };
  walk(join(ROOT, 'src', 'core'));
  walk(join(ROOT, 'src', 'lib'));
  // 运行时（C）也要算进去 —— 三维那张位图是 src/runtime/omni_r3.c 画的，
  // 不算它的话改了光栅化还在报上一趟的缓存数（踩过一次：改完采样点位，
  // 六个例子里五个都是缓存里的旧数）。
  walk(join(ROOT, 'src', 'runtime'));
  stampMemo = h16(parts.join('|'));
  return stampMemo;
}

/**
 * 位图那一档的口径（这一刀）：EPS 里 `/ImageType 1 … image <ASCII85>~>` 那几块**不比字节流，
 * 比解出来的像素**。
 *
 * 为什么必须换：参考那一侧多一层 `/FlateDecode`（asy 压过），我们只发 `/ASCII85Decode` ——
 * 那一段字节两边**必然不同**，按 token 比等于把"图对不对"永远判成"结构不同"。而解出来
 * 之后是能逐字节对账的（量过：laserlattice 四块 256x256 的图与参考逐字节相同）。
 *
 * 回两样：把数据段与**编码那两行**（`/DataSource …` 与 `/FlateDecode`）摘掉之后的正文
 * （于是 Width/Height/BitsPerComponent/Decode/ImageMatrix 与 concat 矩阵照旧参与比较 ——
 * 那些是真的几何），以及每一块图解出来的像素。
 */
function pullImages(text) {
  const imgs = [];
  const out = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.trim() !== 'image') { out.push(ln); i++; continue; }
    // `image` 之后是数据段。滤镜有两种：参考走 ASCII85（结束记号 `~>`），
    // 我们三维那条路走 ASCIIHex（结束记号 `>`）—— 十六进制是让 shell 转的，
    // 这一层一个字节都不碰（见 ADR「位图那 83 个」第八节）。
    out.push(ln);
    i++;
    // 往上找最近那几行的滤镜与 Flate
    let hex = false;
    let flate = false;
    for (let k = out.length - 1; k >= 0 && k > out.length - 12; k--) {
      if (out[k].indexOf('ASCIIHexDecode') >= 0) hex = true;
      if (out[k].indexOf('FlateDecode') >= 0) flate = true;
    }
    const eod = hex ? '>' : '~>';
    const data = [];
    while (i < lines.length && lines[i].indexOf(eod) < 0) { data.push(lines[i]); i++; }
    if (i < lines.length) { data.push(lines[i].slice(0, lines[i].indexOf(eod))); i++; }
    let raw = hex ? Buffer.from(data.join('').replace(/[^0-9a-fA-F]/g, ''), 'hex')
      : a85(data.join(''));
    if (flate) { try { raw = inflateSync(raw); } catch { raw = Buffer.alloc(0); } }
    // 宽高从上面那几行的字典里取（`/Width 396` / `/Height 400`）—— 有了它才能把这一块
    // 当**图**看（ink 的包围盒、逐像素重合），而不只是一串字节。GPU 参考位图的判据
    // 是两层的：几何逐字节，像素按容差（见 ADR「位图那 83 个」）。
    let w = 0;
    let h = 0;
    for (let k = out.length - 1; k >= 0 && k > out.length - 20; k--) {
      const mw = out[k].match(/\/Width\s+(\d+)/);
      if (mw !== null && w === 0) w = Number(mw[1]);
      const mh = out[k].match(/\/Height\s+(\d+)/);
      if (mh !== null && h === 0) h = Number(mh[1]);
    }
    imgs.push({ raw, w, h });
    out.push('%IMGDATA');
  }
  const keep = [];
  for (const ln of out) {
    const t = ln.trim();
    // 编码那两行摘掉：滤镜是编码细节，像素在上面单独比。参考那边 Flate 那一行是
    // `/FlateDecode filter`（后面还跟着 filter），所以按前缀认，不是整行相等。
    if (t.startsWith('/DataSource') || t.startsWith('/FlateDecode')) continue;
    keep.push(ln);
  }
  return { text: keep.join('\n'), imgs };
}

/** ASCII85 解码（`z` 是四个零字节，末组按 'u' 补齐） */
function a85(s) {
  const out = [];
  let t = 0;
  let n = 0;
  for (const ch of s) {
    if (ch === '~') break;
    if (ch === 'z' && n === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0);
    if (c < 33 || c > 117) continue;
    t = t * 85 + (c - 33);
    n++;
    if (n === 5) {
      out.push(Math.floor(t / 16777216) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);
      t = 0;
      n = 0;
    }
  }
  if (n > 0) {
    for (let k = n; k < 5; k++) t = t * 85 + 84;
    const b = [Math.floor(t / 16777216) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255];
    for (let k = 0; k < n - 1; k++) out.push(b[k]);
  }
  return Buffer.from(out);
}

/**
 * 一块位图的"墨"：非白的像素。GPU 参考那一侧是 PBR 着色、我们这一侧是平色，
 * 所以**像素值**不可能逐字节对上；能对账的是"哪儿有东西"。
 */
function inkmask(g) {
  const n = g.w * g.h;
  const m = new Uint8Array(n);
  const px = g.raw.length >= n * 3 ? 3 : 1;
  for (let i = 0; i < n; i++) {
    let dark = false;
    for (let c = 0; c < px; c++) if (g.raw[i * px + c] < 250) dark = true;
    m[i] = dark ? 1 : 0;
  }
  return m;
}

/** 两侧的位图逐块比。回 null 表示一样，否则回那句话。 */
function cmpImages(a, b) {
  if (a.length !== b.length) return `位图块数 ${a.length} vs ${b.length}`;
  for (let k = 0; k < a.length; k++) {
    if (a[k].raw.length !== b[k].raw.length) {
      return `第 ${k} 块位图字节数 ${a[k].raw.length} vs ${b[k].raw.length}`;
    }
    let diff = 0;
    let mx = 0;
    let at = -1;
    for (let i = 0; i < a[k].raw.length; i++) {
      const d = Math.abs(a[k].raw[i] - b[k].raw[i]);
      if (d !== 0) { diff++; if (at < 0) at = i; }
      if (d > mx) mx = d;
    }
    if (diff !== 0) {
      // 容差那一层：ink 的逐像素重合。**"多少个字节不同"不是判据** ——
      // 量过（billboard）：图从"画错地方"改成"画对地方"时，字节差反而从
      // 45859 涨到 67378，因为我们开始在参考画的位置上填平色了。
      let tol = '';
      if (a[k].w > 0 && a[k].h > 0 && b[k].w === a[k].w && b[k].h === a[k].h) {
        const A = inkmask(a[k]);
        const B = inkmask(b[k]);
        let both = 0;
        let oa = 0;
        let ob = 0;
        for (let i = 0; i < A.length; i++) {
          if (A[i] === 1 && B[i] === 1) both++;
          else if (A[i] === 1) oa++;
          else if (B[i] === 1) ob++;
        }
        const pct = oa + both === 0 ? 100 : (both / (oa + both) * 100);
        tol = `；ink ${a[k].w}x${a[k].h} 重合 ${both}（只有参考 ${oa}、只有我们 ${ob}，`
          + `盖住参考的 ${pct.toFixed(1)}%）`;
      }
      return `第 ${k} 块位图 ${diff}/${a[k].raw.length} 个字节不同`
        + `（最大差 ${mx}，首处第 ${at} 个）${tol}`;
    }
  }
  return null;
}

/** 一份 EPS -> "数 + 运算符"的流。第三格只用来打诊断（原样那一串）。 */
function toks(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const ln = raw.trim();
    if (ln === '') continue;
    if (ln.startsWith('%%BoundingBox') || ln.startsWith('%%HiResBoundingBox')) {
      const ws = ln.split(/\s+/);
      for (const w of ws.slice(1)) out.push(['n', Number(w), `${ws[0]}${w}`]);
      continue;
    }
    if (ln.startsWith('%')) continue;      // 别的注释都不比（Creator / 日期 / 前言标记）
    for (const w of ln.split(/\s+/)) {
      if (w === '') continue;
      if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/.test(w)) out.push(['n', Number(w), w]);
      else out.push(['o', w, w]);
    }
  }
  return out;
}

function cmp(a, b) {
  const n = Math.min(a.length, b.length);
  let bad = 0;
  let first = null;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    let same;
    if (x[0] !== y[0]) same = false;
    else if (x[0] === 'n') same = Math.abs(x[1] - y[1]) <= TOL * Math.max(1, Math.abs(x[1]));
    else same = x[1] === y[1];
    if (!same) {
      bad++;
      if (first === null) first = `#${i} 参考 ${x[2]} vs 我们 ${y[2]}`;
    }
  }
  return { bad: bad + Math.abs(a.length - b.length), len: [a.length, b.length], first };
}

/**
 * oracle 那一份。已经有就直接用 —— 它只由例子决定，跑一次就够。
 *
 * **默认不生成**（`OMNI_EPS_GEN=1` 才生成）：生成那一趟要跑 192 次真 asy，量过 5 分多钟，
 * 而这一轴平时问的是"我们画得对不对"，参考早就躺在 `.omni-cache/epsref` 里了。
 * 回 null 表示这一份没有参考（没生成过，或者真 asy 自己也出不了图 —— NURBS/PRC/三维
 * 那一族要外部工具），那种不计分。
 */
function oracle(n, p) {
  const out = join(REF, `${n}.eps`);
  // **例子改过就得重生成**。这一格从前只看"文件在不在"，于是改过的例子拿旧参考比 ——
  // 量出来的：smoothelevation 在 00:35 生成参考、00:40 把网格从 20×20 缩到 6×6，
  // 之后这一轴一直报"位图 36% 不同、ink 只盖住参考 84.6%"，而同一份源码两侧现场各跑一趟
  // 是 ink 623062 对 623449、逐行最大差 6 —— 那 36% 全是参考过期，不是我们画错。
  // 同一次扫出 bars3 / filesurface / smoothelevation 三份是这种。
  // 所以：源码比参考新就当没有参考（有真 asy 就顺手补，**不看 OMNI_EPS_GEN** ——
  // 过期的参考会把结论悄悄弄反，比多跑一次 asy 贵得多）。
  const fresh = existsSync(out) && statSync(out).size > 0
    && statSync(out).mtimeMs >= statSync(p).mtimeMs;
  if (fresh) return out;
  const stale = existsSync(out);
  if (!existsSync(ASY)) return null;
  if (!stale && process.env.OMNI_EPS_GEN !== '1') return null;
  if (stale) console.log(`  （${n}：参考比例子旧，重新生成）`);
  mkdirSync(WORK, { recursive: true });
  // 例子的路径要**绝对**：这一趟的 cwd 是 WORK，而调用方给的 exDir 常是相对仓库根的
  // （`node tests/asy/eps.js tests/asy/examples …`），照原样传进去 asy 找不到文件。
  const r = spawnSync(ASY, ['-noV', '-f', 'eps', '-o', n, resolve(p)],
    { cwd: WORK, encoding: 'utf8', timeout: 60000 });
  const made = join(WORK, `${n}.eps`);
  if (r.status !== 0 || !existsSync(made) || statSync(made).size === 0) return null;
  renameSync(made, out);
  return out;
}

/** 我们那一份：`omni run <例子>`，图落到一份文件（与参考那一侧同一条口子）。 */
function mine(p, budget = LIMIT) {
  // cwd 仍是仓库根（产物缓存 `.omni-cache` 与 `ASYMPTOTE_DIR` 里的相对目录都按它算 ——
  // 试过挪到草稿目录，189 个例子全报 `no such file: tests/asy/examples/…`，退回来了）。
  // 例子自己 `shipout("名字")` 落下来的那几份（asy 的规矩，见 ADR-0014）跑完就地擦掉，
  // 别留在仓库里。
  const before = new Set(readdirSync(ROOT));
  // 走哪条腿：默认 `run`（JS 宿主）。三维那一档的光栅化器在 C 运行时里
  // （runtime/omni_r3.c，ADR-0014"三维那一档换路"那一节），所以要量三维就得
  // `OMNI_EPS_LEG=run-c`；JS 那三条腿上 `(r3render …)` 回空串、走 gs 那条旧路。
  const leg = process.env.OMNI_EPS_LEG === undefined || process.env.OMNI_EPS_LEG === ''
    ? 'run' : process.env.OMNI_EPS_LEG;
  // **图走文件、程序的 write 走 stdout** —— 参考那一侧本来就是这么分的（上面 `-f eps -o n`）。
  // 从前我们两样都从 stdout 出去，例子印的字于是混进图里：印在**前面**的靠 onlyEps 切掉，
  // 印在**后面**的切不掉。量出来的：genusthree / genustwo 用 smoothcontour3，它逐块调
  // plain_strings.asy:252 的 `progress()` 转圈（`' '` 与 `'\b'+spinner[…]`），那几个字节
  // 退出时才 flush，落在 `%%EOF` 后面 —— 判据于是记成"多一个 token、结构不同"。
  mkdirSync(WORK, { recursive: true });
  const pic = join(WORK, 'mine.eps');
  rmSync(pic, { force: true });
  const t0 = Date.now();
  const r = spawnSync('node', [join(ROOT, 'src', 'core', 'cli.js'), leg, p],
    { cwd: ROOT, env: { ...env, OMNI_ASY_OUTNAME: pic, OMNI_ASY_OUTFORMAT: 'eps' },
      encoding: 'utf8', timeout: budget, maxBuffer: 1 << 28 });
  const ms = Date.now() - t0;
  // 每个例子的墙上时间发到 stderr（`TIME <名字> <毫秒>`）—— 判据自己的输出格式不动，
  // 要看耗时排行就 `2> 某个文件` 再排序。缓存命中的那些不会出现在这儿（本来就没跑）。
  process.stderr.write(`TIME ${p.replace(/^.*\//, '').replace(/\.asy$/, '')} ${ms}\n`);
  for (const f of readdirSync(ROOT)) {
    if (before.has(f)) continue;
    if (!f.endsWith('.eps') && !f.endsWith('.svg') && !f.endsWith('.pdf')) continue;
    rmSync(join(ROOT, f), { force: true });
  }
  // 超时被打死的那种：`signal` 是 SIGTERM。这一格要与"跑完了但没出图"分开 ——
  // 一趟全量 194 个例子，只要有几个卡住整轴就没法反复问，所以默认一个例子最多 LIMIT 毫秒，
  // 超时的归成"慢"、排在最后单独跑（`OMNI_EPS_T=60000 node tests/asy/eps.js <目录> <名字…>`）。
  const slow = r.signal === 'SIGTERM' || (r.error !== undefined && r.error !== null);
  // **孙子要一起收**：`omni run` 自己会再 spawn 一个 node 去跑那份 ESM 启动器
  // （cli.js 的 `spawn('node', [mainPath], 'i')`），而 spawnSync 的 timeout 只 SIGTERM
  // 直接的那个孩子 —— 不收的话每个超时的例子都留一个满载的 node 在后台啃 CPU，
  // 后面的例子于是越跑越慢（这一轴本身就变成了噪声源）。
  if (slow) {
    spawnSync('pkill', ['-f', `${join(ROOT, '.omni-cache', 'asy-mods')}/main-`],
      { encoding: 'utf8' });
  }
  // 文件没落下来（abort、或者这条腿还不认这个例子）时退回 stdout：`why()` 要靠
  // `abort:` 那一行归类，而 abort 走的是 write 那条路。
  let out = '';
  if (existsSync(pic) && statSync(pic).size > 0) {
    out = readFileSync(pic, 'latin1');
    rmSync(pic, { force: true });
  } else out = onlyEps(r.stdout ?? '');
  return { out, err: r.stderr ?? '', status: r.status, slow, ms, said: r.stdout ?? '' };
}

/**
 * 例子**自己**印的东西要从图里剥掉。真 asy 是 `-f eps -o <名>`：图写进文件，程序自己
 * `write(...)` 印的那些走 stdout，两者天然分开；我们这一层图也从 stdout 出去，于是
 * 例子印的行落在图**前面**。量出来的：xstitch 的 `histogram:`、lmfit1 的 `P_0 = …`
 * 就是这么变成"首处结构差"的。规矩：第一行 `%!PS-Adobe` 之前的全扔掉，之后一个字不动
 * （图里再有脏东西照旧算差 —— 这一格只补"两边的 stdout 不是同一个口子"这一处不对等）。
 */
function onlyEps(s) {
  const i = s.indexOf('%!PS-Adobe');
  return i <= 0 ? s : s.slice(i);
}

/**
 * 「为什么没出图」归一化成一类。取的是 `abort:` 那一行 —— abort 之后我们还会再抛一条
 * `array index out of range: 0`（abort 那条路上有一格读空数组），按第一行统计会被那条
 * 噪声全遮住：量过一次，107 份"越界"里绝大多数其实是各式各样的 `abort: … 还没做`。
 */
function why(r) {
  // `abort:` 那一行落在 **stdout** 上（asy 的 abort 走的是 write 那条路），而运行期那条
  // `array index out of range` 在 stderr 上 —— 两边都要看。`said` 是这一腿的 stdout 原样
  // （图现在走文件，`out` 里是图，不再带例子印的字）。
  const ls = `${r.said ?? r.out}\n${r.err}`.split('\n').filter((l) => l.trim() !== '');
  const ab = ls.filter((l) => l.trim().startsWith('abort:'));
  // **warning 不算错因**（这一刀）：`warning: using possibly incompatible version of plain.asy`
  // 是每个例子都印的一句，它排在 stderr 第一行，于是把真正的错遮住了 —— 量出来的样子是
  // Gouraud 与 sinxlex 记成"没出图 —— warning …"，而真错是 `RangeError: Maximum call
  // stack size exceeded`（guide/path 塌成一份那一格，见 ADR-0014）。一条 warning 都不剩时
  // 才退回去用它（那说明确实只有 warning）。
  const raw = r.err.split('\n').filter((l) => l.trim() !== '');
  const hard = raw.filter((l) => !l.trim().startsWith('warning:'));
  const es = hard.length > 0 ? hard : raw;
  const one = ab.length > 0 ? ab[0].trim()
    : (es.length === 0 ? `没有错误输出（退出 ${r.status}）` : es[0].trim());
  return one
    .replace(/\/[^\s:]+\.asy/g, '<文件>')
    .replace(/^[^:]*:\d+:\d+:\s*/, '')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d+/g, 'N')
    .slice(0, 150);
}

mkdirSync(REF, { recursive: true });
mkdirSync(RES, { recursive: true });
const names = process.argv.length > 3 ? process.argv.slice(3)
  : readdirSync(exDir).filter((f) => f.endsWith('.asy')).map((f) => f.slice(0, -4)).sort();

// **全量重跑先把产物缓存清掉**（ADR-0014 那一格"记录名依赖这一趟谁先被降"）。
// 为什么必须：库里两个同名的 struct（contour.asy 与 geometry.asy 都有 `segment`）现在
// 谁先被降谁拿裸名字，而名字会被写进接口索引与共用的 weak 那一份 —— 于是**上一个例子留下的
// 产物会让下一个例子编不过**。量出来的样子：先跑 Pythagoras（geometry）再跑 impact
// （contour），后者报 `类 segment 没有字段 'A'`；一趟全量里这么冤枉掉了 7 个例子
// （"结构不同"变"没出图"）。根因还没改（试过两种改法都退回来了，见 ADR-0014），
// 所以这一轴自己先把这个噪声源掐掉：报出来的数只能是干净缓存上跑出来的。
// 只在"全量 + 不认缓存"这一档清 —— 单独追几个例子时不清（那时要的是快）。
if (process.env.OMNI_EPS_FRESH === '1' && process.argv.length <= 3) {
  rmSync(join(ROOT, '.omni-cache', 'asy-mods'), { recursive: true, force: true });
}

/** 参考那一份的印记（没有就是 0）。换了参考，旧结论作废。 */
function refStamp(n) {
  const q = join(REF, `${n}.eps`);
  return existsSync(q) ? statSync(q).mtimeMs : 0;
}

/** 这个例子上一趟的结论还作数吗（编译器没变、例子没变、参考没换） */
function cached(n, p) {
  if (process.env.OMNI_EPS_FRESH === '1') return null;
  const q = join(RES, `${n}.json`);
  if (!existsSync(q)) return null;
  const st = statSync(p);
  const want = `${srcStamp()}|${st.mtimeMs}|${st.size}|${refStamp(n)}`;
  try {
    const o = JSON.parse(readFileSync(q, 'utf8'));
    return o.stamp === want ? o : null;
  } catch { return null; }
}

function remember(n, p, o) {
  const st = statSync(p);
  writeFileSync(join(RES, `${n}.json`),
    `${JSON.stringify({ ...o, stamp: `${srcStamp()}|${st.mtimeMs}|${st.size}|${refStamp(n)}` })}\n`);
}

/**
 * 这个例子**上一趟跑了多久**（毫秒，0 = 不知道）。印记作不作数都读 —— 要的只是个量级。
 */
function lastMs(n) {
  const q = join(RES, `${n}.json`);
  if (!existsSync(q)) return 0;
  try {
    const o = JSON.parse(readFileSync(q, 'utf8'));
    return typeof o.ms === 'number' && o.ms > 0 ? o.ms : 0;
  } catch { return 0; }
}

/**
 * 这个例子这一趟给多少预算（毫秒）。
 *
 * **为什么要按例子给，不是一个全局的 3s**：三维那一族（pdb / teapot / soccerball …）
 * 每个 5~30s，在 3s 的预算下**整族都记成 `slow` 并覆盖上一次的真结论** —— 于是
 * `.omni-cache/epsres` 里长期有 80 来个 `slow`，那不是"通过"，是"没量过"，占这一轴 40%。
 * 2026-09-08 单独补跑那 89 个才发现：一样 7、只有数值差 81、结构不同 1、没出图 0。
 * 现在把上一趟的耗时记进结论里（`ms`），预算取 `max(LIMIT, 2×上次 + 2s)`：
 * 快的例子照旧被 3s 卡着（跑飞了立刻能看出来），已知慢的给够，于是默认一趟也是完整的。
 * `OMNI_EPS_T` 仍是下限，显式给大值时一切照旧。
 */
function budgetFor(n) {
  const m = lastMs(n);
  const want = m > 0 ? 2 * m + 2000 : 0;
  return want > LIMIT ? want : LIMIT;
}

let same = 0;
let numdiff = 0;
let structdiff = 0;
let nogo = 0;
let noref = 0;
let dice = 0;
let fresh = 0;
let slow = 0;
const bad = [];
const slows = [];
const hist = new Map();
const who = new Map();
for (const n of names) {
  const p = join(exDir, `${n}.asy`);
  if (!existsSync(p)) { console.log(`  ?    ${n}：没有这个例子`); continue; }
  if (existsSync(p) && DICE.has(n)) { dice++; continue; } // 真 asy 自己都不重复，不计分
  const rp = oracle(n, p);
  if (rp === null) { noref++; continue; }            // 没有参考，不计分
  let o = cached(n, p);
  if (o === null) {
    fresh++;
    const budget = budgetFor(n);
    const r = mine(p, budget);
    if (r.slow) o = { kind: 'slow', note: `超过 ${budget}ms`, ms: budget };
    else if (r.out.indexOf('%%EOF') < 0) o = { kind: 'nogo', note: why(r) };
    else {
      // 位图那几块先摘出来单独比（见 pullImages）：滤镜不同，字节流两边必然不同，
      // 但解出来的像素是能逐字节对账的。
      const R = pullImages(readFileSync(rp, 'utf8'));
      const M = pullImages(r.out);
      const ib = cmpImages(R.imgs, M.imgs);
      const c = cmp(toks(R.text), toks(M.text));
      // 只印不判的量口：`OMNI_EPS_DUMP=<名字>` 把**判据真正比的那两串 token** 各写一份
      // 到 .omni-cache/epsdump/。追"首处 #N"必须看这一份 —— 拿原始 .eps 自己切 token
      // 会把位图那几块（这里已经换成 %IMGDATA）与摘掉的编码行算进去，位置对不上，
      // 我为此错判过一次（把 laserlattice 的结构差认成 /FlateDecode 滤镜的事）。
      if (process.env.OMNI_EPS_DUMP === n) {
        const dd = join(ROOT, '.omni-cache', 'epsdump');
        mkdirSync(dd, { recursive: true });
        writeFileSync(join(dd, `${n}.ref.txt`), toks(R.text).join('\n'));
        writeFileSync(join(dd, `${n}.our.txt`), toks(M.text).join('\n'));
        console.log(`  [dump] ${n}: ${dd}/${n}.{ref,our}.txt`);
      }
      if (c.bad === 0 && ib === null) o = { kind: 'same', note: '' };
      else if (c.bad === 0) o = { kind: 'num', note: `矢量那半边一样，${ib}` };
      else if (c.len[0] !== c.len[1]) {
        o = { kind: 'struct',
          note: `长度 ${c.len[0]} vs ${c.len[1]}，首处 ${c.first}${ib === null ? '' : `；${ib}`}` };
      } else {
        o = { kind: 'num',
          note: `${c.bad} 处数值不同，首处 ${c.first}${ib === null ? '' : `；${ib}`}` };
      }
    }
    // 耗时也记进结论里（`ms`）—— 下一趟的预算按它算（见 budgetFor）。
    remember(n, p, { ...o, ms: o.ms ?? r.ms });
  }
  if (o.kind === 'same') { same++; continue; }
  if (o.kind === 'slow') { slow++; slows.push(n); continue; }
  if (o.kind === 'nogo') {
    nogo++;
    hist.set(o.note, (hist.get(o.note) ?? 0) + 1);
    if (!who.has(o.note)) who.set(o.note, []);
    if (who.get(o.note).length < 5) who.get(o.note).push(n);
    bad.push(`${n}: 没出图 —— ${o.note}`);
    continue;
  }
  if (o.kind === 'struct') { structdiff++; bad.push(`${n}: 结构不同（${o.note}）`); continue; }
  numdiff++;
  bad.push(`${n}: ${o.note}`);
}
rmSync(WORK, { recursive: true, force: true });
console.log(`EPS 那一轴：一样 ${same}、只有数值差 ${numdiff}、结构不同 ${structdiff}、`
  + `没出图 ${nogo}、超预算的 ${slow}`
  + `（没有参考、不计分的 ${noref} 份；摇骰子、比不出来的 ${dice} 份；`
  + `这一趟真跑了 ${fresh} 个，其余用的是缓存）`);
for (const b of bad) console.log(`  ${b}`);
if (slows.length > 0) {
  console.log(`--- 超时排在最后的 ${slows.length} 个（单独追：`
    + `OMNI_EPS_T=60000 node tests/asy/eps.js <目录> ${slows.slice(0, 3).join(' ')} …）：`);
  console.log(`  ${slows.join(' ')}`);
}
if (process.env.OMNI_EPS_WHY === '1') {
  console.log('--- 没出图的按第一条错归类：');
  for (const [k, c] of [...hist.entries()].sort((a, b2) => b2[1] - a[1])) {
    console.log(`${String(c).padStart(4)}  ${k}\n        例：${who.get(k).join(' ')}`);
  }
}
process.exit(numdiff + structdiff + nogo + slow === 0 ? 0 : 1);
