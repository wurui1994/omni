/* 聚合初始化器还没做到（`{…}` 与 `char s[] = "…"` 都要它）。 */
int main(void) {
  int a[3] = {1, 2, 3};
  return a[2];
}
