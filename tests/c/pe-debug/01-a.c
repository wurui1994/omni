/* 两份都带 `-g` 的目标文件里的第一份 —— 冲的是 stab 字符串偏移要不要重新算
 * （ADR-0017 第九刀第六十九片）。 */

int shared_counter = 7;

int bump(int by)
{
  shared_counter += by;
  return shared_counter;
}

double scale(double x, int k)
{
  double r = x;
  for (int i = 0; i < k; i++) r *= 1.5;
  return r;
}
