// asy 自己就不收：`write` 有一堆重载，`null` 没有类型，定不下是哪一个 —— 量过 asy 报
// "call of function 'write(null)' is ambiguous"（4.6）。与 write-struct 那条同一件事：
// 诊断要出自 asy 这一层，不许漏成核心方言里的一句语法错。
struct A { int x; }
A a = null;
write(a == null);
write(null);
