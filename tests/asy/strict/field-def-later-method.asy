// 字段的默认值也看不见**后面**的方法：量过 asy 报 "no matching variable 'f'" 并退 1。
// 这一条钉的是**理由**：漏到内建名单那一层会报出带 ASY_NOPE 的"内建函数 'f'"，
// 那是把"程序本来就不对"说成"我们还没做"。
struct S { int y = f(); int f() { return 7; } }
S s;
write(s.y);
