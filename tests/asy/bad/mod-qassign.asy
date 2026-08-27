// 限定名当**赋值目标**（`m.x = …`）：asy 收（量过它改的就是模块里那一块），
// 我们这一刀只做了限定名的**读**。裸名字那条通的 —— 见 cases/28-import.asy 里的 bump。
import mod_v;
mod_v.mv = 7;
write(mv);
