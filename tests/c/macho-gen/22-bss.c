/* `.bss` 与 COMMON：Mach-O 里 `.bss` 是 `S_ZEROFILL` 的 `__bss`，落在 `__DATA` 里，
 * 文件里不占字节。COMMON 的符号要先在 `.bss` 里安家（`resolve_common_syms`）。 */

int zeros[16];
static long more[4];
int common_one;
int common_two;
char tail[3];

int main(void) {
  zeros[0] = 1;
  more[3] = 2;
  common_one = 3;
  common_two = 4;
  tail[2] = 5;
  return zeros[0] + (int) more[3] + common_one + common_two + tail[2];
}
