// 两个模块里同名的 struct：核心方言的 class 名、方法名、构造函数名都按记录名拼，
// 所以这一刀的 struct 名是**全局共享**的一个命名空间。asy 自己收，我们拒得明白。
import mod_dupa;
import mod_dupb;
write(1);
