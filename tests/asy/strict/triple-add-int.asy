// asy 自己就不收：没有 int/real 到 triple 的隐式转换（量过 `(1,2,3)+1` 报
// "no matching function 'operator +(triple, int)'"）。pair 那边**有**这条转换
// （`2+(1,2)` 是 (3,2)），所以这条边界是 triple 独有的。
write((1,2,3)+1);
