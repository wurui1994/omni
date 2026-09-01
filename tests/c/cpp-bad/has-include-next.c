/* 阶段边界：`__has_include_next` 要「从当前这份头文件所在的那个搜索目录**之后**接着找」，
 * 也就是要给每份打开的文件记住它是在第几个 -I 里找到的。macOS 那套头文件一次都没用到它
 * （第十六片量过），所以这一格先钉住。 */
#if __has_include_next(<stddef.h>)
int a = 1;
#endif
