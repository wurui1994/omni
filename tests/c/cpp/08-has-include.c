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
