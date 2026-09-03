/**
 * 与语言无关那几条动词的管线表（ADR-0018 决策五，分片 4）。
 *
 * 与 `plan-c.js` 同一条规矩：**只造表、不干活**，看的是与实现同一批开关，
 * 于是 `--explain` 说得准（一个字节都不写盘、不执行），`-v` 也能共用同一份渲染。
 *
 * 这一份覆盖 `emit`（那 9 种形态）、`check`、`interp`。**`run`/`build` 还没覆盖**，
 * 理由写在明处：那两条是**边走边决定**的（`.asy` 那一路先问「上一趟的清单还成立吗」，
 * 命中就一步前端都不走），要造表得先把「要走哪条」提前算出来 —— 那是另一片的事。
 * 造不出表就回 `null`，调用方照旧明着说「还没覆盖」，不许猜一条出来充数。
 */

import { newPlan, addStage } from './stages.js';

/** 从 `rest` 里捞一个带值开关（与实现那一侧同一个捞法）。 */
function opt(rest, name, dflt) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
}

/**
 * 前端由**扩展名**选（`compileFront` 那一条规矩），`--mode` 只覆盖 `.omni` 一族的类型模式。
 *
 * 回 `{ lang, ast, steps }`：`lang` 是摘要里那个名字，`ast` 说这一路有没有真的 AST
 * （`emit ast` 只在有 AST 的那几路上说得通），`steps` 是前端那几格。
 */
function frontOf(path, rest) {
  const mode = opt(rest, '--mode', null);
  if (path.endsWith('.js')) {
    return { lang: 'js', ast: true, steps: [{ verb: 'parse', in: 'text', out: 'AST' }] };
  }
  if (path.endsWith('.wat')) {
    return { lang: 'wat', ast: true, steps: [{ verb: 'parse', in: 'text', out: 'AST' }] };
  }
  if (path.endsWith('.sx')) {
    return {
      lang: '核心方言',
      ast: false,
      steps: [{ verb: 'read', in: 'text', out: 's-expr' }],
    };
  }
  if (path.endsWith('.asy') || path.endsWith('.jnc')) {
    const l = path.endsWith('.asy') ? 'asy' : 'jancy';
    return {
      lang: l,
      ast: true,
      steps: [
        { verb: 'parse', in: 'text', out: 'AST', note: 'GLR（ADR-0014 决策二）' },
        { verb: 'lower', in: 'AST', out: '核心方言文本', note: `omni emit sx 印的就是这一格` },
        { verb: 'read', in: '核心方言文本', out: 's-expr' },
      ],
    };
  }
  const m = mode !== null ? mode
    : path.endsWith('.omnid') ? 'dynamic' : path.endsWith('.omnis') ? 'static' : 'mixed';
  return {
    lang: `omni（${m}）`,
    ast: true,
    steps: [{ verb: 'parse', in: 'text', out: 'AST', note: `类型模式 ${m}（ADR-0008）` }],
  };
}

/** 前端那几格 + 检查器 + 摇树 —— 到 OIR 为止，这一段所有命令都一样。 */
function toOir(p, path, front) {
  addStage(p, { phase: 'front', verb: 'read', in: path });
  for (const s of front.steps) addStage(p, { phase: 'front', ...s });
  addStage(p, {
    phase: 'mid', verb: 'check', in: front.steps[front.steps.length - 1].out ?? 'AST', out: 'OIR',
    note: '名字解析、类型检查、重载挑选',
  });
  /* 摇树在 `compile` 里，不在各条命令里 —— 所以它属于这一段，不属于后端那一段。
   * `OMNI_PRUNE=0` 关掉（要对比「摇没摇」两份产物时用）。 */
  addStage(p, { phase: 'mid', verb: 'prune', in: 'OIR', out: 'OIR', note: '从入口不可达的函数一个都不发' });
}

/** `emit FORM` 那 9 种：形态 -> [摘要里的名字, 后端那一格的动词与出参]。 */
const FORMS = {
  ast: { name: 'AST', verb: 'print', from: 'AST', needAst: true },
  oir: { name: 'OIR', verb: 'print', from: 'OIR' },
  mir: { name: 'MIR', verb: 'lower', from: 'OIR' },
  sx: { name: '核心方言文本', verb: 'print', from: '核心方言文本', needSx: true },
  js: { name: 'JS', verb: 'emit', from: 'OIR' },
  c: { name: 'C', verb: 'emit', from: 'OIR' },
  llvm: { name: 'LLVM IR', verb: 'emit', from: 'OIR' },
  spirv: { name: 'SPIR-V', verb: 'emit', from: 'OIR' },
  asy: { name: 'asy', verb: 'emit', from: 'OIR' },
};

/** `emit` 的旧扁平名 -> 形态（`cli.js` 里那张 `FORMS` 的反表）。 */
const KEY_TO_FORM = {
  'emit-js': 'js', 'emit-c': 'c', 'emit-llvm': 'llvm', 'emit-spirv': 'spirv',
  'emit-asy': 'asy', ast: 'ast', oir: 'oir', mir: 'mir', sx: 'sx',
};

/**
 * 回一条管线，或者 `null`（这一条还没覆盖）。
 *
 * `cmd` 是命令树上那个 `key`。`emit` 走到这儿时 `cli.js` 已经把形态翻成了旧扁平名
 * （`emit c` -> `emit-c`），所以这儿只认后者 —— 与实现看到的是同一个字符串。
 */
export function planForOmni(cmd, path, files, rest) {
  if (path === undefined) return null;
  const front = frontOf(path, rest);
  const out = opt(rest, '-o', undefined);

  if (cmd === 'check') {
    /* `.c` 走的是 C 那一路的一遍过（cpp -> MIR + 自检），**没有 OIR 这一层** ——
     * 拿 omni 那一套形态串去描述它就是编的（第一版就编了「omni（mixed）→ AST」，量出来了）。 */
    if (path.endsWith('.c')) {
      const p = newPlan(cmd, 'c → cpp → MIR（自检，不出产物）');
      addStage(p, { phase: 'front', verb: 'read', in: path });
      addStage(p, { phase: 'front', verb: 'cpp', in: 'text', out: 'tokens' });
      addStage(p, {
        phase: 'mid', verb: 'lower', in: 'tokens', out: 'MIR',
        note: '一遍过，没有 AST（路径 B，tccgen 等价物）',
      });
      addStage(p, { phase: 'mid', verb: 'verify', in: 'MIR', note: 'MIR 自检（verifyMir）' });
      addStage(p, { phase: 'back', verb: 'print', in: '一行摘要', out: 'text', artifact: 'stdout' });
      return p;
    }
    const p = newPlan(cmd, `${front.lang} → OIR（到此为止，不出产物）`);
    toOir(p, path, front);
    addStage(p, { phase: 'back', verb: 'print', in: '一行摘要', out: 'text', artifact: 'stdout' });
    return p;
  }

  if (cmd === 'interp') {
    const mir = rest.includes('--mir');
    const p = newPlan(cmd, `${front.lang} → OIR${mir ? ' → MIR' : ''} → interp`);
    toOir(p, path, front);
    if (mir) addStage(p, { phase: 'mid', verb: 'lower', in: 'OIR', out: 'MIR' });
    addStage(p, {
      phase: 'exec', verb: 'exec', in: mir ? 'MIR' : 'OIR',
      note: mir ? 'MIR 解释器（--mir）' : 'OIR 解释器；退出码 = 入口的返回值',
    });
    return p;
  }

  const form = KEY_TO_FORM[cmd];
  if (form === undefined) return null;
  const f = FORMS[form];
  /* `emit ast` 在没有 AST 的那一路上（`.sx`）说不通；`emit sx` 只对 asy/jnc 有意义
   * （它印的是「前端 -> 核心方言」那一步的文本）。这两格宁可回 null 让调用方明说，
   * 也不编一条看起来合理的管线出来。 */
  if (f.needAst === true && !front.ast) return null;
  if (f.needSx === true && !(path.endsWith('.asy') || path.endsWith('.jnc'))) return null;

  const p = newPlan(cmd, `${front.lang} → ${f.name}`);
  if (f.needSx === true) {
    /* 这一条**不到 OIR** —— 它就是前端那一步的文本，印完就停。 */
    addStage(p, { phase: 'front', verb: 'read', in: path });
    for (const s of front.steps.slice(0, 2)) addStage(p, { phase: 'front', ...s });
    addStage(p, {
      phase: 'back', verb: 'print', in: '核心方言文本', out: 'text', artifact: 'stdout',
      note: '与 lowerCoreSexpr 拿到的逐字节相同（行号可以直接对）',
    });
    return p;
  }
  toOir(p, path, front);
  if (form === 'mir') {
    addStage(p, { phase: 'mid', verb: 'lower', in: 'OIR', out: 'MIR' });
    addStage(p, {
      phase: 'back', verb: 'print', in: 'MIR', out: 'text', artifact: 'stdout',
      note: rest.includes('--bytes') ? '大小与每个函数的内容哈希（--bytes）' : '文本形式（快照比对对象）',
    });
    return p;
  }
  const NOTE = {
    c: rest.includes('--amalgamate') ? '整份运行时内联进一个文件（--amalgamate）' : '外挂运行时',
    spirv: `kernel = ${opt(rest, '--kernel', '（默认那一个）')}`,
  };
  addStage(p, {
    phase: 'back', verb: f.verb, in: f.from, out: f.name, note: NOTE[form], artifact: out ?? 'stdout',
  });
  return p;
}
