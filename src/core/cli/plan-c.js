/**
 * C 那条腿的管线表（ADR-0018 决策五，分片 2）。
 *
 * 这一份**只造表、不干活**——所以 `--explain` 能做到「一个字节都不写盘、不执行」而说得准：
 * 它看的是与实现同一批开关（`--arch`/`--os`/`--format`/`-r`/`--shared`），推出来的形态串
 * 与真跑那一趟走的是同一条。
 *
 * 为什么先做 C 这一条：它是管线最长的那条（`c → cpp → MIR → x86_64 → ELF .o → 链接 → PE
 * .exe`），也是这个工程逐字节对着 tcc 量的那条 —— 「走了哪一路」在这儿最要紧。
 */

import { newPlan, addStage } from './stages.js';

/** 从 `rest` 里捞一个带值开关（实现那一侧也是这么捞的，保证两边看到同一个数）。
 *  不叫 `opt`：`frontend-engine/syntax.js` 里那格 `opt(...)` 是"语法里的可选项"，
 *  与这格取命令行开关不是一回事（拼成一个程序之后模块级名字共用一个空间）。 */
function cliOpt(rest, name, dflt) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
}

/** 这个目标上默认的容器格式。**注意**：tcc 的 `-c` 在所有目标上都写 ELF，所以这不是
 * 「OS 决定格式」——只是没给 `--format` 时的默认，给了就听给的。 */
function fmtOf(rest, os) {
  const f = cliOpt(rest, '--format', null);
  if (f !== null) return f;
  return os === 'osx' ? 'macho' : 'elf';
}

const CPU = { arm64: 'arm64', x86_64: 'x86_64' };

/** `-I`/`-D` 给了几个 —— 摘要里不印它们，清单行里印成 `-I×2 -D×1` 这种。 */
function cppNote(rest) {
  const n = (name) => rest.filter((a) => a === name).length;
  const parts = [];
  for (const f of ['-I', '-D', '-U', '-isystem', '-include']) {
    const k = n(f);
    if (k > 0) parts.push(k === 1 ? f : `${f}×${k}`);
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * 回一条管线，或者 `null`（这一条还没覆盖）。
 *
 * `cmd` 是命令树上那个 `key`（`cpp`/`c-mir`/`c-run`/`c-obj`/`elf-r`/`elf-link`/
 * `macho-link`/`pe-link`）。
 */
export function planForC(cmd, path, files, rest) {
  const arch = cliOpt(rest, '--arch', 'arm64');
  const os = cliOpt(rest, '--os', 'osx');
  const cpu = CPU[arch] ?? arch;
  const out = cliOpt(rest, '-o', undefined);
  const note = cppNote(rest);

  if (cmd === 'cpp') {
    const only = rest.includes('-dM') ? '宏表' : rest.includes('-dD') ? '正文 + 宏表' : '正文';
    const p = newPlan(cmd, `c → cpp → text（${only}）`);
    addStage(p, { phase: 'front', verb: 'read', in: path });
    addStage(p, {
      phase: 'front', verb: 'cpp', in: 'text', out: 'tokens',
      note: [`预定义宏按 ${arch}-${os}`, note].filter((x) => x !== undefined).join('，'),
    });
    addStage(p, {
      phase: 'front', verb: 'print', in: 'tokens', out: 'text',
      note: rest.includes('-P') ? '不印行标记（-P）' : '带行标记',
      artifact: 'stdout',
    });
    return p;
  }

  if (cmd === 'c-mir' || cmd === 'c-run') {
    const run = cmd === 'c-run';
    const p = newPlan(cmd, `c → cpp → MIR${run ? ' → interp' : ''}`);
    addStage(p, { phase: 'front', verb: 'read', in: path });
    addStage(p, { phase: 'front', verb: 'cpp', in: 'text', out: 'tokens', note });
    addStage(p, {
      phase: 'mid', verb: 'lower', in: 'tokens', out: 'MIR',
      note: '一遍过，没有 AST（路径 B，tccgen 等价物）',
    });
    if (run) {
      addStage(p, {
        phase: 'exec', verb: 'exec', in: 'MIR',
        note: `闭包解释器；退出码 = C main 的返回值；argv[0] = ${path}`,
      });
    } else addStage(p, { phase: 'back', verb: 'print', in: 'MIR', out: 'text', artifact: 'stdout' });
    return p;
  }

  if (cmd === 'c-obj') {
    const fmt = fmtOf(rest, os);
    const container = fmt === 'macho' ? 'Mach-O MH_OBJECT' : fmt === 'pe' ? 'COFF' : 'ELF ET_REL';
    const p = newPlan(cmd, `c → cpp → MIR → ${cpu} → ${fmt.toUpperCase()}(.o)`);
    addStage(p, { phase: 'front', verb: 'read', in: path });
    addStage(p, { phase: 'front', verb: 'cpp', in: 'text', out: 'tokens', note });
    addStage(p, {
      phase: 'mid', verb: 'lower', in: 'tokens', out: 'MIR',
      note: 'native：没有线性内存，地址就是真地址',
    });
    addStage(p, {
      phase: 'back', verb: 'codegen', in: 'MIR', out: cpu,
      note: os === 'win32' && cpu === 'x86_64' ? '代码节里还多一份共用的展开信息' : undefined,
    });
    addStage(p, {
      phase: 'back', verb: 'write', in: `${cpu} + 数据三段`, out: container,
      note: fmt === 'elf'
        ? `.text/.data/${os === 'win32' ? '.rdata' : '.data.ro'}/.bss`
        : '__text/__data（只读与 .bss 折进 __data 的尾巴）',
      artifact: out,
    });
    return p;
  }

  const LINK = {
    'elf-r': { fmt: 'elf', kind: '可重定位的 .o' },
    'elf-link': { fmt: 'elf', kind: rest.includes('--shared') ? '共享库' : '可执行' },
    'macho-link': { fmt: 'macho', kind: rest.includes('--shared') ? 'dylib' : '可执行' },
    'pe-link': { fmt: 'pe', kind: rest.includes('--shared') ? '.dll' : '.exe' },
  };
  if (LINK[cmd] !== undefined) {
    const { fmt, kind } = LINK[cmd];
    const n = files.length;
    const p = newPlan(cmd, `${n}×.o → merge → ${fmt.toUpperCase()}（${kind}）`);
    addStage(p, {
      phase: 'back', verb: 'read', in: `${n} 份目标文件`, out: 'sections + symbols',
      note: files.slice(0, 3).join(' ') + (n > 3 ? ` …（共 ${n} 份）` : ''),
    });
    if (cmd !== 'elf-r') {
      addStage(p, {
        phase: 'back', verb: 'resolve', in: 'undefined symbols', out: fmt === 'pe' ? 'idata + thunks' : 'got/plt',
        note: fmt === 'pe' ? '从 -L 找 .def 导入库' : undefined,
      });
    }
    addStage(p, {
      phase: 'back', verb: 'layout', in: 'sections', out: '地址',
      note: fmt === 'pe' ? 'text<rdata<data<bss<idata<pdata（按类重排，不按名字）' : '按节号',
    });
    addStage(p, { phase: 'back', verb: 'reloc', in: '每一条重定位' });
    addStage(p, {
      phase: 'back', verb: 'write', out: `${fmt.toUpperCase()}（${kind}）`, artifact: out,
    });
    return p;
  }

  return null;
}
