// 字段的默认值只看得见**前面**的字段：量过 asy 报 "no matching variable 'x'" 并退 1 ——
// 成员也是顺序解析的（与 strict/struct-fwd 是同一条规矩在 struct 体里的那一半）。
struct S { int y = x + 1; int x = 1; }
S s;
write(s.y);
