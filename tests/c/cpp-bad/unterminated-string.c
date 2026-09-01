/* 字符串跨行：C 不允许（tcc 的 ACCEPT_LF_IN_STRINGS 是 0） */
char *s = "unterminated
;
