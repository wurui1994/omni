// 函数体里引用**后面**才声明的文件级变量：**asy 自己就不收**（量过 `asy -noV` 报
// "no matching variable of name 'g'"）。asy 的名字解析是顺序的，这一条与
// strict/forward-ref（函数）、strict/struct-fwd（类型名）是同一条规矩的第三处。
// 所以这份诊断不带 ASY_NOPE：不是还没做，是这个程序本来就不对。
int f() { return g; }
int g = 5;
write(f());
