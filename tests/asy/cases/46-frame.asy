// frame：内建面里那一叠"已经定好尺寸的元素"。
//
// 每一行的期望值都是 `asy -noV` 量的（见 asy_builtins.asy 的 frame 那一段）：
// 空 frame 的 min/max/size 全是 (0,0)，描边之后按**笔宽的一半**外扩（默认笔宽 0.5）。
//
// 这里用 `_draw` 而不是 `draw`：`draw(frame,…)` 是 base 的 plain_filldraw.asy 给的
// （它要 nib/begingroup），`_draw` 才是内建那一层。

frame f;
write(empty(f));
write(min(f));
write(max(f));
write(size(f));

_draw(f, (0,0)--(10,20), currentpen);
write(empty(f));
write(min(f));
write(max(f));
write(size(f));

// 填充**不**按笔宽外扩（与 picture 那边同一条）
frame g;
fill(g, (0,0)--(4,0)--(4,3)--cycle, currentpen);
write(min(g));
write(max(g));

// add 把 src 的元素并进 dest —— **这一条这一刀问不了**：`add(frame,frame)` 还没写进
// 内建面（写了会与用户自己的 add 组成一个重载集，而"当值用的是哪一个"要靠期望类型定案，
// 见 asy_builtins.asy 里那一段）。真 asy 那边 `add(g,f)` 之后 max(g) 是 (10.25,20.25)。

// erase 之后又是空的
erase(g);
write(empty(g));
// 这里**不**问 erase 之后的 size：量过真 asy 那边 erase(g) 之后 empty(g) 是 true，
// 而 size(g) 还是擦之前的 (10.5,20.5) —— 它的 bbox 是缓存的，erase 没把缓存清掉。
// 那是实现细节（而且看着像个 bug），不照抄。
