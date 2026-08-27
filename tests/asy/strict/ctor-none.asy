// struct 里没有 `void operator init(…)` 时 `A(…)` 不是构造调用 —— asy 自己也拒：
// 量过 `asy -noV` 报 "no matching variable 'A'"（记录名本身不是个函数）。
// 我们的理由与它不同（我们知道 A 是记录、只是没有构造函数），但都是拒，而且
// 这条**不带** ASY_NOPE：不是"还没做"，是这个程序本来就不对。
struct A { int x; }
A a = A(3);
write(a.x);
