// src/core/host/kv6.js —— **KV6（Ken 的体素模型）解码器**，两台 JS 宿主设备共用一份
//
// `.kc` 那门语言的 `drawkv6("cow.kv6",scale,x,y,z,hang,vang)`（`evaldraw.txt:921`）要它。
// 语料里 23 份 `.kc` 用这一族（`demos/beer.kc`、`games/asteroids` …），资源 11 份
// （`~/Downloads/evaldraw/data/*.kv6`）。
//
// **格式是从资源本身验出来的**（evaldraw 没有源码，说明书也没写文件布局）：
//
//     "Kvxl"                          4 字节
//     xsiz, ysiz, zsiz                3 × int32
//     xpiv, ypiv, zpiv                3 × float32   模型的支点（画的时候减掉它）
//     numvoxs                         int32
//     numvoxs × { b,g,r,a, zpos:u16, vis:u8, nrm:u8 }        每格 8 字节
//     xsiz × int32                    xlen[x]    这一列（x）有几格体素
//     xsiz*ysiz × uint16              ylen[x][y] 这一根（x,y）有几格体素
//     可选 "SPal" + 768               SLAB6 的"建议调色板"（我们不用）
//
// 验的方式（四份资源都成立，这就是这一格的判据）：`xlen` 的和 = `ylen` 的和 = `numvoxs`，
// 而且尾巴正好是 `"SPal"` + 768 字节。**x 与 y 不在体素记录里**，要靠这两张游程表数出来 ——
// 记录里只有 z。
//
// 回的是**给语言那一侧用的扁平表**：一格体素四个 double `[x, y, z, 0xRRGGBB]`，
// 坐标**已经减掉支点**（支点是文件里的事，语言那一侧不该知道）。
//
// **这一份要过我们自己那台 JS 前端**（`gfx-cpu.js` 静态 import 它 ⇒ 它在 `src/cli.js` 那棵
// 树里，`npm run check:self` 与 `build:native` 都编它），所以**封闭 ABI 之外的东西一个都不能
// 用**：没有 `Float64Array`、也不能把 `Uint8Array` 当值用（`x instanceof Uint8Array`）。
// 于是 `vox` 是一格**普通数组**（一样按下标读）。要"按字节发出去"的那一位（`serve.js` 的
// `/api/kv6`）自己打包 —— 它是**另一个进程**（node 那一侧，不过我们的前端）。

/** 解码一份 KV6。`bytes` 是 Uint8Array；认不出来回 `null`（调用方当"读不到"）。 */
export function decodeKv6(bytes) {
  /* 不写 `bytes instanceof Uint8Array`：那要把 `Uint8Array` 当值用，而封闭 ABI 里它只有
     `new Uint8Array(…)` 那一格（见头注）。这一格要防的本来就只是"给错了东西/太短"。 */
  if (bytes === null || bytes === undefined) return null;
  if (typeof bytes.length !== 'number' || bytes.length < 32) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'Kvxl') return null;
  const xs = dv.getInt32(4, true);
  const ys = dv.getInt32(8, true);
  const zs = dv.getInt32(12, true);
  const px = dv.getFloat32(16, true);
  const py = dv.getFloat32(20, true);
  const pz = dv.getFloat32(24, true);
  const n = dv.getInt32(28, true);
  if (!(xs > 0 && ys > 0 && zs > 0 && n > 0)) return null;
  const need = 32 + n * 8 + xs * 4 + xs * ys * 2;
  if (bytes.length < need) return null;
  /* 两张游程表：先把 `ylen` 那一片读出来（`xlen` 只是它按 x 的和，不必再读一遍）。 */
  const yoff = 32 + n * 8 + xs * 4;
  /* 一格**普通数组**（不是 `Float64Array` —— 见头注）：下面按 `k*4` 顺着填，所以
     长度正好是 `k*4`（读不满时比 `n*4` 短，而调用方数的是 `n: k`）。 */
  const out = [];
  let k = 0;
  for (let x = 0; x < xs; x++) {
    for (let y = 0; y < ys; y++) {
      let cnt = dv.getUint16(yoff + (x * ys + y) * 2, true);
      while (cnt > 0 && k < n) {
        const o = 32 + k * 8;
        const b = bytes[o];
        const g = bytes[o + 1];
        const r = bytes[o + 2];
        const z = dv.getUint16(o + 4, true);
        out.push(x - px);
        out.push(y - py);
        out.push(z - pz);
        out.push((r << 16) | (g << 8) | b);
        k += 1;
        cnt -= 1;
      }
    }
  }
  return { xs, ys, zs, piv: [px, py, pz], n: k, vox: out };
}
