// src/lang/jnc/builtins.js —— jancy **不用 import 就在那儿**的名字（前奏那一层）
//
// 两族，都是抄的、都带出处：
//   1. 标准 typedef —— 编译器自己装上的 24 个（`jnc_ct_TypeMgr.cpp:1759-1782`
//      那一串 `setupStdTypedef`）。`size_t` / `string_t` / `uint_t` 那些就在这儿。
//   2. std 库的全局函数 —— `src/jnc_ext/jnc_std/jnc/std_globals.jnc` 顶层那一批
//      （`printf` 在 :554）。它们长在根命名空间里，所以裸写就能用。
//
// **不收**的：`io` / `ui` / `log` / `doc` / `std` 那几个命名空间。语料里它们是
// `import "io_base.jncx"` 来的 —— 那是导入表的活儿，混进"内建"就是把账做假。

/** 标准 typedef（jnc_ct_TypeMgr.cpp:1759-1782）。 */
export const STD_TYPEDEFS = [
  'variant_t', 'string_t', 'uint_t', 'intptr_t', 'uintptr_t', 'size_t',
  'int8_t', 'utf8_t', 'uint8_t', 'uchar_t', 'byte_t',
  'int16_t', 'utf16_t', 'uint16_t', 'ushort_t', 'word_t',
  'int32_t', 'utf32_t', 'uint32_t', 'dword_t',
  'int64_t', 'uint64_t', 'ulong_t', 'qword_t',
];

/** std 库根命名空间里的全局（std_globals.jnc 顶层，`printf` 在 :554）。 */
export const STD_GLOBALS = [
  'atod', 'atof', 'atoi', 'atol', 'format', 'getAllocSize', 'gets',
  'isalnum', 'isalpha', 'isdigit', 'islower', 'isprint', 'ispunct', 'isspace', 'isupper',
  'memcat', 'memchr', 'memcmp', 'memcpy', 'memcpy_u', 'memdjb2', 'memdup',
  'memmem', 'memmove', 'memmove_u', 'memset', 'memset_u',
  'perror', 'print', 'print_u', 'printf', 'rand', 'sort',
  'strcat', 'strchr', 'strcmp', 'strcpy', 'strdjb2', 'strdup', 'streq',
  'strichr', 'stricmp', 'stridjb2', 'strieq', 'stristr', 'strlen',
  'strncmp', 'strneq', 'strnicmp', 'strnieq', 'strpbrk', 'strrchr', 'strstr',
  'strtod', 'strtof', 'strtol', 'strtoul', 'tolower', 'toupper', 'LessFunc',
];

/** 前奏那一层的全部名字。 */
export const JNC_BUILTINS = [...STD_TYPEDEFS, ...STD_GLOBALS];
