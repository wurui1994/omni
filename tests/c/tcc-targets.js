// tests/c/tcc-targets.js —— tinycc 的十二个目标：每个目标编哪些源码、带哪些 `-D`
// （ADR-0017 第九刀第九十六片建的表，第九十九片挪出来共用）
//
// 抄的是 tinycc 自己的 `Makefile`：文件集在 `Makefile:201-219`（`CORE_FILES` 与
// `<target>_FILES`），宏在 `Makefile:100-120`（`DEF-<target>`）。
//
// `tcctools.c` **不在表里**：`tcc.c` 有一句 `#include "tcctools.c"`（`LIBTCC_SRC`
// 也把它与 `tcc.c` 一起滤掉了），单独编会撞 `duplicate symbol '_tcc_tool_ar'`。
//
// 两个门用这张表：
//   - `selfcross.js`：用**我们的编译器**把每个目标编出一副交叉 tcc
//   - `selfsrc.js`：用**我们编出来的 tcc** 去编这些源码，与尺子逐字节比

const CORE = ['tcc', 'libtcc', 'tccpp', 'tccgen', 'tccdbg', 'tccelf', 'tccasm', 'tccrun'];
const I386 = ['i386-gen', 'i386-link', 'i386-asm'];
const X64 = ['x86_64-gen', 'x86_64-link', 'i386-asm'];
const ARM = ['arm-gen', 'arm-link', 'arm-asm'];
const ARM64 = ['arm64-gen', 'arm64-link', 'arm64-asm'];
const ARM_DEF = ['-DTCC_TARGET_ARM', '-DTCC_ARM_VFP', '-DTCC_ARM_EABI', '-DTCC_ARM_HARDFLOAT'];

export const TCC_CORE = CORE;

/** 十二副。`files` 是**目标专属**那几份，整套源码是 `TCC_CORE` 加上它。 */
export const TCC_TARGETS = [
  { name: 'i386', files: I386, defs: ['-DTCC_TARGET_I386'] },
  { name: 'i386-win32', files: [...I386, 'tccpe'], defs: ['-DTCC_TARGET_I386', '-DTCC_TARGET_PE'] },
  { name: 'x86_64', files: X64, defs: ['-DTCC_TARGET_X86_64'] },
  { name: 'x86_64-win32', files: [...X64, 'tccpe'], defs: ['-DTCC_TARGET_X86_64', '-DTCC_TARGET_PE'] },
  { name: 'x86_64-osx', files: [...X64, 'tccmacho'], defs: ['-DTCC_TARGET_X86_64', '-DTCC_TARGET_MACHO'] },
  { name: 'arm', files: ARM, defs: ARM_DEF },
  { name: 'arm-wince', files: [...ARM, 'tccpe'], defs: [...ARM_DEF, '-DTCC_TARGET_PE'] },
  { name: 'arm64', files: ARM64, defs: ['-DTCC_TARGET_ARM64'] },
  { name: 'arm64-osx', files: [...ARM64, 'tccmacho'], defs: ['-DTCC_TARGET_ARM64', '-DTCC_TARGET_MACHO'] },
  { name: 'arm64-win32', files: [...ARM64, 'tccpe'], defs: ['-DTCC_TARGET_ARM64', '-DTCC_TARGET_PE'] },
  { name: 'riscv64', files: ['riscv64-gen', 'riscv64-link', 'riscv64-asm'], defs: ['-DTCC_TARGET_RISCV64'] },
  /* c67 那副 tinycc 自己都要 `-w`（它的代码生成器有一堆警告）。 */
  { name: 'c67', files: ['c67-gen', 'c67-link', 'tcccoff'], defs: ['-DTCC_TARGET_C67', '-w'] },
];

/** 一个目标的整套源码（不带路径、不带 `.c`）。 */
export function unitsOf(t) { return [...CORE, ...t.files]; }
