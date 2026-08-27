// 内建函数分两种：**宿主数学库里有的**（sin/cos/exp/log/atan… 走绑定表的 rmath 那一列，
// C 转手 libm、JS 转手 Math.*）和**宿主没有的**。`gamma` 是后者 —— C99 有 tgamma，
// 但 ECMA-262 的 Math 里没有对应的一个，要用就得自己实现一份让六条腿共用，这一刀不做。
// 「宿主没有」和「不做」要分得开：绑定表 builtins.tab 里 gamma 这一行是 `nope`，
// 见到就报错，报错里说清是哪一个。
write(gamma(2.5));
