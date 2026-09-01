/* 相对的 include 按**这个头**所在的目录算，不是按最外层那个 .c */
#define OUTER_VALUE 20
#include "inner.h"
int outer_decl;
