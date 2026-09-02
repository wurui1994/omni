/* 底下那一层。`__has_include_next(<next.h>)` 在这儿必须是**假** —— 后面没有第三层了。 */
#define NEXT_INNER 41
#if __has_include_next(<next.h>)
int no_third_layer = 1;
#else
int no_third_layer = 0;
#endif
