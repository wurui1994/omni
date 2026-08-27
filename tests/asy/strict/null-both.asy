// asy 自己就不收：两边都是 `null` 时重载解析定不下类型 —— 量过 asy 报
// "call of function 'operator ==(null, null)' is ambiguous"（4.11）。
// 这条守的是"记号不许漏出去"：`null` 在这一层是一个 code 为空的记号，
// 漏到核心方言里就是一句"表达式要写成一个 (…) 形式"，那句话指得完全不对。
struct A { int x; }
A a = null;
write(a == null);
write(null == null);
