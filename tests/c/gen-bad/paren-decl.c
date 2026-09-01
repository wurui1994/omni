/* 边界：**通过函数指针调用**。
 *
 * 第十二片把带括号的声明符做通了，所以 `int (*fp)(int)` 这个类型能声明、能取 sizeof、
 * 能当形参。少的是「调用它」与「取一个函数的地址」—— 那两件事都要 MIR 有**间接调用**：
 * 现在的 `CALL` 的 a 字段是函数表下标，是编译期常量（ir.js:211）。加一条 `CALLI`
 * （wasm 的 `call_indirect`）是独立的一片，而且它同时解锁 wasm 那条路上的函数表。 */
int twice(int x) { return x * 2; }

int main(void) {
  int (*fp)(int);
  fp = twice;
  return fp(3);
}
