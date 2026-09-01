/* <ctype.h> —— 只有我们真的 shim 了的那几个（ADR-0017 第八刀第七片）。
 * 身份与取舍见 stdio.h 头上那一节。
 *
 * 三件事：
 * - 收的是 `int`，**`EOF`（-1）是合法的输入**（C11 7.4 第 1 段）。范围外一概回 0。
 * - 回的只保证**非零**，不保证是 1（我们回 1，本机的 libc 也回 1，但别依赖它）。
 * - 只有 **"C" locale**。别的 locale 要一整套 locale 机制，而 tinycc 只用 C locale。
 *
 * 少了什么：`isblank`（C99 加的，`interp/libc.js` 里还没有）、宽字符那一族
 * （`<wctype.h>` 整份）。
 */
#ifndef _CTYPE_H
#define _CTYPE_H

int isalpha(int c);
int isdigit(int c);
int isalnum(int c);
int isspace(int c);
int isupper(int c);
int islower(int c);
int isxdigit(int c);
int ispunct(int c);
int isprint(int c);
int isgraph(int c);
int iscntrl(int c);

int toupper(int c);
int tolower(int c);

#endif /* _CTYPE_H */
