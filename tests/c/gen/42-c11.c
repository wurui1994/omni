/* 第八刀第十八片：编 tinycc 自己的源码时撞上的那六格。
 *
 * 每一格都是先在 macOS 的系统头里撞到、再回头补的：
 *   `__has_include`      —— <Availability.h> 一进门就用
 *   `#pragma pack`       —— <sys/fcntl.h> 的 struct log2phys
 *   `_Static_assert`     —— <mach/message.h> 拿它钉住 mach 消息的尺寸
 *   匿名 struct/union    —— tinycc 自己的 SValue（tcc.h:488）
 *   常量表达式里的 `?:`  —— <sys/_types/_fd_def.h> 算 fd_set 的维度
 *   顶层多余的分号       —— <os/object.h> 那些宏在非 ObjC 下展开成空
 */
#include <stdio.h>

#if !defined(__has_include)
#error "__has_include 应该是有的"
#endif
#if !__has_include(<stdio.h>)
#error "找不到 <stdio.h>？"
#endif
#if __has_include(<no/such/header/at/all.h>)
#error "凭空找到了一份不存在的头"
#endif

;   /* 顶层多余的分号：读掉就算 */

/* 匿名成员：里面那两个名字**摊进外层** */
struct sv {
  int t;
  union {
    struct { int jtrue, jfalse; };
    long c;
  };
};

#pragma pack(push, 1)
struct packed1 {
  char a;
  int b;
  short c;
};
#pragma pack(4)
struct packed4 {
  char a;
  double b;
};
#pragma pack(pop)
struct plain {
  char a;
  int b;
  short c;
};

_Static_assert(sizeof(struct packed1) == 7, "pack(1) 该是 7 个字节");
_Static_assert(sizeof(struct packed4) == 12, "pack(4) 该是 12 个字节");
_Static_assert(sizeof(struct plain) == 12, "不 pack 该是 12 个字节");
_Static_assert(1 == 1, "");

#define howmany(x, y) ((((x) % (y)) == 0) ? ((x) / (y)) : (((x) / (y)) + 1))
/* 常量表达式里的 `?:`：数组维度 = howmany(1024, 32) = 32 */
static int bits[howmany(1024, sizeof(int) * 8)];

int main(void) {
  struct sv s;
  s.t = 3;
  s.jtrue = 7;
  s.jfalse = 9;
  printf("%d %d %d\n", s.t, s.jtrue, s.jfalse);
  s.c = 0x1234;
  printf("%ld %d\n", s.c, s.t);

  printf("%d %d %d\n", (int)sizeof(struct packed1), (int)sizeof(struct packed4),
    (int)sizeof(struct plain));
  printf("%d %d\n", (int)sizeof(bits) / (int)sizeof(bits[0]), (int)sizeof(struct sv));

  int n = 0;
  for (int i = 0; i < (int)(sizeof(bits) / sizeof(bits[0])); i++) {
    bits[i] = i;
    n += bits[i] % 3;
  }
  printf("%d\n", n);
  return (int)sizeof(struct packed1) + s.t + (n % 7);
}
