// pair 上要超越函数的那几个：angle / unit / dir / expi。
// 它们能落地是因为 rmath 的白名单是"宿主数学库的交集"（atan2/cos/sin 都在里面）——
// 这里没有自己写的实现，只有 asy 那几行的形状（见 lower.js 的 asy__pangle/punit/pexpi/pdir）。
// 契约同这一节其余用例：腿之间、与真 asy 都只要求最后一位十进制差不超过 1。
// 量出来的四条语义，每一条都在下面钉着：
//   angle((0,0)) 是**运行期错误**，angle(z,false) 给 0（所以第二个实参是 bool，默认 true）
//   unit((0,0)) 是 (0,0)（不是 nan：零点有一刀挡着）
//   dir 收的是**度**、expi 收的是**弧度**；dir(pair) 是 unit 的别名
//   dir(45) 的两个分量不对称（...548 / ...547）—— cos 与 sin 各自舍入，不是"算一个推另一个"
write(angle((1,1)));
write(angle((-1,0)));
write(angle((0,-1)));
write(angle((0,0),false));
write(dir(30));
write(dir(45));
write(dir(90));
write(dir((3,4)));
write(expi(0.5));
write(expi(3.0));
write(unit((3,4)));
write(unit((-3,-4)));
write(unit((0,0)));
write(unit((1,1)));
write(angle(unit((2,5))));
write(unit(dir(20)));
