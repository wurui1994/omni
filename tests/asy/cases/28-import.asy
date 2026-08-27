// 模块（第二十五刀）。量过的语义一条一条钉在这里 —— 期望值是 `asy -noV` 给的：
//   - 模块体**在 import 那一行**跑（"two body" / "one body" 在 "main" 前面，
//     而 mod_two 的体在 mod_one 的体前面：那条 import 在 mod_one 的第一行）；
//   - 同一个模块只跑一遍（下面 import 了两次 mod_one，"one body" 只印一次）；
//   - import 进来的裸名字与 `模块.名字` 是**同一块存储**（bump 改的是 base 那一个）；
//   - import 是**传递的**（twice 是 mod_two 的，mod_one import 了它）；
//   - `access … as` 只给限定名，`from … access` 只带指名的那几个。
import mod_one;
import mod_one;
access mod_three as m3;
from mod_four access tag;

write("main");
write(base);
write(bump(5));
write(mod_one.base);
write(twice(4));
Box b = Box(7);
write(b.get());
write(m3.third);
write(m3.thrice(2));
write(tag());
