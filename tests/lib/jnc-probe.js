// tests/lib/jnc-probe.js —— 探针的**公共件**：位置的垫、分类器、跑一格
//
// 两把生成出来的尺子（`jnc-matrix.js` 手命名的那 66 列、`jnc-gen.js` 从词汇表**乘出来**的
// 那几百列）共用这一份 —— 先前它只在 matrix 那一份里，第二把尺子一来就得抄一遍。
// 抄一遍就会各自漂（这套 ADR 反复记的那笔账），所以先搬出来。

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..');
export const cli = join(root, 'src', 'core', 'cli.js');
export const OUT_DIR = join(process.env.OMNI_CACHE_DIR || join(root, '.omni-cache'), 'test', 'matrix');

/** 每一趟开头把工作目录清出来，并把被 import 的那一份也合成好（探针要自足）。 */
export function prepare() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(OUT_DIR, 'imports'), { recursive: true });
  writeFileSync(join(OUT_DIR, 'imports', 'probeimp.jnc'), 'int probeImported() {\n\treturn 7;\n}\n');
}

export function cleanup(keep) {
  if (!keep) rmSync(OUT_DIR, { recursive: true, force: true });
  return OUT_DIR;
}

/* ---------------------------------------------------------------- 位置表
 * 每个位置给一个 `wrap(elem)`：把那一格要素塞进这个位置，凑成一份**能编的**源码。
 * 公共前奏（`PRE`）给要素里引到的名字（Helper / probeFn / probeNs）一个落脚处 ——
 * 那几个名字本身不是被量的东西，缺了它们每一格都会多一条"没有这个类型"的噪音。 */
export const PRE = `class Helper {
	int m_hv;
}

class Helper2 {
	int m_h2v;
}

struct Boxy<T> {
	T m_v;

	construct(T v) {
		m_v = v;
	}
}

int probeFn(int a) {
	return a;
}

int probeSelf() {
	return 0;
}

namespace probeNs {
	int probeNsFn() {
		return 0;
	}
}

`;

const MAIN = `
int ProbeU.probeSelf() {
	return 0;
}

int main() {
	printf("probe\\n");
	return 0;
}
`;

export const SORTS = [
  ['module', (e) => `${PRE}${e}\n${MAIN}`],
  ['namespace', (e) => `${PRE}namespace probeOuter {\n${e}\n}\n${MAIN}`],
  ['class-body', (e) => `${PRE}class ProbeC {\n\tint m_pad;\n\tint probeSelf() { return 0; }\n${e}\n}\n${MAIN}`],
  ['struct-body', (e) => `${PRE}struct ProbeS {\n\tint m_pad;\n\tint probeSelf() { return 0; }\n${e}\n}\n${MAIN}`],
  ['union-body', (e) => `${PRE}union ProbeU {\n\tint m_ua;\n\tbool m_ub;\n\tint probeSelf();\n${e}\n}\n${MAIN}`],
  ['opaque-class-body', (e) => `${PRE}opaque class ProbeO {\n\tint m_pad;\n\tint probeSelf() { return 0; }\n${e}\n}\n${MAIN}`],
  ['fn-body', (e) => `${PRE}int probeHost() {\n${e}\n\treturn 0;\n}\n${MAIN}`],
  ['property-body', (e) => `${PRE}int property g_pp {\n\tget {\n\t\treturn 1;\n\t}\n${e}\n}\n${MAIN}`],
  ['extension-body', (e) => `${PRE}extension ProbeExt: Helper {\n\tint probeSelf() { return 0; }\n${e}\n}\n${MAIN}`],
];

/* ---------------------------------------------------------------- 跑一格
 * 归一：`'…'` 那些名字换掉（与 jnc-sweep 的 reasonOf 同一条口径），好让同一件事在
 * 不同格里显示成同一句话。 */
export function classify(err, code) {
  const lines = err.split('\n');
  let syn = false;
  let nope = null;
  let plain = null;
  let spanless = false;
  for (const l of lines) {
    /* 两种形状都收：带位置的 `文件:行:列: error: …`，与**不带位置**的 `omni: error: …`。
       后者本身是一格账（ADR-0029 的 R5：诊断该有位置）—— 先前这一份只认前者，于是那 11 格
       落成了"退出码 1，没有诊断"，把"没位置"说成了"没诊断"。 */
    let m = /^.*?:\d+:\d+: (error|warning): (.*)$/.exec(l);
    if (m === null) {
      const m2 = /^omni: (error|warning): (.*)$/.exec(l);
      if (m2 === null) continue;
      m = m2;
      spanless = true;
    }
    if (m[1] === 'warning') continue;
    const why = m[2].replace(/'[^']*'/g, "'…'");
    if (/^(unexpected|语法|认不出的)/.test(why) || /unexpected/.test(why)) { syn = true; continue; }
    if (why.startsWith('jancy 前端第一刀还不收：')) {
      if (nope === null) nope = why.slice('jancy 前端第一刀还不收：'.length);
      continue;
    }
    if (plain === null) plain = why;
  }
  if (syn && nope === null && plain === null) return { k: 'syn', why: '语法不认' };
  const tag = spanless ? '（**没位置**）' : '';
  if (nope !== null) return { k: 'N', why: nope + tag };
  if (plain !== null) return { k: 'E', why: plain + tag };
  /* **炸**（一条诊断都没有、栈爬出来了）：那是这一层自己的 bug，不是语言的边界。
     这一类语料榜量不到（榜只看诊断行），而它恰恰是最该先修的一类 —— 见 ADR-0029。 */
  const st = /^\s*(TypeError|RangeError|ReferenceError|AssertionError|Error): (.*)$/m.exec(err);
  if (st !== null) return { k: 'crash', why: `${st[1]}: ${st[2]}`.slice(0, 90) };
  return code === 0 ? { k: 'ok', why: '' } : { k: 'E', why: `退出码 ${code}，没有诊断` };
}

/**
 * 把那一格降出来的 `.sx` 拿回来（跑得过才有；跑不过回 null）。
 * 第三问要用它：**修饰词有没有被悄悄丢掉**（ADR-0029 第 10.21 节那条界）。
 */
export function sxOf(sort, kind, src) {
  const p = join(OUT_DIR, `${sort}__${kind}.jnc`);
  writeFileSync(p, src);
  try {
    return execFileSync(process.execPath, [cli, 'sx', p, '-I', OUT_DIR], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
    });
  } catch {
    return null;
  }
}

export function runOne(sort, kind, src) {
  const p = join(OUT_DIR, `${sort}__${kind}.jnc`);
  writeFileSync(p, src);
  try {
    execFileSync(process.execPath, [cli, 'sx', p, '-I', OUT_DIR], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
    });
    return classify('', 0);
  } catch (e) {
    return classify(e.stderr ?? '', e.status ?? 1);
  }
}

