/* 少一个 #endif：文件读完的时候 ifdef 栈还没空 */
#ifdef SOMETHING
int a = 1;
