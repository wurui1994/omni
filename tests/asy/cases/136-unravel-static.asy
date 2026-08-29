// `from T unravel x;` 里 x 也可以是 T 体里的一格 **static 成员**（不只是类型名）。
// static 那一格本来就是一个全局，所以摊出来就是往文件级挂**同一格** —— 改了它，
// `T.x` 那边看见的是同一个值。
// smoothcontour3.asy:35-38 那个"拿 struct 当命名空间"的写法靠这条
// （examples/genustwo.asy 与 genusthree.asy）。
struct T {
  static real ww = 1e-3;
  static int k = 7;
}

from T unravel ww;
from T unravel k;

write(ww);
write(k);
ww = 2.5;
write(T.ww);
T.k = 9;
write(k);
