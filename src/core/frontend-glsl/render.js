// src/core/frontend-glsl/render.js —— `omni run x.frag -o out.png`（ADR-0019 决策九）
//
// 这一层把三段接起来：**前端 -> LLVM IR -> C 宿主渲染 -> 一张 PNG**。
//
// 三条硬约束照旧（决策八）：一个进程、不落盘、按指针调用。IR 走 `spawnIn` 喂进宿主的
// stdin —— 磁盘上唯一被写的是那张 PNG，它是产物不是中间物。
//
// **谁知道什么**：宿主不认识 GLSL，所以 uniform 的值由这一层按声明次序摊成一串数、
// 从命令行递过去。这条分工与「IR 走 stdin」是同一个道理。

import { spawn, spawnIn, exists, mkdirAll, readText } from '../host/native.js';
import { cacheRoot } from '../host/cache.js';
import { join, dirname } from '../host/path.js';
import { hash16 } from '../host/hash.js';
import { OmniError } from '../source/diag.js';
import { Diagnostics, SourceFile } from '../source/diag.js';
import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { glslPreprocess, glslTypeNames } from './pp.js';
import { glslCheck } from './check.js';
import { glslEmitLlvm } from './emit_llvm.js';

/** GLSL 的类型有几格（与 `emit_llvm.js` 的 `llNComp` 同一个公式，这儿只要摊平数）。 */
/**
 * `#include` 的查找：**只找引用者所在的目录**（相对路径），这一档最窄。
 *
 * 为什么不是一串 `-I`：现在的用例（`omni run x.frag`）里 include 的都是同一份着色器
 * 拆出来的邻居。要一串搜索路径的那天（拿 vispy 的 `glsl/` 当根就是）再从 CLI 递进来 ——
 * 这一格是**注入**给预处理器的（`pp.js` 不碰文件系统），多一条路径不动它一行。
 */
function glslOpenInclude(name, from) {
  const p = join(dirname(from), name);
  if (!exists(p)) return null;
  return { path: p, text: readText(p) };
}

function glslRenderNComp(t) {
  if (t.k === 'vec') return t.n;
  if (t.k === 'mat') return t.cols * t.rows;
  if (t.k === 'array') return t.n * glslRenderNComp(t.of);
  if (t.k === 'struct') {
    let n = 0;
    for (const f of t.fields) n += glslRenderNComp(f.ty);
    return n;
  }
  return 1;
}

/**
 * 找 `llvm-config`。`OMNI_LLVM_CONFIG` 优先，其次 PATH 里那几个常见名字，最后是 homebrew
 * 那两个固定位置 —— **brew 装的 llvm 是 keg-only，不在 PATH 上**，只查 PATH 会找不到
 * （`tests/glsl/fast.js` 早就在探这两条路径了，这儿照抄）。
 *
 * 两种候选分开探：带 `/` 的直接 `exists`，裸名字走 `which`。不能统一用 `spawn(候选)`
 * 试 `--version`：`native.js` 的 `spawn` 在 ENOENT 上是**抛**而不是回非零。
 */
function glslRenderFindLlvmConfig(envGet) {
  const pick = envGet('OMNI_LLVM_CONFIG');
  if (pick !== undefined && pick !== '') return pick;
  const cands = ['llvm-config', 'llvm-config-19', 'llvm-config-18', 'llvm-config-17',
    '/opt/homebrew/opt/llvm/bin/llvm-config', '/usr/local/opt/llvm/bin/llvm-config'];
  for (const n of cands) {
    if (n.indexOf('/') >= 0) {
      if (exists(n)) return n;
    } else if (spawn('which', [n], 'c')[0] === 0) {
      return n;
    }
  }
  return null;
}

/**
 * 编出（或复用）那个 C 宿主。键里带上**两份源码的正文** —— 改一行 C 就换一个目录，
 * 不会读到旧的宿主。
 */
function glslRenderBuildHost(root, lc, cc) {
  const hostSrc = join(root, 'src', 'jit', 'glsl_host.c');
  const pngSrc = join(root, 'src', 'jit', 'png.c');
  const ver = spawn(lc, ['--version'], 'c')[1].trim();
  const inc = spawn(lc, ['--includedir'], 'c')[1].trim();
  const lib = spawn(lc, ['--libdir'], 'c')[1].trim();
  const key = hash16(`${cc}|${ver}|${readText(hostSrc)}|${readText(pngSrc)}`);
  const dir = join(cacheRoot(), 'glsl-host', key);
  const exe = join(dir, 'omni-glsl-jit');
  if (exists(exe)) return exe;
  mkdirAll(dir);
  const r = spawn(cc, ['-O2', '-w', '-I', inc, hostSrc, pngSrc, '-L', lib, '-lLLVM', '-lm',
    `-Wl,-rpath,${lib}`, '-o', exe], 'c');
  if (r[0] !== 0) {
    throw new OmniError(`glsl render: 编不出 C 宿主\n${r[2].trim().split('\n').slice(0, 6).join('\n')}`);
  }
  return exe;
}

/**
 * 渲染一帧写 PNG。
 *
 *   root  —— 仓库根（找 `glsl.grammar` 与那两份 C）
 *   path  —— `.frag` 的路径
 *   out   —— 要写的 PNG
 *   w / h —— 画布大小
 *   set   —— uniform 的值：`{ 名字: [数…] }`，没给的那些按 0
 *   cc / envGet —— 宿主那一侧要用的编译器与环境查询（这一层不直接碰环境）
 *
 * 回一个 `{ uniforms, ir, exe, out }`，方便上面那一层印账目。
 */
export function glslRenderToPng(root, path, out, w, h, set, cc, envGet) {
  const gpath = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
  const table = loadGrammarTable(gpath);
  const diags = new Diagnostics();
  const src = readText(path);
  const toks = glslTypeNames(glslPreprocess(table.g.lex,
    lexText(table.g.lex, new SourceFile(path, src), diags), diags, { open: glslOpenInclude }));
  diags.throwIfErrors();
  const tree = glrParse(table.tb, toks, diags);
  diags.throwIfErrors();
  const mod = glslCheck(tree, 'frag');
  const ir = glslEmitLlvm(mod);

  /* uniform 摊成一串数，**按声明次序** —— 宿主那侧就是照这个次序往 `in` 里填。
   *
   * 采样器占**三格**（宽、高、这张图在纹素那一串里的起点），纹素本身另走 `--tex`
   * 那一串。这与参考腿的 `glslUniArgs` 是同一套布局，所以同一个 `set` 两条腿都吃。 */
  const vals = [];
  const names = [];
  const tex = [];
  for (const u of mod.uniforms) {
    if (u.ty.k === 'sampler') {
      const t = set[u.name];
      if (t === undefined || t.data === undefined) {
        throw new OmniError(`glsl render: 采样器 '${u.name}' 没给纹理（要 { w, h, data }）`);
      }
      const tw = t.w;
      const th = u.ty.dim === 1 ? 1 : t.h;
      if (t.data.length !== tw * th * 4) {
        throw new OmniError(`glsl render: 采样器 '${u.name}' 要 ${tw * th * 4} 个数`
          + `（${tw}×${th} 的 RGBA），给了 ${t.data.length}`);
      }
      names.push(`${u.name}[${tw}x${th}]`);
      vals.push(tw);
      vals.push(th);
      vals.push(tex.length);
      for (const v of t.data) tex.push(v);
      continue;
    }
    const n = glslRenderNComp(u.ty);
    const given = set[u.name];
    if (given !== undefined && given.length !== n) {
      throw new OmniError(`glsl render: uniform '${u.name}' 要 ${n} 格，--set 给了 ${given.length}`);
    }
    names.push(`${u.name}[${n}]`);
    for (let i = 0; i < n; i++) vals.push(given === undefined ? 0 : given[i]);
  }

  const lc = glslRenderFindLlvmConfig(envGet);
  if (lc === null) {
    throw new OmniError('glsl render: 找不到 llvm-config（OMNI_LLVM_CONFIG 可以指一个）');
  }
  const exe = glslRenderBuildHost(root, lc, cc);
  const argv = ['--render', String(w), String(h), out];
  for (const v of vals) argv.push(String(v));
  /* 纹素跟在一个 `--tex` 哨兵后面 —— 两串数长度都不定，中间要有个界。 */
  if (tex.length > 0) {
    argv.push('--tex');
    for (const v of tex) argv.push(String(v));
  }
  /* IR 走 stdin —— 决策八那一条。 */
  const r = spawnIn(exe, argv, 'c', ir);
  if (r[0] !== 0) {
    throw new OmniError(`glsl render: 宿主回了 ${r[0]}\n${r[2].trim().split('\n').slice(0, 8).join('\n')}`);
  }
  return { uniforms: names, irLines: ir.split('\n').length, exe, out, hostOut: r[1].trim() };
}
