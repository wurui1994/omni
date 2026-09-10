// src/plugin/lang-glsl.js —— GLSL 那一门的插件入口（ADR-0021 的 S4）

import { registerGlslLang } from '../core/lang/glsl.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniLangGlsl(api) {
  registerGlslLang(api);
  return true;
}
