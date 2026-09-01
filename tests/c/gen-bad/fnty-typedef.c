/* 边界：**函数类型的 typedef**。
 *
 * 第十二片让声明符能造出函数类型、第十三片让函数指针能调用，可 `typedef int cb(int);`
 * 还差一格：这个名字之后能当**声明符的基本类型**用（`cb *p;`、甚至 `cb f;` 声明一个
 * 函数），于是 `decl` 里「这是函数定义吗」那一问要从 typedef 展开之后的类型上问。
 * tinycc 自己用的是 `typedef int (*cb)(int);`（指针形），那个已经能用。 */
typedef int cb(int);

int main(void) {
  cb *p;
  p = 0;
  return p == 0 ? 0 : 1;
}
