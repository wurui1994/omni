/* `export default …`（`export default function f(){}` 解析出来也是**表达式**）：摊成一句
   `const <本模块专属的名字> = 表达式;`，导出表里记在 'default' 这一格；默认导入那一边
   再摊成 `const def = <那个名字>;`。名字带模块路径 —— 整棵树拼成一个程序，顶层名字共用。 */
export default function greet(who) {
  return `hi ${who}`;
}
export const sideBySide = 7;
