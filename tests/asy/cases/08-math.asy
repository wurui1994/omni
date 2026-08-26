// 内建数学函数。返回类型是量出来的，不是猜的：floor/ceil/round 回 **int**
// （下面 `int i = floor(2.7)` 编得过就是证据），sqrt/fabs/fmod 回 real，
// abs 按实参分 int/real。`^` 有一边是 real 就走 pow。
write(sqrt(2));
write(fabs(-2.5));
write(abs(-2.5));
write(abs(-3));
write(floor(2.7));
write(floor(-2.5));
write(ceil(2.1));
write(round(2.5));
write(round(-2.5));   // C 的离零舍入：-3（JS 的 Math.round 会给 -2）
write(fmod(7.5, 2));
write(fmod(-7.5, 2));
write(2.0 ^ 3);
write(2 ^ 0.5);
write(sqrt(2) * sqrt(2) == 2.0);   // 不成立：浮点就是这样
int i = floor(2.7);
write(i);
real r = floor(2.7);
write(r);
// 内建函数的结果照常参与后面的运算，不是只能直接 write 掉
real sqrt2 = sqrt(2.0);
write(sqrt2 > 1.414 && sqrt2 < 1.415);
