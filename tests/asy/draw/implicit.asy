// 隐式 shipout：这一份**一行 shipout 都不写**，EPS 是退出时补出来的。
//
// 真 asy 那边这一条在 plain.asy:53-62：
//   void exitfunction() { implicitshipout=true; if(!currentpicture.empty()) shipout();
//                         implicitshipout=false; }
//   atexit(exitfunction);
// 而 plain_shipout.asy:104 那道 `if(settings.xasy || (!implicitshipout && defaultprefix))
// { …; return; }` 的门闩意味着**显式** `shipout(currentpicture)` 根本走不到落地那一步 ——
// 量过：显式 shipout 的文件里也只有一份 EPS，印出来的就是退出时这一次。
//
// 我们这边两件事凑齐才跑得到：
//   * asy_builtins.asy 里 `atexit(asy__implicitshipout)`（照 plain 那条，加了"印过没有"的旗子）
//   * 降级那一层在 `(main …)` 末尾插的 `asy__atexitrun()`（lower.js 的 chunk 尾巴）
// 没有后者的时候 atexit 只是把函数存进 asy__exitfn，**没有人调** —— 220 个例子于是
// 一张 EPS 都不出。这一份用例就是钉住那一句。
size(100);
fill((0, 0)--(100, 0)--(50, 80)--cycle, red);
draw((0, 0)--(100, 0), blue + linewidth(2));
