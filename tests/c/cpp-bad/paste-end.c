/* `##` 不能在宏体的末尾（开头同理，同一句话） */
#define BAD(a) a ##
int x = BAD(1);
