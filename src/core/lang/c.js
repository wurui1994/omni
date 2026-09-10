// src/core/lang/c.js —— C 前端那条腿的插件外壳（ADR-0021 的 S4）
//
// 与另外几门同一条规矩：**不 import cli.js**。这一份装的是"C 源码怎么变成 MIR"那一段，
// 以及它自己的**系统头怎么找**（SDK 根、`/usr/include`、随包带的那一份）—— 那是 C 特有的事，
// 别的语言一格都用不上。
//
// 写目标文件（cObj / relaSeq / ehFrameOf）**不**在这里：那是链接那一摊（以后的 omni-native），
// 与"C 这门语言"是两回事 —— 它只是 cMir 的一个下游。

import { OmniError } from '../source/diag.js';
import { join, dirname } from '../host/path.js';
import { env, isDir, installDir, readText, spawn, stderr } from '../host/native.js';
import { lowerC } from '../frontend-c/tccgen.js';
import { verifyMir } from '../mir/verify.js';

/* SDK 根找一次就记住（一趟里 spawn xcrun 那一下是几十毫秒，而系统头每个文件都要问一遍）。
   跟着 sdkRoot 一起住在这儿：它是这门语言"上哪找系统头"的状态，不是驱动的状态。 */
let sdkRootCache;

export function sdkRoot() {
  if (sdkRootCache !== undefined) return sdkRootCache;
  const roots = [];
  const fromEnv = env('SDKROOT');
  if (fromEnv !== undefined && fromEnv !== '') roots.push(fromEnv);
  roots.push('/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk');
  roots.push('/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform'
    + '/Developer/SDKs/MacOSX.sdk');
  for (const r of roots) {
    if (isDir(join(r, 'usr', 'include'))) {
      sdkRootCache = r;
      return r;
    }
  }
  let out = '';
  try {
    const [code, so] = spawn('xcrun', ['--show-sdk-path'], 'c');
    if (code === 0) out = so.trim();
  } catch {
    out = '';
  }
  sdkRootCache = out !== '' && isDir(out) ? out : null;
  return sdkRootCache;
}

export function sdkUsrInclude() {
  const r = sdkRoot();
  if (r === null) return null;
  const p = join(r, 'usr', 'include');
  return isDir(p) ? p : null;
}

/** SDK 的 `usr/lib` —— `-l` 找库的那一格，与 `tcc_add_macos_sdkpath` 找的同一处。 */
export function sdkUsrLib() {
  const r = sdkRoot();
  if (r === null) return null;
  const p = join(r, 'usr', 'lib');
  return isDir(p) ? p : null;
}

/**
 * C 前端的系统头目录，与 tcc 的 `sysinclude_paths` 同一形状：**自带那一份在前**
 * （tcc 的 `{B}/include`，我们是 `src/include` —— 位置与 `RUNTIME_DIR` 同一手法：
 * 相对程序镜像固定两级上去，于是不依赖当前工作目录），**本机 SDK 的
 * `/usr/include` 在后**（第八十八片）。`-isystem` 给的排在这两段前头，
 * `-nostdinc` 把这两段一起掐掉。
 *
 * `libDir` 给了就**换掉**自带那一份（`libDir/include`）—— 那是 tcc 的 `-B`
 * （`tcc_lib_path`）：tcc 里 `{B}/include` 就是自带那一份的位置，不是多一条。
 * SDK 那一段照留（tcc 的 `CONFIG_TCC_SYSINCLUDEPATHS` 也不受 `-B` 影响）。
 */
export function cSysInclude(libDir) {
  const out = [libDir === undefined ? join(installDir(), '..', '..', 'include')
    : join(libDir, 'include')];
  const sdk = sdkUsrInclude();
  if (sdk !== null) out.push(sdk);
  return out;
}

/**
 * 一份 `.c` -> MIR（ADR-0017 第六刀）。宿主回调与 `cppText` 同一套。
 * 良构检查在这里做完 —— 前端刚长出来，让 verifier 先骂比让解释器崩掉好查。
 */
export function cMir(path, incs, defs, args, sysIncs) {
  const { mod, warnings } = lowerC(path, readText(path), {
    readFile: (p) => {
      try {
        return readText(p);
      } catch {
        return null;
      }
    },
    includeDirs: incs,
    sysIncludeDirs: sysIncs ?? cSysInclude(),
    dirname,
    join,
  }, defs.map(([name, body]) => ({ name, body })), args);
  for (const w of warnings) stderr(`${w}\n`);
  const errs = verifyMir(mod);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  return mod;
}

/**
 * 登记（ADR-0021 的 S4）：C 这门语言交给驱动的那几格本事。
 *
 * 驱动**不许**直接 `import { cMir }` —— 只要还有一条直连，摇树就把这门语言整条拽进核心，
 * "核心不带 C 前端"就是空话（量出来的：--builtins min 只省 96 KB）。所以按名字给。
 * `.c` 不登记成"语言"：它由 `omni c` 那一组命令驱动（obj / tcc / mir 各有各的产物），
 * 不走"按扩展名认 -> 出 OIR"那条路。
 */
export function registerCLang(api) {
  api.registerCap('c.toMir', cMir);
  api.registerCap('c.sysInclude', cSysInclude);
  api.registerCap('c.usrLib', sdkUsrLib);
}
