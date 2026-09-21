#!/usr/bin/env node
// Omni — asymptote 的**第十七条测试轴**：SVG 那一路（ADR-0014 第九十三刀）
//
// 这一轴与 eps.js 有个根本的差别：**没有 oracle**。真 asy 没有原生 SVG 出口 ——
// 它的 `-f svg` 是先出 dvisvgm 能吃的东西再交给 dvisvgm，字形被拆成 <path>，
// 版本一换字节就变。所以拿它当参考没有意义，这一轴问的是另外两件事：
//
//   一、**读得进**：出来的是良构 XML（标签配平、属性带引号、实体转义过）。
//       Node 没有内建 XML 解析器，这里自己扫一遍 —— 只要良构那一层，不做校验。
//   二、**与 EPS 那一路对得上**：同一个例子两种格式各出一份，比
//       （a）画布尺寸：SVG 的 viewBox 宽高 == EPS 的 %%HiResBoundingBox 宽高；
//       （b）图元条数：SVG 的 <path> 条数 == EPS 里 stroke/fill/eofill/shfill 的次数；
//       （c）裁剪层数：<clipPath> 条数 == EPS 里 clip/eoclip 的次数。
//       这三条把"形状漏了/多了/摆错了"挡住，而这正是自定义格式里唯一能证伪的部分。
//
// 带标签的例子在 EPS 那一路会转去 latex+dvips（字节由 dvips 写），图元数就对不上了 ——
// 那种只查第一条（良构）与画布尺寸，(b)(c) 跳过。哪一种是量出来的，不是猜的：
// 输出里 `%%Creator: dvips` 就是那一路。
//
// 用法：
//   ASYMPTOTE_DIR=<真 base> node tests/asy/svg.js <examples 目录> [名字…]
//   OMNI_SVG_T=<毫秒>   一个例子最多跑多久（默认 3000）
//   OMNI_SVG_N=<个数>   不给名字时只取前 N 个（默认 40 —— 这一轴要能反复问）
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WORK = join(ROOT, '.omni-cache', 'svgrun');
const LIMIT = Number(process.env.OMNI_SVG_T === undefined ? 3000 : process.env.OMNI_SVG_T);
const TAKE = Number(process.env.OMNI_SVG_N === undefined ? 40 : process.env.OMNI_SVG_N);
// 画布宽高的比法：SVG 那份是 ps() 直接印宽高的**9 位有效数字**，EPS 那份是两个 9 位数
// 相减 —— 而 EPS 里那两个数是「摆到信纸上之后」的坐标（几百），9 位有效在那个量级上
// 就是 1e-6 的粒度，相减之后误差到 2e-6。所以这里是绝对 1e-5 兜底 + 相对 1e-8，
// 两个数都是记法带来的上限，不是"放松判据"。
const ABSTOL = 1e-5;
const RELTOL = 1e-8;

const exDir = process.argv[2];
if (exDir === undefined) {
  console.error('用法：node tests/asy/svg.js <examples 目录> [名字…]');
  process.exit(2);
}
const base = join(exDir, '..', 'base');
const env = {
  ...process.env,
  OMNI_ASY_MODS: '1',
  ASYMPTOTE_DIR: process.env.ASYMPTOTE_DIR === undefined || process.env.ASYMPTOTE_DIR === ''
    ? base : process.env.ASYMPTOTE_DIR,
};

/**
 * 良构那一层：标签配平、属性有引号、正文里没有裸 `<` 与裸 `&`。
 * 回一条人话（错在哪儿）或者 null（没问题）。顺带把 <path> 与 <clipPath> 数出来。
 */
function wellformed(s) {
  const stack = [];
  let paths = 0;
  let clips = 0;
  let inclip = 0;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { if (s.slice(i).indexOf('&') >= 0 && !/&(amp|lt|gt|quot|apos|#\d+);/.test(s.slice(i))) return '正文里有裸 &'; break; }
    const text = s.slice(i, lt);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text)) return '正文里有裸 &';
    if (s.startsWith('<?', lt) || s.startsWith('<!', lt)) {
      const e = s.indexOf('>', lt);
      if (e < 0) return '声明没有收尾的 >';
      i = e + 1;
      continue;
    }
    // 一格标签：属性值里的 > 不算收尾，所以要跟着引号走
    let j = lt + 1;
    let quote = '';
    while (j < s.length) {
      const c = s[j];
      if (quote !== '') { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= s.length) return '标签没有收尾的 >';
    const body = s.slice(lt + 1, j);
    if (body.startsWith('/')) {
      const nm = body.slice(1).trim();
      if (stack.length === 0 || stack[stack.length - 1] !== nm) {
        return `</${nm}> 对不上（在开着的是 ${stack.length === 0 ? '（空）' : stack[stack.length - 1]}）`;
      }
      if (nm === 'clipPath') inclip--;
      stack.pop();
    } else {
      const nm = body.split(/[\s/>]/)[0];
      // 属性：name="…" 或 name='…'，别的形状（裸值、没有等号）都不认
      const attrs = body.slice(nm.length).replace(/\/$/, '').trim();
      if (attrs !== '' && !/^([A-Za-z_:][-\w:.]*\s*=\s*("[^"]*"|'[^']*')\s*)*$/.test(attrs)) {
        return `<${nm}> 的属性不成对：${attrs.slice(0, 60)}`;
      }
      if (nm === 'path' && inclip === 0) paths++;   // <clipPath> 里那一条不是图元
      if (nm === 'clipPath') { clips++; inclip++; }
      if (!body.endsWith('/')) stack.push(nm);
    }
    i = j + 1;
  }
  if (stack.length > 0) return `还有 ${stack.length} 个标签没关：${stack.join(' ')}`;
  return { paths, clips };
}

/**
 * 一趟 `omni run`。格式由 **`-f FMT`** 给 —— 那是运行期的一格宿主设置（ADR-0015），
 * 例子本身一个字不改、也不做副本：编出来的东西与格式无关，同一份产物两种格式各跑一趟。
 * 从前这儿是往源文件头上贴一句 `asy__defaultformat = "svg";` 再跑副本，那等于让
 * 「编出来的东西」记住格式 —— 设计上的错，连测法一起改掉了。
 */
function run(p, n, fmt) {
  const r = spawnSync('node', [join(ROOT, 'src', 'core', 'cli.js'), 'run', p, '-f', fmt],
    { cwd: exDir, env, encoding: 'utf8', timeout: LIMIT, maxBuffer: 1 << 28 });
  const slow = r.signal === 'SIGTERM' || (r.error !== undefined && r.error !== null);
  if (slow) {
    spawnSync('pkill', ['-f', `${join(ROOT, '.omni-cache', 'modules')}/main-`], { encoding: 'utf8' });
  }
  return { out: r.stdout ?? '', err: r.stderr ?? '', slow };
}

/**
 * `-f svg` 与 `-o 名字.svg` 必须是**同一件事**（后缀猜格式），而且图落在那个文件里、
 * 程序自己 write 的字仍旧走 stdout。这一条就是"格式没被模块锁定"的门：
 * 两趟跑的是同一份产物（缓存的印记里没有格式），出来的字节要一样。
 */
function sameByOutName(p, n) {
  mkdirSync(WORK, { recursive: true });
  const out = join(WORK, `${n}.svg`);
  const r = spawnSync('node', [join(ROOT, 'src', 'core', 'cli.js'), 'run', p, '-o', out],
    { cwd: exDir, env, encoding: 'utf8', timeout: LIMIT, maxBuffer: 1 << 28 });
  if (r.signal === 'SIGTERM' || (r.error !== undefined && r.error !== null)) return null;
  if (!existsSync(out)) return `-o ${n}.svg 没落下文件`;
  const viaOut = readFileSync(out, 'utf8');
  const viaF = onlySvg(run(p, n, 'svg').out);
  if (onlySvg(viaOut) !== viaF) return `-f svg 与 -o ${n}.svg 出来的字节不一样`;
  if (viaOut.indexOf('<?xml') !== 0) return `-o ${n}.svg 落下的不是纯 SVG（前面混进了别的）`;
  return null;
}

/** stdout 里那一段 SVG（例子自己 write 的东西落在前面） */
function onlySvg(s) {
  const a = s.indexOf('<?xml');
  const b = s.lastIndexOf('</svg>');
  return a < 0 || b < 0 ? '' : s.slice(a, b + 6);
}
function onlyEps(s) {
  const i = s.indexOf('%!PS-Adobe');
  return i <= 0 ? s : s.slice(i);
}

/** EPS 那一份里的图元数、裁剪数、画布宽高 */
function epsfacts(s) {
  let prims = 0;
  let clips = 0;
  let shade = 0;
  let lat = 0;
  let wh = null;
  for (const raw of s.split('\n')) {
    const ln = raw.trim();
    if (ln.startsWith('%%HiResBoundingBox:')) {
      const v = ln.split(/\s+/).slice(1).map(Number);
      if (v.length === 4) wh = [v[2] - v[0], v[3] - v[1]];
      continue;
    }
    if (ln.startsWith('%')) continue;
    if (ln.startsWith('<< /ShadingType 1')) lat++;
    for (const w of ln.split(/\s+/)) {
      if (w === 'stroke' || w === 'fill' || w === 'eofill' || w === 'shfill') prims++;
      if (w === 'shfill') shade++;
      if (w === 'clip' || w === 'eoclip') clips++;
    }
  }
  // 渐变/网格那一族在 PS 里自己发 clip，那几次不是 asy 层面的 clip(...)，SVG 这边没有
  // 对应物 —— 扣掉再比。**每一族扣几次是量出来的**：
  //   emitshade 自己一次（drawfill.h:75 把超路径当裁剪）；
  //   gradshade / gourshade / tenshade 开头再一次（psfile.cc:373 那段 endclip(pena)）；
  //   latshade（/ShadingType 1）**没有**那一次 —— 少扣了就成了负数，
  //   latticeshading 与 strokeshade 就是这么报出 "裁剪 -1 层" 的。
  return {
    prims,
    clips: clips - (2 * shade - lat),
    wh,
    dvips: s.indexOf('%%Creator: dvips') >= 0,
  };
}

const names = process.argv.length > 3 ? process.argv.slice(3)
  : readdirSync(exDir).filter((f) => f.endsWith('.asy')).map((f) => f.slice(0, -4)).sort().slice(0, TAKE);

let ok = 0;
let nogo = 0;
let slow = 0;
let partial = 0;
let outname = 0;              // `-o 名字.svg` 那一条查过几份
const bad = [];
for (const n of names) {
  const p = join(exDir, `${n}.asy`);
  if (!existsSync(p)) { console.log(`  ?    ${n}：没有这个例子`); continue; }
  const rs = run(p, n, 'svg');
  if (rs.slow) { slow++; continue; }
  const svg = onlySvg(rs.out);
  if (svg === '') { nogo++; continue; }               // EPS 那一轴已经在管"出不出图"，这里不重复报
  const w = wellformed(svg);
  if (typeof w === 'string') { bad.push(`${n}: XML 不良构 —— ${w}`); continue; }
  const m = /viewBox="0 0 ([-\d.]+) ([-\d.]+)"/.exec(svg);
  if (m === null) { bad.push(`${n}: 没有 viewBox`); continue; }
  const svgwh = [Number(m[1]), Number(m[2])];
  // `-f svg` == `-o 名字.svg`：头三份出得了图的例子上各查一趟就够（这一条问的是那两条
  // 路子通不通、字节一不一样，与例子本身无关；每份多跑一趟 node 是真金白银）。
  if (outname < 3) {
    outname++;
    const why = sameByOutName(p, n);
    if (why !== null) bad.push(`${n}: ${why}`);
  }
  const re = run(p, n, 'eps');
  const eps = onlyEps(re.out);
  if (eps.indexOf('%%EOF') < 0) { partial++; ok++; continue; }   // 只验了良构
  const ef = epsfacts(eps);
  const errs = [];
  if (ef.wh !== null) {
    const off = (a, b) => Math.abs(a - b) > ABSTOL + RELTOL * Math.abs(a);
    if (off(ef.wh[0], svgwh[0]) || off(ef.wh[1], svgwh[1])) {
      errs.push(`画布 ${ef.wh[0]}x${ef.wh[1]} vs ${svgwh[0]}x${svgwh[1]}`);
    }
  }
  if (!ef.dvips) {
    if (ef.prims !== w.paths) errs.push(`图元 ${ef.prims} 条 vs <path> ${w.paths} 条`);
    if (ef.clips !== w.clips) errs.push(`裁剪 ${ef.clips} 层 vs <clipPath> ${w.clips} 个`);
  } else partial++;
  if (errs.length > 0) bad.push(`${n}: ${errs.join('；')}`);
  else ok++;
}
rmSync(WORK, { recursive: true, force: true });
console.log(`SVG 那一轴：对得上 ${ok}、对不上 ${bad.length}`
  + `（出不了图、这一轴不计分的 ${nogo} 份；超过 ${LIMIT}ms 的 ${slow} 份；`
  + `只验了良构与画布的 ${partial} 份 —— EPS 那一路走的是 dvips，图元数天然不可比；`
  + `另外在 ${outname} 份上查过 -f svg == -o 名字.svg）`);
for (const b of bad) console.log(`  ${b}`);
process.exit(bad.length === 0 ? 0 : 1);
