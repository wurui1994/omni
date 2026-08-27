// `access m;` 之后裸用模块里的 struct 当**数组元素**：量过 asy 报 "no type of name 'A'"
// —— `access` 只给限定名。与 strict/mod-access-bare（变量那半边）是同一条规矩。
access mod_m;
A[] a;
write(a.length);
