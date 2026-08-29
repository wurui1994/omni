// write 的实参不必**同型**：int 与 real 混着时那个 T 是 real（int -> real 一次提升）。
// tvgen.asy:912 的 `write(y*1000, round(R*1000), round(G*1000), round(B*1000))` 就是这一种。
// 别的类型仍旧要同型 —— 下面注掉那几行在 asy 那边都是 no matching function（量过）。
write(1.5,2,3,4);
write(1.5,2);
write(2,1.5);
write("s",1.5,2,3);
write("a",1);
write("a","b");
// pair 那一档更"宽"：int/real 补成 (v,0)
write((1,2),3);
write(3,(1,2));
// write(1,"a");        -> no matching function 'write(int, string)'
// write("a","b",1);    -> no matching function 'write(string, string, int)'
// write(1.5,(1,2,3));  -> no matching function 'write(real, triple)'
// write(true,1);       -> no matching function 'write(bool, int)'

// 模块别名的可见位置取**早**的那一次：声明遍是整个单元先走一趟，晚的那一句不该把
// 早的那一格盖掉（tvgen.asy:1047 的 `access settings;` 与第 27 行的 `settings.verbose`）。
import mod_one;
write(mod_one.bump(1));
access mod_one;
write(mod_one.bump(1));
