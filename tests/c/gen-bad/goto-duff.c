/* 边界：标签长在里层的控制结构里（Duff's device 那种）。
 *
 * 「一个标签 = 关掉一层 block」要求标签直接长在它所在复合语句的语句层上；`half` 长在
 * `if` 里面，关掉一层会关错对象。与 `case` 那一条是同一个判断、同一个理由
 * （`labelStmt` / `caseLabel`）。 */
int main(void) {
  int i = 0;
  if (i == 0) half: i += 1;
  if (i == 1) goto half;
  return i;
}
