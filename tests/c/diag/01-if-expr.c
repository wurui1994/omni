/* 第八刀第十九片：`#if` 的表达式坏了。
 * tcc 报的不是「哪儿坏了」，而是**展开之后的整条记号流**（`pp_error`，tccpp.c:1510）——
 * 那是对账时唯一有用的线索。行号也要对：`#if` 在第 8 行 —— 少了 `errLine` 那条减法
 * 就会报到第 9 行。 */
#define ZERO 0
#define NOPE(x) ZERO (x)

#if !ZERO || !NOPE(ZERO)
int a;
#endif

int main(void) { return 0; }
