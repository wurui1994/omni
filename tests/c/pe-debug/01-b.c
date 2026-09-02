/* 第二份。它的 `.stab` 接在第一份后面，里面那些字符串偏移都要加上第一份
 * `.stabstr` 的长度 —— `tcc_load_object_file` 末尾那个 `a->n_strx += o`。 */

extern int shared_counter;
extern int bump(int by);
extern double scale(double x, int k);

struct point {
  int x;
  int y;
};

static struct point origin = { 1, 2 };

int main(void)
{
  struct point p = origin;
  int n = bump(p.x + p.y);
  return (int) scale((double) n, 2) + shared_counter;
}
