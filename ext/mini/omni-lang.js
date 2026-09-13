// ext/mini/omni-lang.js —— mini 这格扩展的入口（约定见 docs/EXTENSIONS.md）

import { Diagnostics, SourceFile, OmniError } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { basename } from '../../src/core/host/path.js';
import { lowerCoreSexpr } from '../../src/core/sexpr/lower.js';
import { parse, ParseError } from '../../src/core/frontend-engine/parse-driver.js';
import { LexError } from '../../src/core/frontend-engine/lexrules.js';
import { miniLang } from './lang.js';
import { lowerMini, MiniError } from './lower.js';

let API = null;

export function miniToSx(path) {
  const src = readText(path);
  try {
    return lowerMini(parse(src, miniLang));
  } catch (err) {
    if (err instanceof ParseError || err instanceof LexError || err instanceof MiniError) {
      throw new OmniError(`${basename(path)}: ${err.message}`);
    }
    throw err;
  }
}

export function compileMini(path) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${path}.sx`, miniToSx(path)), diags);
  diags.throwIfErrors();
  if (API !== null) API.log(`mini front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

export function registerMiniExt(api) {
  API = api;
  api.registerCap('mini.toSx', miniToSx);
  api.registerLang(['.mini'], 'mini', (path) => compileMini(path));
}
