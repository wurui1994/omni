// 第四十七刀：限定名当**赋值目标**（`m.x = …`）—— 改的就是模块里那一块，
// 所以裸名字读出来也是新值。base 里 plain.asy:13/265/367 与 plain_picture.asy:1694
// 都是这么改 settings 的。
import mod_v;
mod_v.mv = 7;
write(mv);
mv = 9;
write(mod_v.mv);
