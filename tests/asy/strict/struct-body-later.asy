// struct 体里的语句也只看得见**前面**的成员：量过 asy 报 "no matching variable 'x'"
// 并退 1（与 strict/field-def-later 同一条规矩，只是这回是语句不是字段默认值）。
struct S { write(x); int x = 4; }
S s;
