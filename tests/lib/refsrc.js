// tests/lib/refsrc.js —— **参考源码树在哪儿**：一处说，别处引
//
// 这几条尺子（jnc-* / c/self*）要的语料不在这个仓库里：jancy、asymptote、tinycc、gsl-shell
// 的源码树是别人的项目，我们只**读**它们。先前每一份尺子各自写死一条 `/Users/wurui/…`，
// 于是同一件事有二十来个说法，换台机器全哑（而且哑得没声音 —— 那几份尺子的写法是
// "路径不存在就退回仓库内语料"，所以它只是**悄悄少量了**）。
//
// 现在的规矩，从紧到松：
//   1. 每一门自己那格环境变量（`JANCY` / `ASY_SRC` / `TINYCC_SRC` / `GSL_SRC`）—— 已有的名字不动；
//   2. `OMNI_REF_DIR`：那几棵树的**共同父目录**；
//   3. 缺省 `~/Documents/Lang/reference` —— 按 `os.homedir()` 拼，仓库里不留任何人的家目录。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/** 那几棵参考源码树的共同父目录。 */
export const REF_ROOT = process.env.OMNI_REF_DIR ?? join(homedir(), 'Documents', 'Lang', 'reference');

/**
 * 一棵参考源码树的路径。`envName` 是这一门自己那格环境变量（有就先听它）。
 * 只答"该在哪儿"，不问在不在 —— 在不在由调用方自己判（多半是"不在就退回仓库内语料"）。
 */
export function refDir(name, envName = null) {
  const v = envName === null ? undefined : process.env[envName];
  return v !== undefined && v !== '' ? v : join(REF_ROOT, name);
}

/** 在就答那条路径，不在答 `null`（"不在就退回仓库内语料"那一族的写法）。 */
export function refDirIf(name, envName = null) {
  const p = refDir(name, envName);
  return existsSync(p) ? p : null;
}

export const JANCY_DIR = refDir('jancy', 'JANCY');
export const TINYCC_DIR = refDir('tinycc', 'TINYCC_SRC');
export const ASY_DIR = refDir('asymptote', 'ASY_SRC');
export const GSL_DIR = refDir('gsl-shell', 'GSL_SRC');
