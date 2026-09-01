/* 少一个 #endif，但这一次少在**要编的**那一支上 —— tcc 在这两种情形下说的不是同一句话：
   跳过区域里读到文件末尾是「#endif expected」（见 missing-endif.c），
   而这里是文件读完时 ifdef 栈还没空，「missing #endif」。 */
#ifdef X
#else
int a = 1;
