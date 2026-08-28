// 绘图层的第一刀：`size` / `draw` / `fill` / `shipout`，出来的是 **EPS 正文**
// （印到标准输出 —— 核心方言里还没有文件 IO，`(print …)` 是唯一的出口；
// 真 asy 那边是写文件，所以判分时比的是 EPS 正文，见 run.js 的 draw 那一节）。
//
// 这一份是**纯 asy 源码**：`pen`/`path`/`frame` 那一族在真 asy 里是运行时自带的
// C++ 内建面，在我们这边是 stage0/lib/asy/asy_builtins.asy，靠 OMNI_ASY_BUILTINS=1
// 隐式引进来。于是同一个文件两边都能跑，判分的人还是真 asy。
//
// 对上的都是量出来的：
//   * 坐标是 %.6g（psfile.h:160 `*out << " " << x`，ostream 默认 6 位有效数字）
//   * size(100) 解的是 s*w + 笔宽 = 100（下面这条 linewidth(2) 的线让横向多出 2，
//     所以 s = 0.98，100 宽的三角形出来是 98）
//   * 摆放：信纸 612x792 居中再各减 0.5，translate 把 bbox 左下角搬过去
//   * 描边按笔宽的一半外扩、**填充不外扩**（总高 79.4 = 78.4 + 1 就是这么来的）
//   * 笔的状态是增量发的（psfile.cc:242 的 setpen）：第二个元素只发变了的那几行
//   * 闭合路径末尾多一句回到起点的 lineto 再 closepath（psfile.h:295..312）
size(100);
fill((0, 0)--(100, 0)--(50, 80)--cycle, red);
draw((0, 0)--(100, 0), blue + linewidth(2));
shipout(currentpicture);
