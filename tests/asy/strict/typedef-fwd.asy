// typedef 的名字在声明**之前**用：asy 自己也拒 —— 量过 `asy -noV` 报
// "no type of name 'myint'"，与 strict/struct-fwd 是同一条规矩的另一半。
// 我们的别名表按声明下标存（一串 {t, at}，挑"此处可见的最后一份"），所以这一刀要裁；
// 不裁就是"比 asy 多接受一门语言"。这一条**不带** ASY_NOPE：不是还没做，是程序本来就不对。
myint n = 1;
typedef int myint;
write(n);
