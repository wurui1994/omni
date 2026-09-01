/* `__has_include`（第八刀第十八片）。macOS 的 <Availability.h> 一进门就用它，
 * 所以「读 SDK 的头」这条路上它是必需的一格。
 *
 * 与 tcc 逐字节比的是**输出**，也就是每个 `#if` 走了哪一支。用的都是
 * **相对这份源文件**的名字（`"..."` 的第一站是当前文件所在目录），于是两条腿
 * 找的是同一份东西 —— 系统头目录在这一组里没有给我们（见 run.js 的 `ours`）。 */
#if defined(__has_include)
int has_the_macro = 1;
#endif

#if __has_include("08-has-include.c")
int sees_itself = 1;
#else
int sees_itself = 0;
#endif

#if __has_include("no-such-file-here.h")
int nonsense = 1;
#else
int nonsense = 0;
#endif

#if __has_include(<no/such/thing.h>)
int angle_nonsense = 1;
#else
int angle_nonsense = 0;
#endif

/* 短路不成立：`#if` 的两侧**都**会被展开成记号，所以下面这一行两个都要能读过去 */
#if __has_include("08-has-include.c") && !__has_include("no-such-file-here.h")
int both = 1;
#endif

/* `#ifdef` / `#ifndef` 也认它（`tccpp.c:1850-1853`，与 `defined` 那一格同一条判断）。
 * 这一格是第八刀第二十一片补的：少了它，macOS 的 `<sys/cdefs.h>` 会走「这编译器
 * 没有 `__has_include`」那一支、把它 #define 成恒回 0 的宏 —— 从那以后 SDK 里
 * 每一处 `__has_include(...)` 都答「没有」，整份系统头的配置全变。 */
#ifdef __has_include
int ifdef_sees_it = 1;
#endif
#ifndef __has_include
int ifndef_sees_it = 1;
#endif
#ifdef __has_include_next
int ifdef_sees_next = 1;
#endif

/* 真的被 #define 掉之后，`#ifdef` 照样是真、而调用走那个宏 */
#define __has_include(x) 0
#if __has_include("08-has-include.c")
int after_redefine = 1;
#else
int after_redefine = 0;
#endif
