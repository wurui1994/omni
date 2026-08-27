// 模板模块（第一句是 `typedef import(T);`）**裸 import** —— asy 自己就拒：量过
// `asy -noV` 报 "templated module access requires template parameters"。
// 类型参数没有实参可绑，模块里的 `T` 根本不是一个类型，所以这不是"还没做"，
// 是这个程序本来就不对：这一条**不带** ASY_NOPE。
import mod_tplonly;
write(1);
