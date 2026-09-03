#!/usr/bin/env node
// src/cli.js —— 命令行的**入口**（ADR-0018）
//
// 这一份薄得有意：它只是「跑 omni」这件事的**稳定路径**。驱动住在 `src/core/cli.js`，
// 编译器那一整棵树也在 `src/core/` 下 —— 目录改名（`stage0/src` -> `src/core`、
// `stage0` -> `src`）之后，外面要记的路径就只有 `src/cli.js` 一条。
//
// 为什么不是直接把 `core/cli.js` 当入口：那一份现在既是驱动又是入口（文件末尾自己
// `setExitCode(main(procArgs()))`），于是它**不能被 import 而不执行**。把「取 argv、
// 定退出码、印错误」这几件**进程级**的事挪到这一层来，`core/cli.js` 就能被当普通模块
// 用（比如门里直接 `main([...])` 在进程内跑一趟，不必 spawn）。
//
// 那一步要连着把 62 处门的 `cli` 常量指过来，所以分开做：这一片先立入口，
// 挪 try/catch 与改门是下一片（ADR-0018 分片 3 之后）。
//
//   node src/cli.js --help
//   node src/cli.js c obj t.c -o t.o --arch x86_64 --os linux -f elf

import './core/cli.js';
