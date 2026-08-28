// 第六十九刀：real 上的 `%`。mathop.h:244 的 mod<T> 走 mod.h:21 的 portableMod：
// 先 fmod，符号不跟着除数就加一个除数。plain_pens.asy:291 的 `(h % 360)/60` 在等它。
write(7.5 % 2);
write(-7.5 % 2);
write(7.5 % -2);
write(-7.5 % -2);
write(4.0 % 2);
write(-4.0 % 2);
write(0.5 % 1);
// int 那一份照旧（符号也跟着除数）
write(-7 % 3);
write(7 % -3);
// 一边是 int 时先提升到 real
real h = 725.5;
write((h % 360) / 60);
// 数组那一份走同一个体
real[] a = {7.5, -7.5, 0};
write(a % 2);
