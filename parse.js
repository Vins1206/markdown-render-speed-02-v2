// Fast Markdown renderer producing byte-identical HTML to marked 18.1.3
// with default options (GFM enabled). Pure Node stdlib, no dependencies.
// Two phases: block structure parsing with a container stack, then
// inline parsing with a delimiter stack.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s, codeMode) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!codeMode) {
        const m = matchEntityRef(s, i);
        if (m) {
          if (m.decoded !== null) rep = escapeDecodedChar(m.decoded);
          else rep = m.raw;
          if (rep !== null) {
            out += s.slice(last, i) + rep;
            i += m.raw.length - 1;
            last = i + 1;
            continue;
          }
        }
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  if (last === 0) return s;
  return out + s.slice(last);
}

function escapeDecodedChar(ch) {
  const r = ESC_MAP[ch];
  return r === undefined ? ch : r;
}

function decodeNumeric(value) {
  if (value === 0 || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) return '�';
  return String.fromCodePoint(value);
}

// At s[i] === '&'. Returns {raw, decoded} when the text forms a reference
// that stays unescaped: numeric references decode, named references pass
// through verbatim. Returns null when '&' must be escaped.
function matchEntityRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  if (s.charCodeAt(j) === 35) {
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const start = j;
      while (j < n && j - start < 6 && isHexDigit(s.charCodeAt(j))) j++;
      if (j > start && j < n && s[j] === ';') {
        return { raw: s.slice(i, j + 1), decoded: decodeNumeric(parseInt(s.slice(start, j), 16)) };
      }
      return null;
    }
    const start = j;
    while (j < n && j - start < 7 && isDigit(s.charCodeAt(j))) j++;
    if (j > start && j < n && s[j] === ';') {
      return { raw: s.slice(i, j + 1), decoded: decodeNumeric(parseInt(s.slice(start, j), 10)) };
    }
    return null;
  }
  if (isAlpha(s.charCodeAt(j))) {
    j++;
    while (j < n && isAlnum(s.charCodeAt(j))) j++;
    if (j < n && s[j] === ';') return { raw: s.slice(i, j + 1), decoded: null };
  }
  return null;
}

function isDigit(c) { return c >= 48 && c <= 57; }
function isHexDigit(c) { return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isSpaceCh(c) { return c === 32 || c === 9 || c === 10 || c === 13; }

// Percent-encode a link destination the way the reference does.
function cleanUrl(href) {
  try {
    const enc = encodeURI(href).replace(/%25/g, '%');
    const low = enc.toLowerCase();
    if (low.startsWith('javascript:') || low.startsWith('vbscript:') || low.startsWith('data:')) return '';
    return enc;
  } catch {
    return '';
  }
}

function unescapeString(s) {
  if (s.indexOf('\\') === -1) return s;
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// Inside link destinations and titles only backslash escapes are
// resolved; entity references pass through untouched.
function decodeLinkText(s) {
  return unescapeString(s);
}

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isPunct(ch) { return ch !== undefined && ASCII_PUNCT.indexOf(ch) !== -1; }

// Unicode-aware punctuation / whitespace tests for flanking rules.
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WHITE_RE = /\s/;
function isUnicodePunct(ch) {
  if (ch === undefined) return false;
  if (isPunct(ch)) return true;
  if (ch.charCodeAt(0) < 128) return false;
  return PUNCT_RE.test(ch);
}
function isUnicodeWhite(ch) {
  if (ch === undefined) return true;
  return WHITE_RE.test(ch);
}

// ---------------------------------------------------------------- blocks

function newBlock(t) {
  return {
    t, children: [], parent: null, open: true, lastLineBlank: false,
    str: '', level: 0, info: '', fenceCh: '', fenceLen: 0, htmlType: 0,
    listData: null, markerOffset: 0, padding: 0,
    header: null, aligns: null, rows: null,
  };
}

function appendChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

// Line cursor with virtual column tracking for tab expansion.
function makeCursor() { return { s: '', off: 0, col: 0, ptab: false }; }

function tabRemain(st) { return st.ptab ? 4 - (st.col % 4) : 0; }

function peekIndent(st) {
  let ind = tabRemain(st);
  let col = st.col + ind;
  const s = st.s;
  for (let i = st.off + (st.ptab ? 1 : 0); i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) { ind++; col++; }
    else if (c === 9) { const w = 4 - (col % 4); ind += w; col += w; }
    else break;
  }
  return ind;
}

function restBlank(st) {
  const s = st.s;
  for (let i = st.off; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Advance by a number of columns, possibly partially consuming a tab.
function advanceCols(st, count) {
  const s = st.s;
  while (count > 0 && st.off < s.length) {
    const c = s.charCodeAt(st.off);
    if (c === 9) {
      const w = 4 - (st.col % 4);
      if (count >= w) { st.col += w; st.off++; count -= w; st.ptab = false; }
      else { st.col += count; count = 0; st.ptab = true; }
    } else {
      st.col++; st.off++; count--; st.ptab = false;
    }
  }
  if (count > 0 && st.ptab) {
    // A partially consumed tab can absorb the rest of the request.
    st.col += 0;
  }
}

// Advance by raw characters (tabs count as a full tab stop).
function advanceChars(st, count) {
  const s = st.s;
  while (count > 0 && st.off < s.length) {
    const c = s.charCodeAt(st.off);
    if (c === 9) st.col += 4 - (st.col % 4);
    else st.col++;
    st.off++; count--; st.ptab = false;
  }
}

function restString(st) {
  const pre = st.ptab ? ' '.repeat(tabRemain(st)) : '';
  return pre + st.s.slice(st.off + (st.ptab ? 1 : 0));
}

// Expand tabs in the leading whitespace run of `str`, whose first
// character sits at column `col` (tab stops every 4). Mirrors marked's
// list-item line transform, which tab-expands each item line's leading
// whitespace before slicing off the item indent.
function expandLeadTabs(str, col) {
  let out = '';
  let c = col;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ') { out += ' '; c++; i++; }
    else if (ch === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; }
    else break;
  }
  return i === 0 ? str : out + str.slice(i);
}

function chainInList(b) {
  for (let p = b; p; p = p.parent) if (p.t === 'item') return true;
  return false;
}

// Marked's list gathering stops before a lazy line when the previous
// item-relative line was blank, was indented code, or itself begins a
// fence/heading/html/hr block.
function fencePrevBreaks(prev) {
  if (prev === undefined || prev === null) return false;
  if (/^[ \t]*$/.test(prev)) return true;
  let col = 0;
  let i = 0;
  while (i < prev.length) {
    const c = prev[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4; i++; }
    else break;
  }
  if (i < prev.length && col >= 4) return true;
  const rest = prev.replace(/^[ \t]+/, '');
  if (/^(`{3,}|~{3,})/.test(rest)) return true;
  if (/^#{1,6}([ \t]|$)/.test(rest)) return true;
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) return true;
  if (/^<(?:[A-Za-z]|\/|!--|\?|![A-Za-z]|!\[CDATA\[)/.test(rest)) return true;
  return false;
}

function saveCursor(st) { return { s: st.s, off: st.off, col: st.col, ptab: st.ptab }; }
function restoreCursor(st, sv) { st.s = sv.s; st.off = sv.off; st.col = sv.col; st.ptab = sv.ptab; }

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function matchBlockquoteMark(st) {
  if (peekIndent(st) > 3) return false;
  const sv = saveCursor(st);
  const ind = peekIndent(st);
  advanceCols(st, ind);
  if (st.ptab || st.s[st.off] !== '>') { restoreCursor(st, sv); return false; }
  advanceChars(st, 1);
  // Marked tab-expands the whitespace run after '>' (tab stops counted
  // from the marker's length within this container level) and only
  // then strips the marker plus one whitespace character. Rewrite the
  // line in that expanded form when the run contains a tab.
  const wsStart = st.off;
  let wsEnd = wsStart;
  while (wsEnd < st.s.length && (st.s[wsEnd] === ' ' || st.s[wsEnd] === '\t')) wsEnd++;
  const run = st.s.slice(wsStart, wsEnd);
  if (run.includes('\t')) {
    let col = ind + 1;
    let expanded = '';
    for (const ch of run) {
      if (ch === '\t') { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; }
      else { expanded += ' '; col++; }
    }
    st.s = st.s.slice(0, wsStart) + expanded + st.s.slice(wsEnd);
    if (expanded.length > 0) { st.off = wsStart + 1; st.col += 1; }
    st.ptab = false;
    return true;
  }
  const c = st.s[st.off];
  if (c === ' ' || c === '\t') advanceCols(st, 1);
  return true;
}

function matchItemIndent(st, item) {
  const need = item.markerOffset + item.padding;
  if (restBlank(st)) {
    if (item.children.length === 0) return false;
    st.off = st.s.length;
    return true;
  }
  if (peekIndent(st) < need) return false;
  advanceCols(st, need);
  return true;
}

// Parse a list marker at the cursor. Returns marker data or null.
// With `dry` the cursor is left untouched.
function scanListMarker(st0, dry) {
  const st = dry ? { s: st0.s, off: st0.off, col: st0.col, ptab: st0.ptab } : st0;
  const sv = saveCursor(st);
  const indent = peekIndent(st);
  if (indent > 3) return null;
  advanceCols(st, indent);
  if (st.ptab) { restoreCursor(st, sv); return null; }
  const s = st.s;
  const c = s[st.off];
  let data = null;
  let markerWidth = 0;
  if (c === '-' || c === '+' || c === '*') {
    advanceChars(st, 1);
    markerWidth = 1;
    data = { kind: 'bullet', bullet: c, start: 0, delim: '' };
  } else if (c >= '0' && c <= '9') {
    let num = 0; let digits = 0;
    while (digits < 9 && st.off < s.length && s[st.off] >= '0' && s[st.off] <= '9') {
      num = num * 10 + (s.charCodeAt(st.off) - 48);
      advanceChars(st, 1); digits++;
    }
    const d = s[st.off];
    if ((d === '.' || d === ')') && digits >= 1) {
      advanceChars(st, 1);
      markerWidth = digits + 1;
      data = { kind: 'ordered', bullet: '', start: num, delim: d };
    } else { restoreCursor(st, sv); return null; }
  } else { restoreCursor(st, sv); return null; }
  const after = s[st.off];
  if (after !== undefined && after !== ' ' && after !== '\t') { restoreCursor(st, sv); return null; }
  let spaces = 0;
  let lineBlankAfter = false;
  {
    const sv2 = saveCursor(st);
    while (st.off < s.length && (s[st.off] === ' ' || s[st.off] === '\t')) {
      const before = st.col;
      advanceCols(st, 1);
      spaces += st.col - before;
      if (spaces > 5) break;
    }
    lineBlankAfter = st.off >= s.length;
    restoreCursor(st, sv2);
  }
  let padding;
  if (lineBlankAfter || spaces > 4 || spaces === 0) {
    padding = markerWidth + 1;
    if (after === ' ' || after === '\t') advanceCols(st, 1);
  } else {
    padding = markerWidth + spaces;
    advanceCols(st, spaces);
  }
  data.markerOffset = indent;
  data.padding = padding;
  data.markerWidth = markerWidth;
  data.emptyAfter = lineBlankAfter;
  if (dry) return data;
  return data;
}

// Conditions for a list marker to interrupt an open paragraph.
function listInterruptsParagraph(st, textCtx) {
  const data = scanListMarker(st, true);
  if (!data) return null;
  // Inside a list item, marked lexes text tokens (not paragraphs), so
  // any list marker interrupts the text run. In paragraph context the
  // CommonMark restrictions apply (ordered lists must start at 1 and
  // an item may not be empty).
  if (textCtx) return data;
  if (data.kind === 'ordered' && data.start !== 1) return null;
  if (data.emptyAfter) return null;
  return data;
}

function listsMatch(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'bullet') return a.bullet === b.bullet;
  return a.delim === b.delim;
}

const HR_RE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_RE = /^(#{1,6})(?:[ \t]+|$)/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;

function scanThematicBreak(st) {
  if (peekIndent(st) > 3) return false;
  const rest = st.s.slice(st.off).replace(/^[ \t]+/, '');
  return HR_RE.test(rest);
}

function finalizeBlock(b) {
  b.open = false;
  if (b.t === 'code' && b.fenceCh) {
    // marked: the fence regex eats one trailing newline into the
    // closing match, and the code renderer re-adds exactly one when
    // the remaining text is non-empty and lacks one. Net effect:
    let t = b.str;
    if (t.endsWith('\n')) t = t.slice(0, -1);
    if (t !== '' && !t.endsWith('\n')) t += '\n';
    b.str = t;
  } else if (b.t === 'code') {
    // Strip trailing blank lines from indented code content.
    const lines = b.str.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let end = lines.length;
    while (end > 0 && /^[ \t]*$/.test(lines[end - 1])) end--;
    if (end === 0) b.str = lines.length > 0 ? '\n' : '';
    else b.str = lines.slice(0, end).join('\n') + '\n';
  } else if (b.t === 'list') {
    b.listData.tight = computeTight(b);
  }
}

function endsWithBlank(b) {
  if (b.lastLineBlank) return true;
  if ((b.t === 'list' || b.t === 'item') && b.children.length) {
    return endsWithBlank(b.children[b.children.length - 1]);
  }
  return false;
}

function computeTight(list) {
  const items = list.children;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (endsWithBlank(item) && i < items.length - 1) return false;
    const kids = item.children;
    for (let j = 0; j < kids.length; j++) {
      if (kids[j + 1] !== undefined && endsWithBlank(kids[j])) return false;
    }
  }
  return true;
}

const HTML_T1_RE = /^<(script|pre|style|textarea)(?=[\s>]|$)/i;
const HTML_T4_RE = /^<![A-Z]/;
const HTML_T6_RE = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s>]|\/>)/;
const HTML_T7_OPEN_RE = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>[ \t]*$/;
const HTML_T7_CLOSE_RE = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/;

// Detect an HTML block start on the cursor's remaining text.
// Returns {type, tag} or null. Does not move the cursor.
function scanHtmlBlockStart(st, allowType7) {
  if (peekIndent(st) > 3) return null;
  const rest = st.s.slice(st.off).replace(/^[ \t]+/, '');
  if (rest.charCodeAt(0) !== 60) return null;
  let m = HTML_T1_RE.exec(rest);
  if (m) return { type: 1, tag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2, tag: '' };
  if (rest.startsWith('<?')) return { type: 3, tag: '' };
  if (HTML_T4_RE.test(rest)) return { type: 4, tag: '' };
  if (rest.startsWith('<![CDATA[')) return { type: 5, tag: '' };
  m = HTML_T6_RE.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, tag: m[1].toLowerCase() };
  if (allowType7 && (HTML_T7_OPEN_RE.test(rest) || HTML_T7_CLOSE_RE.test(rest))) return { type: 7, tag: '' };
  return null;
}

function htmlEndsOnLine(b, line) {
  switch (b.htmlType) {
    case 1: return new RegExp('</' + b.info + '(\\s[^>]*)?>', 'i').test(line);
    case 2: return line.indexOf('-->') !== -1;
    case 3: return line.indexOf('?>') !== -1;
    case 4: return line.indexOf('>') !== -1;
    case 5: return line.indexOf(']]>') !== -1;
    default: return false;
  }
}

// Split a table row into cell strings, mirroring marked's de(): a pipe
// preceded by an odd number of backslashes stays a literal pipe, any
// other pipe becomes a separator; cells are then trimmed and any
// remaining \| sequences collapse to |.
function splitTableRow(line, count) {
  let t = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '|') {
      let bs = 0;
      for (let p = i - 1; p >= 0 && line[p] === '\\'; p--) bs++;
      t += bs % 2 === 1 ? '|' : ' |';
    } else t += c;
  }
  const cells = t.split(' |');
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    while (cells.length < count) cells.push('');
  }
  return cells.map(x => x.trim().replace(/\\\|/g, '|'));
}

function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

function parseDocument(src) {
  const doc = newBlock('document');
  const stack = [doc];
  const st = makeCursor();
  const lines = src === '' ? [] : src.split('\n');
  const srcNL = src.endsWith('\n');
  if (srcNL) lines.pop();
  let curLineHasNL = true;
  let curLine = 0;
  doc.totalLines = lines.length;
  // An html block (types 1-5) that just closed: if the very next line
  // is exactly empty within the same containers, marked's html regex
  // consumes that newline into the match and its ge() trim then drops
  // the block's trailing newline (recorded as stripTrailNL).
  let pendingHtmlStrip = null;

  const tip = () => stack[stack.length - 1];

  // Marked trimEnd()s the last item's text before lexing it: trailing
  // whitespace at the very end of a list's last item is not content.
  function trimItemTail(item) {
    let b = item;
    while (b && (b.t === 'item' || b.t === 'blockquote' || b.t === 'list')) {
      b = b.children[b.children.length - 1];
    }
    if (!b) return;
    if (b.t === 'paragraph' || b.t === 'html') b.str = b.str.trimEnd();
    else if (b.t === 'code') { b.str = b.str.trimEnd(); if (b.str) b.str += '\n'; }
  }

  function closeBlock() {
    const b = stack.pop();
    if (b.t === 'list' && b.children.length > 0) {
      trimItemTail(b.children[b.children.length - 1]);
    }
    // Container texts in marked (item text, blockquote chunks) end
    // without a trailing newline on their last line, so an html block
    // that is the container's last leaf loses the newline my line
    // model appended after its final line.
    if (b.t === 'item' || b.t === 'blockquote') {
      let leaf = b;
      while (leaf && leaf.children && leaf.children.length > 0) leaf = leaf.children[leaf.children.length - 1];
      if (leaf && leaf.t === 'html') leaf.stripTrailNL = true;
    }
    finalizeBlock(b);
    return b;
  }
  function closeDownTo(depth) {
    // Keep stack[0..depth-1]; close the rest.
    while (stack.length > depth && stack.length > 1) closeBlock();
  }
  function closeAbove(ancestor) {
    while (stack.length > 1 && tip() !== ancestor) closeBlock();
    if (tip() === ancestor && ancestor !== doc) { /* keep ancestor open */ }
  }
  function pushBlock(parent, b) {
    b.startLine = curLine;
    b.endLine = curLine;
    appendChild(parent, b);
    stack.push(b);
    return b;
  }

  // When containers did not all match, decide whether the line starts a
  // new block at the last matched container (so it is not a lazy
  // paragraph continuation).
  function startsBlockAtMatched(lm) {
    const clone = { s: st.s, off: st.off, col: st.col, ptab: st.ptab };
    if (matchBlockquoteMark(clone)) return true;
    if (peekIndent(st) <= 3) {
      const rest = st.s.slice(st.off).replace(/^[ \t]+/, '');
      if (ATX_RE.test(rest)) return true;
      const fm = FENCE_RE.exec(rest);
      if (fm && (fm[1][0] === '~' || fm[2].indexOf('`') === -1)) return true;
      if (scanHtmlBlockStart(st, false)) return true;
      if (HR_RE.test(rest)) return true;
    }
    if (lm.t === 'list') {
      const clone2 = { s: st.s, off: st.off, col: st.col, ptab: st.ptab };
      return scanListMarker(clone2, true) !== null;
    }
    return listInterruptsParagraph(st, false) !== null;
  }

  // Dry checks for paragraph interruption.
  function startsInterrupt(textCtx) {
    const clone = { s: st.s, off: st.off, col: st.col, ptab: st.ptab };
    if (matchBlockquoteMark(clone)) return true;
    if (peekIndent(st) <= 3) {
      const rest = st.s.slice(st.off).replace(/^[ \t]+/, '');
      if (ATX_RE.test(rest)) return true;
      const fm = FENCE_RE.exec(rest);
      if (fm && (fm[1][0] === '~' || fm[2].indexOf('`') === -1)) return true;
      if (scanHtmlBlockStart(st, false)) return true;
      if (HR_RE.test(rest)) return true;
    }
    if (listInterruptsParagraph(st, textCtx)) return true;
    return false;
  }

  function trySetext(para) {
    if (peekIndent(st) > 3) return false;
    const rest = st.s.slice(st.off).replace(/^[ \t]+/, '');
    const m = SETEXT_RE.exec(rest);
    if (!m) return false;
    // Reference definitions at the start of the paragraph are separate
    // tokens in marked: they never join a setext heading. Strip them
    // (kept aside for the extraction pass); if nothing else remains,
    // the underline is plain paragraph text instead.
    {
      let pos = 0;
      const tmp = new Map();
      while (pos < para.str.length) {
        const e = scanRefDef(para.str, pos, tmp);
        if (e < 0) break;
        pos = e;
      }
      if (pos > 0) {
        const restText = para.str.slice(pos);
        if (restText === '') return false;
        para._defPrefix = para.str.slice(0, pos);
        para.str = restText;
        if (para._chunkStart) {
          const nl = (para._defPrefix.match(/\n/g) || []).length;
          para._chunkStart = Math.max(0, para._chunkStart - nl);
        }
      }
    }
    const level = m[1][0] === '=' ? 1 : 2;
    const trim = (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    const start = para._chunkStart || 0;
    if (start > 0) {
      const plines = para.str.split('\n');
      if (start < plines.length) {
        // Only the current quote-chunk portion of the paragraph forms
        // the heading; earlier lines stay a paragraph of their own.
        const headText = trim(plines.slice(start).join('\n'));
        para.str = plines.slice(0, start).join('\n');
        closeBlock();
        const h = appendChild(para.parent, newBlock('heading'));
        h.startLine = curLine; h.endLine = curLine;
        h.level = level;
        h.str = headText;
        h.open = false;
        return true;
      }
    }
    para.t = 'heading';
    para.level = level;
    para.str = trim(para.str);
    closeBlock();
    return true;
  }

  function tryTable(para) {
    const delim = restString(st).trim();
    if (delim.indexOf('-') === -1) return false;
    const aligns = parseDelimiterRow(delim);
    if (!aligns) return false;
    const plines = para.str.split('\n');
    const headerLine = plines[plines.length - 1];
    if (headerLine.indexOf('|') === -1) return false;
    const header = splitTableRow(headerLine);
    if (header.length !== aligns.length) return false;
    if (plines.length > 1) {
      para.str = plines.slice(0, -1).join('\n');
      closeBlock();
      const tb = pushBlock(para.parent, newBlock('table'));
      tb.header = header; tb.aligns = aligns; tb.rows = [];
    } else {
      para.t = 'table';
      para.header = header; para.aligns = aligns; para.rows = [];
      para.str = '';
    }
    return true;
  }

  // Run the block-start loop at `container`. Returns the container that
  // should receive any remaining text (a leaf) or the deepest container.
  function blockStarts(container) {
    while (true) {
      if (restBlank(st)) return container;
      if (container.t === 'list') {
        // A thematic break ends the list (marked checks hr before
        // each item); anything else that is not an item closes it too.
        if (scanThematicBreak(st)) {
          closeBlock();
          container = container.parent;
          continue;
        }
        const data = scanListMarker(st, true);
        if (data && listsMatch(container.listData, data)) {
          scanListMarker(st, false);
          const item = pushBlock(container, newBlock('item'));
          item.markerOffset = data.markerOffset;
          item.padding = data.padding;
          container = item;
          continue;
        }
        closeBlock();
        container = container.parent;
        continue;
      }
      // Block quote.
      {
        const sv = saveCursor(st);
        if (matchBlockquoteMark(st)) {
          container = pushBlock(container, newBlock('blockquote'));
          container._lineQuoted = true;
          container._prevQuoted = false;
          continue;
        }
        restoreCursor(st, sv);
      }
      const indent = peekIndent(st);
      if (indent <= 3) {
        const restRaw = st.s.slice(st.off);
        const rest = restRaw.replace(/^[ \t]+/, '');
        // ATX heading.
        const am = ATX_RE.exec(rest);
        if (am) {
          advanceCols(st, indent);
          advanceChars(st, restRaw.length - rest.length - indent >= 0 ? 0 : 0);
          // Move cursor to just after the '#' run.
          st.off = st.s.length - rest.length + am[1].length;
          st.col += 0;
          let content = rest.slice(am[0].length);
          content = content.replace(/[ \t]+$/, '');
          const closeM = /[ \t]+#+$/.exec(content);
          if (closeM) content = content.slice(0, content.length - closeM[0].length);
          else if (/^#+$/.test(content)) content = '';
          content = content.replace(/^[ \t]+/, '');
          const h = appendChild(container, newBlock('heading'));
          h.startLine = curLine; h.endLine = curLine;
          h.level = am[1].length;
          h.str = content;
          h.open = false;
          return h;
        }
        // Fenced code.
        const fm = FENCE_RE.exec(rest);
        if (fm && (fm[1][0] === '~' || fm[2].indexOf('`') === -1)) {
          const code = pushBlock(container, newBlock('code'));
          code.fenceCh = fm[1][0];
          code.fenceLen = fm[1].length;
          code.markerOffset = indent;
          // marked's Dt compensation: for backtick fences, content
          // lines lose up to N leading whitespace CHARACTERS, where N
          // is the character length of the whitespace run directly
          // before the opening fence in the (container-relative) raw.
          code.compChars = fm[1][0] === '`' ? restRaw.length - rest.length : 0;
          code.inList = chainInList(container);
          code._prevRel = ' '.repeat(indent) + rest;
          code.info = unescapeString(fm[2].trim());
          return code;
        }
        // HTML block.
        const hb = scanHtmlBlockStart(st, true);
        if (hb) {
          const h = pushBlock(container, newBlock('html'));
          h.htmlType = hb.type;
          h.info = hb.tag;
          h.str = restString(st) + (curLineHasNL ? '\n' : '');
          if (hb.type <= 5 && htmlEndsOnLine(h, st.s)) { closeBlock(); pendingHtmlStrip = h; }
          return h;
        }
        // Thematic break.
        if (HR_RE.test(rest)) {
          const hr = appendChild(container, newBlock('hr'));
          hr.startLine = curLine; hr.endLine = curLine;
          hr.open = false;
          st.off = st.s.length;
          return hr;
        }
      }
      // List item.
      {
        const data = scanListMarker(st, true);
        if (data) {
          let listBlock;
          if (container.t === 'list' && listsMatch(container.listData, data)) {
            listBlock = container;
          } else if (container.t === 'list') {
            closeBlock();
            container = container.parent;
            listBlock = pushBlock(container, newBlock('list'));
            listBlock.listData = { kind: data.kind, bullet: data.bullet, start: data.start, delim: data.delim, tight: true };
          } else {
            listBlock = pushBlock(container, newBlock('list'));
            listBlock.listData = { kind: data.kind, bullet: data.bullet, start: data.start, delim: data.delim, tight: true };
          }
          scanListMarker(st, false);
          const item = pushBlock(listBlock, newBlock('item'));
          item.markerOffset = data.markerOffset;
          item.padding = data.padding;
          container = item;
          continue;
        }
      }
      // Indented code.
      if (peekIndent(st) >= 4) {
        advanceCols(st, 4);
        const code = pushBlock(container, newBlock('code'));
        code.inList = chainInList(container);
        code.str = (code.inList ? expandLeadTabs(restString(st), st.col) : restString(st)) + '\n';
        return code;
      }
      // Paragraph.
      const p = pushBlock(container, newBlock('paragraph'));
      p.str = restString(st);
      return p;
    }
  }

  function blankLine(lastMatched) {
    if (lastMatched) {
      lastMatched.lastLineBlank = true;
      const kids = lastMatched.children;
      if (kids.length) kids[kids.length - 1].lastLineBlank = true;
    }
  }

  let prevRawBlank = false;
  for (let li = 0; li < lines.length; li++) {
    st.s = lines[li]; st.off = 0; st.col = 0; st.ptab = false;
    curLine = li;
    curLineHasNL = li < lines.length - 1 || srcNL;
    // A container's span ends with a blank line iff the last line it
    // was open for was raw-blank; refresh container flags from the
    // previous line before this line is processed. (Leaf blocks get
    // their flags from their own blank-line branches instead: blank
    // lines inside a fence are content, not span ends.)
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.t === 'blockquote' || b.t === 'list' || b.t === 'item') b.lastLineBlank = prevRawBlank;
    }
    prevRawBlank = /^[ \t]*$/.test(lines[li]);
    // Roll blockquote chunk state: last line's quoted flag becomes the
    // previous-line flag consulted by lazy-line handling below.
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.t === 'blockquote') { b._prevQuoted = b._lineQuoted; b._lineQuoted = false; }
    }
    // Phase 1: match open containers.
    let lastMatched = doc;
    let allMatched = true;
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.t === 'blockquote') {
        if (!matchBlockquoteMark(st)) { allMatched = false; break; }
        b._lineQuoted = true;
        lastMatched = b;
      } else if (b.t === 'item') {
        if (!matchItemIndent(st, b)) { allMatched = false; break; }
        lastMatched = b;
      } else if (b.t === 'list') {
        lastMatched = b;
      } else {
        break; // leaf block: containers above it are matched.
      }
    }
    let cur = tip();
    const blank = restBlank(st);

    if (pendingHtmlStrip) {
      const hb = pendingHtmlStrip;
      pendingHtmlStrip = null;
      if (blank && restString(st) === '') {
        let ok = false;
        for (let p = lastMatched; p; p = p.parent) if (p === hb.parent) { ok = true; break; }
        if (ok) hb.stripTrailNL = true;
      }
    }

    // Fenced code leaf.
    if (cur.t === 'code' && cur.fenceCh) {
      if (allMatched) {
        const ind = peekIndent(st);
        const rest = st.s.slice(st.off).replace(/^[ \t]+/, '');
        const closeRe = cur.fenceCh === '`' ? /^(`{3,})[ \t]*$/ : /^(~{3,})[ \t]*$/;
        const cm = ind <= 3 ? closeRe.exec(rest) : null;
        if (cm && cm[1].length >= cur.fenceLen) {
          closeBlock();
        } else {
          const rel = restString(st);
          const leadWs = /^[ \t]*/.exec(rel)[0].length;
          const stripN = Math.min(leadWs, cur.compChars || 0);
          let txt = rel.slice(stripN);
          if (cur.inList && stripN < leadWs) {
            let c = st.col;
            for (let q = 0; q < stripN; q++) c += rel[q] === '\t' ? 4 - (c % 4) : 1;
            txt = expandLeadTabs(txt, c);
          }
          cur.str += txt + '\n';
          cur._prevRel = rel;
        }
        continue;
      }
      // Lazy continuation: a line that fails the item indent but does
      // not start a new block is gathered into the item text by
      // marked's list tokenizer, so the fence swallows it raw — unless
      // the previous item-relative line was blank, indented code, or
      // itself begins a fence/heading/html/hr (then gathering stops).
      const failedIdx = stack.indexOf(lastMatched) + 1;
      const failed = stack[failedIdx];
      if (failed && failed.t === 'item' && !blank &&
          !startsBlockAtMatched(lastMatched) && !fencePrevBreaks(cur._prevRel)) {
        const rel = restString(st);
        const leadWs = /^[ \t]*/.exec(rel)[0].length;
        cur.str += rel.slice(Math.min(leadWs, cur.compChars || 0)) + '\n';
        cur._prevRel = rel;
        continue;
      }
      // Otherwise the fence is closed as unmatched below.
    }
    // Indented code leaf.
    if (cur.t === 'code' && !cur.fenceCh && allMatched) {
      if (peekIndent(st) >= 4) {
        advanceCols(st, 4);
        cur.str += (cur.inList ? expandLeadTabs(restString(st), st.col) : restString(st)) + '\n';
        continue;
      }
      if (blank) {
        cur.str += '\n';
        cur.lastLineBlank = true;
        continue;
      }
      closeBlock();
      cur = tip();
      // Fall through with attach at the code block's parent.
      const attach = cur;
      if (blank) { blankLine(lastMatched); continue; }
      blockStarts(attach);
      continue;
    }
    // HTML block leaf.
    if (cur.t === 'html' && allMatched) {
      if (cur.htmlType >= 6 && blank) {
        cur.lastLineBlank = true;
        cur.stripTrailNL = true;
        closeBlock();
        blankLine(lastMatched);
        continue;
      }
      cur.str += restString(st) + (curLineHasNL ? '\n' : '');
      cur.endLine = curLine;
      if (cur.htmlType <= 5 && htmlEndsOnLine(cur, st.s)) { const hb3 = cur; closeBlock(); pendingHtmlStrip = hb3; }
      continue;
    }
    // Table leaf.
    if (cur.t === 'table' && allMatched) {
      // Marked's row capture excludes only spaces-only lines (a line
      // holding just a tab is a row of empty cells), lines that begin
      // an indented code block, and lines beginning hr/heading/quote/
      // fence/list/html blocks.
      const restStr = restString(st);
      if (/^ *$/.test(restStr)) {
        cur.lastLineBlank = true;
        closeBlock();
        blankLine(lastMatched);
        continue;
      }
      const clone = { s: st.s, off: st.off, col: st.col, ptab: st.ptab };
      let interrupts = false;
      if (peekIndent(st) >= 4 && /[^ \t]/.test(restStr)) {
        interrupts = true;
      } else if (peekIndent(st) <= 3) {
        const rest = st.s.slice(st.off).replace(/^[ \t]+/, '');
        if (ATX_RE.test(rest) || HR_RE.test(rest)) interrupts = true;
        const fm = FENCE_RE.exec(rest);
        if (fm && (fm[1][0] === '~' || fm[2].indexOf('`') === -1)) interrupts = true;
        if (matchBlockquoteMark(clone)) interrupts = true;
        if (scanHtmlBlockStart(st, false)) interrupts = true;
        if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(restStr)) interrupts = true;
      }
      if (!interrupts) {
        cur.rows.push(splitTableRow(restStr, cur.header.length));
        continue;
      }
      closeBlock();
      blockStarts(tip());
      continue;
    }
    // Paragraph leaf.
    if (cur.t === 'paragraph') {
      if (blank) {
        // A whitespace-only line at the very end of the input is
        // paragraph text in marked (its paragraph capture reaches EOF,
        // so the line is not a blank separator there): append whatever
        // whitespace remains after the containers.
        if (allMatched && li === lines.length - 1) {
          let content = restString(st);
          if (/^[ \t]+$/.test(content)) {
            let col = st.col;
            let expanded = '';
            for (const ch of content) {
              if (ch === '\t') { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; }
              else { expanded += ch; col++; }
            }
            cur.str += '\n' + expanded;
            continue;
          }
        }
        cur.lastLineBlank = true;
        closeBlock();
        if (!allMatched) closeAbove(lastMatched);
        blankLine(lastMatched);
        continue;
      }
      if (allMatched) {
        if (tryTable(cur)) continue;
        if (trySetext(cur)) continue;
        if (startsInterrupt(cur.parent && cur.parent.t === 'item')) {
          closeBlock();
          blockStarts(tip());
          continue;
        }
      } else if (startsBlockAtMatched(lastMatched)) {
        closeAbove(lastMatched);
        blockStarts(tip());
        continue;
      }
      // Plain or lazy continuation.
      let lineText;
      if (cur.parent && cur.parent.t === 'blockquote') {
        // Marked re-lexes blockquotes in chunks: a lazy line right after
        // a quoted line starts a fresh chunk (its leading code indent is
        // stripped like a code token merging into the paragraph), while
        // a setext-shaped lazy line later in a chunk is defused by
        // padding it with four spaces.
        const Q = cur.parent;
        const quotedQ = !!Q._lineQuoted;
        let chunkFirst = false;
        if (!quotedQ && Q._prevQuoted) {
          cur._chunkStart = cur.str.split('\n').length;
          chunkFirst = true;
        }
        if (chunkFirst && peekIndent(st) >= 4) advanceCols(st, 4);
        lineText = restString(st);
        if (!quotedQ && !chunkFirst && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lineText)) {
          lineText = '    ' + lineText.replace(/^ {0,3}/, '');
        }
      } else {
        // A lazy line (containers unmatched) loses four columns of
        // indentation when it has them.
        if (!allMatched && peekIndent(st) >= 4) advanceCols(st, 4);
        lineText = restString(st);
      }
      cur.str += '\n' + lineText;
      continue;
    }
    // Containers / doc at tip.
    if (!allMatched) closeAbove(lastMatched);
    if (blank) { blankLine(lastMatched); continue; }
    blockStarts(tip());
  }

  closeDownTo(1);
  return doc;
}

// ------------------------------------------------- link reference defs

function normalizeLabel(raw) {
  // Marked's label fold: collapse whitespace, then lower->upper->lower
  // (the roundtrip folds ß/ẞ to ss). Backslash escapes stay raw.
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Scan a link label starting at s[i] === '['. Returns {raw, end} where
// end is the index just past ']', or null.
function scanLinkLabel(s, i) {
  let j = i + 1;
  let raw = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { raw += s.slice(j, j + 2); j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') {
      if (raw.length > 999) return null;
      return { raw, end: j + 1 };
    }
    raw += c; j++;
  }
  return null;
}

// Scan a link destination starting at index i. Returns {raw, end} or null.
function scanLinkDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    let raw = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\n') return null;
      if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { raw += s.slice(j, j + 2); j += 2; continue; }
      if (c === '<') return null;
      if (c === '>') return { raw, end: j + 1 };
      raw += c; j++;
    }
    return null;
  }
  let j = i;
  let raw = '';
  let depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { raw += s.slice(j, j + 2); j += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    if (c === '<' || c === '>') return null;
    if (c === '(') depth++;
    if (c === ')') { if (depth === 0) break; depth--; }
    raw += c; j++;
  }
  if (depth !== 0) return null;
  return { raw, end: j };
}

// Scan a link title starting at index i. Returns {raw, end} or null.
function scanLinkTitle(s, i) {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  let raw = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { raw += s.slice(j, j + 2); j += 2; continue; }
    if (open === '(' && c === '(') return null;
    if (c === close) return { raw, end: j + 1 };
    raw += c; j++;
  }
  return null;
}

// Skip inline whitespace (spaces, tabs, newlines) but not a blank line.
// Returns the new index, or -1 if a blank line is crossed.
function skipInlineWs(s, i) {
  let newlines = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') i++;
    else if (c === '\n') {
      newlines++;
      if (newlines > 1) return -1;
      i++;
    } else break;
  }
  return i;
}

// Try to parse one reference definition at position i of a paragraph's
// text. Returns the index just past the definition (including its line
// ending) or -1.
function scanRefDef(s, i, refs) {
  let j = i;
  let cols = 0;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t') && cols < 3) { j++; cols++; }
  if (s[j] !== '[') return -1;
  const lab = scanLinkLabel(s, j);
  if (!lab) return -1;
  if (lab.raw.trim() === '') return -1;
  j = lab.end;
  if (s[j] !== ':') return -1;
  j++;
  j = skipInlineWs(s, j);
  if (j < 0) return -1;
  const dest = scanLinkDest(s, j);
  if (!dest) return -1;
  if (dest.raw === '' && s[j] !== '<') return -1;
  j = dest.end;
  const afterDest = j;
  let title = null;
  const k = skipInlineWs(s, j);
  // A title must be separated from the destination by whitespace.
  if (k > j && k >= 0 && k < s.length && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const t = scanLinkTitle(s, k);
    if (t) {
      // After a title only whitespace up to the line end may follow.
      let e = t.end;
      while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e++;
      if (e >= s.length || s[e] === '\n') {
        title = t.raw;
        j = e;
      }
    }
  }
  if (title === null) {
    // No title: only trailing spaces then a line ending (or end).
    let e = afterDest;
    while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e++;
    if (e < s.length && s[e] !== '\n') return -1;
    j = e;
  }
  if (s[j] === '\n') j++;
  const key = normalizeLabel(lab.raw);
  if (!refs.has(key)) refs.set(key, { href: dest.raw, title });
  return j;
}

function extractRefs(doc, refs) {
  const walk = (b) => {
    for (const child of b.children) {
      if (child.t === 'paragraph' || (child.t === 'heading' && child._defPrefix !== undefined)) {
        const full = child._defPrefix !== undefined ? child._defPrefix + child.str : child.str;
        let pos = 0;
        while (pos < full.length) {
          const end = scanRefDef(full, pos, refs);
          if (end < 0) break;
          pos = end;
        }
        if (pos > 0) {
          child.str = full.slice(pos);
          if (child.t === 'paragraph' && child.str.trim() === '') child.remove = true;
        }
        delete child._defPrefix;
      } else {
        walk(child);
      }
    }
  };
  walk(doc);
  const prune = (b) => {
    b.children = b.children.filter(c => !c.remove);
    for (const c of b.children) prune(c);
  };
  prune(doc);
}

// ---------------------------------------------------------------- inline

const SPECIAL_RE = /[\\`\[\]!<>&*_~\n]/g;
const EMAIL_LOCAL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-";
// The local-part characters of marked's bare-email regex itself.
const EMAIL_LOCAL_SET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-";
// Marked's GFM email shapes: labels may contain - and _ but a dotted
// label must end alphanumeric, and the match must not be followed by
// a word character or hyphen.
const BARE_EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const PROTOCOL_EMAIL_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;

function scanHtmlTag(s, i) {
  if (s.startsWith('<!--', i)) {
    // Marked's inline comment: <!--> and <!---> are complete comments,
    // otherwise the comment runs to the first -->.
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return -1;
    return end + 3;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (s[i + 1] === '!' && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
    const end = s.indexOf('>', i + 2);
    return end === -1 ? -1 : end + 1;
  }
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (!isAlpha(s.charCodeAt(j))) return -1;
  j++;
  while (j < s.length && (isAlnum(s.charCodeAt(j)) || s[j] === '-')) j++;
  if (closing) {
    // A closing tag is only a name, optional whitespace, and '>'.
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  // Attributes.
  while (true) {
    let ws = 0;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (ws === 0) return -1;
    if (!((s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= 'a' && s[j] <= 'z') || s[j] === '_' || s[j] === ':')) return -1;
    j++;
    while (j < s.length && (isAlnum(s.charCodeAt(j)) || s[j] === '_' || s[j] === '.' || s[j] === ':' || s[j] === '-')) j++;
    // Optional value.
    let k = j;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
    if (s[k] === '=') {
      k++;
      while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, k + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else {
        let e = k;
        while (e < s.length && !isSpaceCh(s.charCodeAt(e)) && s[e] !== '"' && s[e] !== "'" && s[e] !== '=' && s[e] !== '<' && s[e] !== '>' && s[e] !== '`') e++;
        if (e === k) return -1;
        j = e;
      }
    }
  }
}

const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const AUTOLINK_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

// marked's _backpedal, applied repeatedly until stable: the result
// is the longest prefix decomposable into plain chunks, balanced
// (...) groups, bare '&', and punctuation runs not at the very end.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimAutolinkTail(text) {
  let t = text;
  for (;;) {
    const m = BACKPEDAL_RE.exec(t);
    const next = m ? m[0] : '';
    if (next === t) return t;
    t = next;
  }
}

// Try an extended autolink at position i. Returns {text, href} or null.
// `flags.openUnderscore`: an unmatched '_' delimiter is open, so an
// email match may need to be measured against the segment that ends
// at the closing '_' run (marked lexes emphasis content separately).
// `flags.bracketOpen`: a '[' opener is open, so a www/scheme match
// must not swallow the ']' that closes it.
function matchExtendedAutolink(s, i, flags) {
  const prev = i > 0 ? s[i - 1] : undefined;
  const prevOk = prev === undefined || (!isAlnum(prev.charCodeAt(0)) && prev !== '.' && prev !== '/' && prev !== '-' && prev !== '_' && prev !== '@' && prev !== ':' && prev !== '~');
  const truncAtBracket = (raw) => {
    if (!flags || !flags.bracketOpen) return raw;
    let depth = 0;
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] === '[') depth++;
      else if (raw[k] === ']') {
        if (depth === 0) return raw.slice(0, k);
        depth--;
      }
    }
    return raw;
  };
  // www.
  if (s.startsWith('www.', i) && prevOk) {
    let j = i;
    while (j < s.length && !isSpaceCh(s.charCodeAt(j)) && s[j] !== '<' && s[j] !== '>') j++;
    let text = trimAutolinkTail(truncAtBracket(s.slice(i, j)));
    if (text.length > 4 && /^www\.[A-Za-z0-9]/.test(text) && text.indexOf('.', 4) !== -1) {
      return { text, href: 'http://' + text };
    }
    return null;
  }
  // scheme://
  const proto = /^(?:https?|ftp):\/\//i.exec(s.slice(i, i + 10));
  if (proto && prevOk) {
    let j = i;
    while (j < s.length && !isSpaceCh(s.charCodeAt(j)) && s[j] !== '<' && s[j] !== '>') j++;
    let text = trimAutolinkTail(truncAtBracket(s.slice(i, j)));
    if (text.length > proto[0].length) return { text, href: text };
    return null;
  }
  // mailto:/xmpp: protocol autolinks (marked's emailProtocol rule).
  if (prev === undefined || !isAlnum(prev.charCodeAt(0))) {
    if (flags && flags.openUnderscore) {
      const k = s.indexOf('_', i);
      if (k !== -1) {
        const m2 = PROTOCOL_EMAIL_RE.exec(s.slice(i, k));
        if (m2 && m2[0].length === k - i) return { text: m2[0], href: m2[0] };
      }
    }
    const m = PROTOCOL_EMAIL_RE.exec(s.slice(i, i + 300));
    if (m) return { text: m[0], href: m[0] };
  }
  // Bare email. (A '_' right before counts as a boundary when it was
  // consumed as an emphasis delimiter, not as a local-part character.)
  if (prev === undefined || EMAIL_LOCAL_SET.indexOf(prev) === -1 ||
      (prev === '_' && flags && flags.afterUnderscoreDelim)) {
    if (flags && flags.openUnderscore) {
      const k = s.indexOf('_', i);
      if (k !== -1) {
        const m2 = BARE_EMAIL_RE.exec(s.slice(i, k));
        if (m2 && m2[0].length === k - i) return { text: m2[0], href: 'mailto:' + m2[0] };
      }
    }
    const m = BARE_EMAIL_RE.exec(s.slice(i, i + 300));
    if (m) return { text: m[0], href: 'mailto:' + m[0] };
  }
  return null;
}

function parseInlines(s, refs) {
  const nodes = [];
  const delims = []; // {nodeIdx, ch, len, canOpen, canClose}
  const brackets = []; // {nodeIdx, image, active, srcStart, delimLen}
  // Cache for "some live '_' opener exists" (autolink email guard):
  // pushes can only set it, emphasis processing can clear it, so the
  // latter marks it dirty and it is recomputed lazily.
  let usOpenVal = false;
  let usOpenDirty = false;
  let textBuf = '';
  let i = 0;
  const n = s.length;

  function flushText() {
    if (textBuf) { nodes.push({ k: 'text', v: textBuf }); textBuf = ''; }
  }

  // ---- marked-style emphasis / strikethrough pairing ----
  // marked's emStrong/del tokenizers are opener-driven: at a delimiter
  // run they scan forward over same-char runs, classifying each run by
  // its neighbouring characters (opener-type runs raise the balance,
  // closer-type runs lower it, "both" runs may be skipped by the rule
  // of three), and pair with the run that brings the balance to zero.
  // The pair's inner text is then processed recursively. This mirrors
  // that algorithm over the delimiter list instead of the raw string.
  const WS1_RE = /\s/;
  const OPEN_QUOTE_RE = /[\p{Pi}\p{Ps}"']/u;
  const ALNUM_RE = /[\p{L}\p{N}]/u;
  function isWsCh(ch) { return ch !== '' && WS1_RE.test(ch); }
  function punctYe(ch) { return ch !== '' && ch !== '~' && isUnicodePunct(ch); }
  function punctSpaceSt(ch) { return ch !== '' && (isWsCh(ch) || punctYe(ch)); }
  function wordIt(ch) { return ch === '~' || (ch !== '' && !isWsCh(ch) && !isUnicodePunct(ch)); }
  function punctSpaceJ(ch) { return ch !== '' && (isWsCh(ch) || isUnicodePunct(ch)); }
  function wordX(ch) { return ch !== '' && !isWsCh(ch) && !isUnicodePunct(ch); }
  function ntTest(ch) { return ch !== '' && ch !== '*' && ch !== '_' && punctSpaceSt(ch); }
  function charBefore(idx) {
    if (idx <= 0) return '';
    const c = s[idx - 1];
    if (idx >= 2 && c >= '\uDC00' && c <= '\uDFFF') {
      const c2 = s[idx - 2];
      if (c2 >= '\uD800' && c2 <= '\uDBFF') return s.slice(idx - 2, idx);
    }
    return c;
  }
  function charAfter(idx) {
    if (idx >= n) return '';
    const c = s[idx];
    if (c >= '\uD800' && c <= '\uDBFF' && idx + 1 < n) return s.slice(idx, idx + 2);
    return c;
  }
  // ze()/fe() bound: start index of the last run of ch whose preceding
  // character is not a space/tab/newline (start of string never counts).
  // One pass fills the bounds for all three delimiter chars.
  let closerBounds = null;
  const RUN_SCAN_RE = /\*+|_+|~+/g;
  function lastCloserStart(ch) {
    if (closerBounds === null) {
      closerBounds = { '*': -1, '_': -1, '~': -1 };
      RUN_SCAN_RE.lastIndex = 0;
      let m;
      while ((m = RUN_SCAN_RE.exec(s)) !== null) {
        const idx = m.index;
        if (idx > 0 && ' \t\n\r\f'.indexOf(s[idx - 1]) === -1 && !isPoisoned(idx)) closerBounds[m[0][0]] = idx;
      }
    }
    return closerBounds[ch];
  }
  // marked masks the source before inline lexing: its code-span mask
  // pairs each backtick run with the next run of the same length —
  // even across link boundaries — and emphasis delimiters inside a
  // masked span are invisible to its counting. A stray run inside a
  // link's text therefore poisons everything up to the partner span.
  // Positions covered by a backslash escape pair in the mask (both
  // chars read as '+' there). RDelim classification sees the masked
  // text, so an escaped '~' is a plain punct for a neighbouring run.
  let escMasked = null;
  function maskCharBefore(idx) {
    const c = charBefore(idx);
    if (c === '') return '';
    return escMasked && escMasked[idx - c.length] ? '+' : c;
  }
  function maskCharAfter(idx) {
    const c = charAfter(idx);
    if (c === '') return '';
    return escMasked && escMasked[idx] ? '+' : c;
  }
  let poisonMap = null; // Uint8Array over s positions, or null
  function isPoisoned(pos) {
    return poisonMap !== null && poisonMap[pos] === 1;
  }
  function computePoisonRanges() {
    if (delims.length === 0) { escMasked = null; return; }
    // Escape pairs read as '+' in the mask. They are collected in one
    // independent pass: marking a pair inside a code-span mask range
    // is harmless, because delimiters there are skipped as poisoned
    // before any classification reads the masked neighbour, and the
    // one boundary char it can affect (a span's closing backtick) is
    // punctuation just like '+'.
    let escPoints = null;
    if (s.indexOf('\\') !== -1) {
      escMasked = new Uint8Array(n);
      escPoints = [];
      let p = s.indexOf('\\');
      while (p !== -1) {
        if (p + 1 < n && isPunct(s[p + 1])) {
          escMasked[p] = 1; escMasked[p + 1] = 1;
          escPoints.push(p, p + 1);
          p = s.indexOf('\\', p + 2);
        } else p = s.indexOf('\\', p + 1);
      }
    } else escMasked = null;
    // Simulate the mask's code-span scan: a backtick run pairs with
    // the next raw run of the same length, escapes inside the content
    // notwithstanding. Runs are collected once and paired through a
    // next-same-length index, keeping this linear.
    const ranges = [];
    if (s.indexOf('`') !== -1) {
      const runs = [];
      let p = s.indexOf('`');
      while (p !== -1) {
        let r = 1;
        while (p + r < n && s[p + r] === '`') r++;
        runs.push([p, r]);
        p = s.indexOf('`', p + r);
      }
      const nextSame = new Int32Array(runs.length).fill(-1);
      const lastByLen = new Map();
      for (let k = runs.length - 1; k >= 0; k--) {
        const L = runs[k][1];
        if (lastByLen.has(L)) nextSame[k] = lastByLen.get(L);
        lastByLen.set(L, k);
      }
      let ri = 0;
      while (ri < runs.length) {
        const rs = runs[ri][0];
        const rl = runs[ri][1];
        if (escMasked && escMasked[rs]) {
          // An escape consumed this run's first backtick; the rest of
          // the run (if any) opens as a shorter run.
          if (rl === 1) { ri++; continue; }
          const want = rl - 1;
          let ci = -1;
          for (let k = ri + 1; k < runs.length; k++) if (runs[k][1] === want) { ci = k; break; }
          if (ci === -1) { ri++; continue; }
          ranges.push([rs + 1, runs[ci][0] + want]);
          ri = ci + 1;
          continue;
        }
        const ci = nextSame[ri];
        if (ci === -1) { ri++; continue; }
        ranges.push([rs, runs[ci][0] + rl]);
        ri = ci + 1;
      }
    }
    if (s.indexOf('[') === -1 && s.indexOf('<') === -1) {
      // Without '[' or '<' the blockSkip pass can add nothing: its
      // link and html alternatives never match, and its code spans
      // coincide with the code-span mask ranges already collected.
      if (ranges.length > 0) {
        poisonMap = new Uint8Array(n);
        for (const [a, b] of ranges) poisonMap.fill(1, a, b);
      }
      closerBounds = null;
      return;
    }
    poisonMap = new Uint8Array(n);
    for (const [a, b] of ranges) poisonMap.fill(1, a, b);
    // The mask's second pass (blockSkip) runs on the text after the
    // code-span mask: escape pairs and backticks inside paired spans
    // read as '+'. It then masks link-shaped spans (with its own,
    // looser label rule), code spans, and html tags the same way.
    // The masked text differs from the source only at those '+'
    // positions, so it is stitched from slices when they are sparse.
    let m;
    {
      const pts = [];
      for (const [a, b] of ranges) {
        let oe = a;
        while (s[oe] === '`') oe++;
        let cs = b;
        while (s[cs - 1] === '`') cs--;
        let q = s.indexOf('`', oe);
        while (q !== -1 && q < cs) { pts.push(q); q = s.indexOf('`', q + 1); }
      }
      // Escape points inside a code-span mask range stay raw in the
      // APOC output (the span match consumed them), so only escape
      // points outside every range become '+' here.
      let escOut = escPoints;
      if (escPoints && ranges.length > 0) {
        escOut = [];
        let rp = 0;
        for (const q of escPoints) {
          while (rp < ranges.length && q >= ranges[rp][1]) rp++;
          if (rp < ranges.length && q >= ranges[rp][0]) continue;
          escOut.push(q);
        }
      }
      const all = escOut ? escOut.concat(pts).sort((x, y) => x - y) : pts;
      if (all.length === 0) m = s;
      else if (all.length * 6 < n) {
        let out = '';
        let last = 0;
        let prev = -1;
        for (const q of all) {
          if (q === prev) continue;
          prev = q;
          if (q > last) out += s.slice(last, q);
          out += '+';
          last = q + 1;
        }
        m = out + s.slice(last);
      } else {
        const mt = s.split('');
        for (const q of all) mt[q] = '+';
        m = mt.join('');
      }
    }
    const codeSpanEq = (q) => {
      let r = 1;
      while (q + r < n && m[q + r] === '`') r++;
      let j = q + r;
      if (j >= n || m[j] === '`') return -1;
      while (j < n && m[j] !== '`') j++;
      if (j >= n) return -1;
      let r2 = 1;
      while (j + r2 < n && m[j + r2] === '`') r2++;
      return r2 === r ? j + r : -1;
    };
    const parenPart = (q) => {
      let j = q + 1;
      while (j < n) {
        const c = m[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '(') {
          j++;
          let ok = false;
          while (j < n) {
            const d = m[j];
            if (d === '\\') { j += 2; continue; }
            if (d === ')') { ok = true; j++; break; }
            if (d === '(') return -1;
            j++;
          }
          if (!ok) return -1;
          continue;
        }
        if (c === ')') return j + 1;
        j++;
      }
      return -1;
    };
    const linkSpan = (q) => {
      let j = q + 1;
      while (j < n) {
        const c = m[j];
        if (c === '`') {
          const e = codeSpanEq(j);
          if (e === -1) return -1;
          j = e; continue;
        }
        if (c === '[') return -1;
        if (c === ']') {
          if (m[j + 1] !== '(') return -1;
          return parenPart(j + 1);
        }
        j++;
      }
      return -1;
    };
    const extra = [];
    const SKIP_RE = /[`\[<]/g;
    let p2 = 0;
    while (p2 < n) {
      SKIP_RE.lastIndex = p2;
      const hit = SKIP_RE.exec(m);
      if (!hit) break;
      p2 = hit.index;
      const c = m[p2];
      if (c === '[') {
        const e = linkSpan(p2);
        if (e !== -1) { extra.push([p2, e]); p2 = e; continue; }
        p2++;
      } else if (c === '`') {
        if (m[p2 - 1] !== '`') {
          const e = codeSpanEq(p2);
          if (e !== -1) { extra.push([p2, e]); p2 = e; continue; }
        }
        let r = 1;
        while (p2 + r < n && m[p2 + r] === '`') r++;
        p2 += r;
      } else {
        if (m[p2 + 1] !== ' ') {
          let j = p2 + 1;
          while (j < n && m[j] !== '<' && m[j] !== '>') j++;
          if (j < n && m[j] === '>') { extra.push([p2, j + 1]); p2 = j + 1; continue; }
        }
        p2++;
      }
    }
    for (const [a, b] of extra) poisonMap.fill(1, a, b);
    closerBounds = null;
  }
  // RDelim run classification from neighbouring characters. The '*'
  // table (ht) uses the GFM atom set; the '_' table (kt) uses plain
  // atoms and has no word/word alternative (intraword runs vanish).
  function classifyEmRun(ch, prev, next) {
    if (ch === '_') {
      if (isUnicodePunct(prev) && (next === '' || isWsCh(next))) return 'close';
      if (wordX(prev) && (next === '' || punctSpaceJ(next))) return 'close';
      if (punctSpaceJ(prev) && wordX(next)) return 'open';
      if (isWsCh(prev) && isUnicodePunct(next)) return 'open';
      if (isUnicodePunct(prev) && isUnicodePunct(next)) return 'both';
      return 'none';
    }
    if (punctYe(prev) && (next === '' || isWsCh(next))) return 'close';
    if (wordIt(prev) && (next === '' || punctSpaceSt(next))) return 'close';
    if (punctSpaceSt(prev) && wordIt(next)) return 'open';
    if (isWsCh(prev) && punctYe(next)) return 'open';
    if (punctYe(prev) && punctYe(next)) return 'both';
    if (wordIt(prev) && wordIt(next)) return 'both';
    return 'none';
  }
  function classifyDelRun(prev, next) {
    if (prev !== '~' && isUnicodePunct(prev) && (next === '' || isWsCh(next))) return 'close';
    if (wordX(prev) && (next === '' || punctSpaceJ(next))) return 'close';
    if (prev !== '~' && punctSpaceJ(prev) && wordX(next)) return 'open';
    if (isWsCh(prev) && isUnicodePunct(next)) return 'open';
    if (prev !== '~' && isUnicodePunct(prev) && isUnicodePunct(next)) return 'both';
    if (wordX(prev) && wordX(next)) return 'both';
    return 'none';
  }
  // One emStrong attempt for opener delim op, skipping `skip` chars of
  // the run (marked retries mid-run after its text tokenizer advances).
  function emAttempt(op, skip, i, hi) {
    const ch = op.ch;
    const k = op.len - skip;
    const contentCh = op.innerNext !== undefined ? op.innerNext : charAfter(op.endPos);
    if (contentCh === '' || isWsCh(contentCh)) return null;
    let dPunct = '';
    if (contentCh !== ch && punctYe(contentCh)) dPunct = contentCh;
    const p = op.innerPrev !== undefined ? op.innerPrev : charBefore(op.runStart);
    const leftover = op.startPos + skip > op.runStart;
    const h = p === '*' || p === '_' || ntTest(p);
    const u = leftover ? h : ntTest(p);
    if (dPunct && p !== '' && !u) return null;
    if (ch === '_' && !dPunct && p !== '' && ALNUM_RE.test(p)) return null;
    const oSame = leftover;
    const R = !isWsCh(p) && p !== '' && (!!dPunct || (ch === '*' && !h));
    const y = op.full;
    const v = lastCloserStart(ch);
    const other = ch === '*' ? '_' : '*';
    let m = k;
    let f = 0;
    // The RDelim scan's first alternative swallows a span
    // `__...*...__` (resp. `**..._...**`) whole, but its `^` anchor
    // lets it fire only at the very start of the scan: when the
    // first visible run after the opener is the other char's double
    // run, the next is a lone run of this char, and the one after is
    // another double run of the other char, the lone run is skipped
    // (consumed by the swallowed span, never counted).
    let specialSkip = -1;
    {
      const vis = (q) => {
        while (q < hi) {
          const d = delims[q];
          if (d.len > 0 && d.ch !== '~' && !isPoisoned(d.startPos)) return q;
          q++;
        }
        return -1;
      };
      const j1 = vis(i + 1);
      if (j1 !== -1 && delims[j1].ch === other && delims[j1].len === 2) {
        const j2 = vis(j1 + 1);
        if (j2 !== -1 && delims[j2].ch === ch && delims[j2].len === 1) {
          const j3 = vis(j2 + 1);
          if (j3 !== -1 && delims[j3].ch === other && delims[j3].len >= 2) specialSkip = j2;
        }
      }
    }
    for (let j = i + 1; j < hi; j++) {
      const Rr = delims[j];
      if (Rr.len === 0 || Rr.ch === '~') continue;
      if (isPoisoned(Rr.startPos)) continue;
      if (Rr.ch !== ch) continue;
      if (Rr.startPos - 1 > v) break;
      if (j === specialSkip) continue;
      const cls = classifyEmRun(ch,
        Rr.innerPrev !== undefined ? Rr.innerPrev : maskCharBefore(Rr.startPos),
        Rr.innerNext !== undefined ? Rr.innerNext : maskCharAfter(Rr.endPos));
      if (cls === 'none') continue;
      const b = Rr.len;
      if (cls === 'open') { m += b; continue; }
      if (cls === 'both' || R) {
        if (oSame && cls === 'both') return null;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const use = Math.max(1, Math.min(b, b + m + f));
      return { closerIdx: j, use, kind: Math.min(k, use) % 2 === 1 ? 'em' : 'strong' };
    }
    return null;
  }
  // One del attempt (marked's del tokenizer) for '~' opener op.
  function delAttempt(op, skip, i, hi) {
    const o = op.len - skip;
    if (o < 1 || o > 2) return null;
    const contentCh = charAfter(op.endPos);
    if (contentCh === '' || isWsCh(contentCh) || contentCh === '~') return null;
    const dPunct = isUnicodePunct(contentCh) ? contentCh : '';
    const nn = skip > 0 ? '~' : (op.innerPrev !== undefined ? op.innerPrev : charBefore(op.runStart));
    if (dPunct && nn !== '' && !ntTest(nn)) return null;
    const v = lastCloserStart('~');
    let pp = o;
    for (let j = i + 1; j < hi; j++) {
      const Rr = delims[j];
      if (Rr.ch !== '~' || Rr.len === 0) continue;
      if (isPoisoned(Rr.startPos)) continue;
      if (Rr.startPos - 1 > v) break;
      // A run of 3+ tildes never matches marked's del RDelim: every
      // alternative either demands (?!~) after the matched pair or a
      // following character class that '~' fails.
      if (Rr.len >= 3) continue;
      const b = Rr.len;
      if (b !== o) continue;
      const cls = classifyDelRun(
        Rr.innerPrev !== undefined ? Rr.innerPrev : maskCharBefore(Rr.startPos),
        Rr.innerNext !== undefined ? Rr.innerNext : maskCharAfter(Rr.endPos));
      if (cls === 'none') continue;
      if (cls === 'open') { pp += b; continue; }
      pp -= b;
      if (pp > 0) continue;
      return { closerIdx: j, use: Math.min(b, b + pp), kind: 'del' };
    }
    return null;
  }
  // Split `skip` chars off the front of a delimiter run as literal text
  // (the mid-run retry in marked consumes them as a text token).
  function splitDelimPrefix(op, skip) {
    const oldIdx = op.nodeIdx;
    nodes.splice(oldIdx, 0, { k: 'text', v: op.ch.repeat(skip) });
    op.nodeIdx = oldIdx + 1;
    const nd = nodes[op.nodeIdx];
    if (nd && nd.k === 'delim') nd.len = op.len - skip;
    op.startPos += skip;
    op.len -= skip;
    delete op.innerPrev;
    for (const d of delims) if (d !== op && d.nodeIdx >= oldIdx) d.nodeIdx++;
    for (const b of brackets) if (b.nodeIdx >= oldIdx) b.nodeIdx++;
  }
  // Form the pair found for delims[i]; returns the adjusted hi bound.
  function applyPair(i, res, hi) {
    const op = delims[i];
    const cl = delims[res.closerIdx];
    const kind = res.kind;
    const useLeft = kind === 'del' ? res.use : (kind === 'em' ? 1 : 2);
    const lenBefore = delims.length;
    // The opener run is fully inside the token raw; the part beyond
    // useLeft stays as an inner delimiter for the recursive pass.
    op.len -= useLeft;
    const opNode = nodes[op.nodeIdx];
    if (opNode && opNode.k === 'delim') opNode.len = op.len;
    // The closer contributes `use` chars; any beyond useRight stay
    // inside as a synthetic delimiter covering the FIRST clInnerLen
    // chars of the run (the inner slice drops from the raw's end),
    // the rest stays outside.
    const clInnerLen = res.use - useLeft;
    const clOrigStart = cl.startPos;
    cl.len -= res.use;
    cl.startPos += res.use;
    const clNode = nodes[cl.nodeIdx];
    if (clNode && clNode.k === 'delim') clNode.len = cl.len;
    let clInner = null;
    if (clInnerLen > 0) {
      clInner = { nodeIdx: cl.nodeIdx, ch: cl.ch, len: clInnerLen, canOpen: false, canClose: true, endPos: clOrigStart + clInnerLen, startPos: clOrigStart, runStart: clOrigStart, full: clInnerLen };
      nodes.splice(cl.nodeIdx, 0, { k: 'delim', ch: cl.ch, len: clInnerLen });
      cl.nodeIdx++;
      for (const d of delims) if (d !== cl && d.nodeIdx > clInner.nodeIdx) d.nodeIdx++;
      for (const b of brackets) if (b.nodeIdx > clInner.nodeIdx) b.nodeIdx++;
      delims.splice(res.closerIdx, 0, clInner);
    }
    const innerHi = res.closerIdx + (clInner ? 1 : 0);
    const leftNode = op.nodeIdx;
    // Inside the recursive pass the span is a fresh string for marked:
    // the opener leftover starts it (no preceding char), the closer
    // leftover ends it (no following char), and real delimiters flush
    // against either edge see the same boundary.
    const innerStartPos = op.startPos + useLeft;
    op.innerPrev = '';
    op.full = op.len;
    if (clInner) clInner.innerNext = '';
    for (let j = i; j < innerHi; j++) {
      const d = delims[j];
      if (d !== op && d.startPos === innerStartPos) d.innerPrev = '';
      if (d.endPos === clOrigStart) d.innerNext = '';
    }
    processRangeMarked(i, innerHi);
    const clIdx = delims.indexOf(cl);
    const rightNode = cl.nodeIdx;
    const children = nodes.slice(leftNode, rightNode);
    nodes.splice(leftNode, rightNode - leftNode, { k: kind, children });
    const shift = rightNode - leftNode - 1;
    for (const d of delims) {
      if (d.nodeIdx >= rightNode) d.nodeIdx -= shift;
    }
    for (const b of brackets) {
      if (b.nodeIdx >= rightNode) b.nodeIdx -= shift;
      else if (b.nodeIdx > leftNode && b.nodeIdx < rightNode) b.nodeIdx = leftNode;
    }
    // Delimiters inside the token leave the active list.
    delims.splice(i, clIdx - i);
    if (cl.len === 0) {
      nodes[leftNode + 1] = { k: 'text', v: '' };
      if (delims[i] === cl) delims.splice(i, 1);
    } else {
      cl.nodeIdx = leftNode + 1;
    }
    return hi + (delims.length - lenBefore);
  }
  function processRangeMarked(lo, hi) {
    let i = lo;
    while (i < hi) {
      const op = delims[i];
      if (!op || op.len === 0 || isPoisoned(op.startPos)) { i++; continue; }
      let res = null;
      let skip = 0;
      for (skip = 0; skip < op.len && !res; skip++) {
        res = op.ch === '~' ? delAttempt(op, skip, i, hi) : emAttempt(op, skip, i, hi);
      }
      if (!res) { i++; continue; }
      skip--;
      if (skip > 0) splitDelimPrefix(op, skip);
      hi = applyPair(i, res, hi);
      // The next candidate (closer leftover or following delim) is at i.
    }
    return hi;
  }
  function processEmphasis(bottom) {
    processRangeMarked(bottom, delims.length);
  }

  function deactivateBrackets() {
    for (const b of brackets) if (!b.image) b.active = false;
  }

  // Try to form a link/image at the current ']' (position i).
  // Returns the new index after the link, or -1 when no link forms.
  // Extended autolinks are not formed inside link text in marked (the
  // children are lexed with inLink set). They were parsed optimistically
  // here, so demote them back to plain text when a link actually forms.
  function stripExtAutos(list) {
    for (let i = 0; i < list.length; i++) {
      const nd = list[i];
      if (nd.k === 'link' && nd.ext) {
        list[i] = { k: 'text', v: nd.children.map(ch => ch.v || '').join('') };
      } else if (nd.children) stripExtAutos(nd.children);
    }
  }

  // marked's link-label pattern: the label must scan as escapes,
  // nested bracket groups (two levels: a group whose content may
  // hold simple bracket pairs), code-span-like backtick pairs (an
  // opening run closed by the NEXT run of any length, content free
  // of backticks), one trailing run of >= 2 backticks flush against
  // the ']', or plain characters other than [ ] \ `.
  function labelPatternOk(text) {
    const len = text.length;
    function leGroup(j) {
      // text[j] === '['; content: escapes or non-bracket chars.
      j++;
      while (j < len) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === ']') return j + 1;
        if (d === '[') return -1;
        j++;
      }
      return -1;
    }
    function altGroup(j) {
      // text[j] === '['; content: leGroups, escapes, or chars other
      // than [ ] \ (backticks are ordinary here).
      j++;
      while (j < len) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === ']') return j + 1;
        if (d === '[') {
          const e = leGroup(j);
          if (e === -1) return -1;
          j = e; continue;
        }
        j++;
      }
      return -1;
    }
    let p = 0;
    while (p < len) {
      const c = text[p];
      if (c === '\\') { if (p + 1 >= len) return false; p += 2; continue; }
      if (c === '[') {
        const e = altGroup(p);
        if (e === -1) return false;
        p = e; continue;
      }
      if (c === '`') {
        let r = 1;
        while (p + r < len && text[p + r] === '`') r++;
        if (r >= 2 && p + r === len) return true;
        let j = p + r;
        let closed = -1;
        while (j < len) {
          if (text[j] === '`') {
            let r2 = 1;
            while (j + r2 < len && text[j + r2] === '`') r2++;
            closed = j + r2;
            break;
          }
          j++;
        }
        if (closed === -1) return false;
        p = closed; continue;
      }
      if (c === ']') return false;
      p++;
    }
    return true;
  }

  // Pure (non-mutating) version of tryCloseBracket's decision: would
  // a link/image form if the bracket `opener` closed at closePos?
  // marked tries its link tokenizer at the '[' before any code span
  // inside the text is considered, so an unmatched backtick run in
  // link text must not swallow the closing ']'.
  function bracketWouldLink(opener, closePos) {
    if (!labelPatternOk(s.slice(opener.srcStart, closePos))) return false;
    const after = closePos + 1;
    if (s[after] === '(') {
      let j = skipInlineWs(s, after + 1);
      if (j >= 0) {
        const dest = scanLinkDest(s, j);
        if (dest) {
          let k = skipInlineWs(s, dest.end);
          if (k >= 0) {
            if (s[k] === ')') return true;
            if (k > dest.end) {
              const t = scanLinkTitle(s, k);
              if (t) { const e = skipInlineWs(s, t.end); if (e >= 0 && s[e] === ')') return true; }
            }
          }
        }
      }
    }
    if (s[after] === '[') {
      const lab = scanLinkLabel(s, after);
      if (lab) {
        const key = normalizeLabel(lab.raw === '' ? s.slice(opener.srcStart, closePos) : lab.raw);
        return !!refs.get(key);
      }
    }
    const key = normalizeLabel(s.slice(opener.srcStart, closePos));
    return !!refs.get(key);
  }

  function tryCloseBracket(opener) {
    usOpenDirty = true; // emphasis processing inside may mutate delims
    if (!labelPatternOk(s.slice(opener.srcStart, i))) return -1;
    const after = i + 1;
    let href = null;
    let title = null;
    let end = -1;
    // Inline destination.
    if (s[after] === '(') {
      let j = skipInlineWs(s, after + 1);
      if (j >= 0) {
        const dest = scanLinkDest(s, j);
        if (dest) {
          let k = skipInlineWs(s, dest.end);
          let ok = false;
          if (k >= 0) {
            if (s[k] === ')') { href = dest.raw; end = k + 1; ok = true; }
            else if (k > dest.end) {
              const t = scanLinkTitle(s, k);
              if (t) {
                const e = skipInlineWs(s, t.end);
                if (e >= 0 && s[e] === ')') { href = dest.raw; title = t.raw; end = e + 1; ok = true; }
              }
            }
          }
          if (!ok) { href = null; end = -1; }
        }
      }
    }
    // Full / collapsed reference.
    if (end === -1 && s[after] === '[') {
      const lab = scanLinkLabel(s, after);
      if (lab) {
        const key = normalizeLabel(lab.raw === '' ? s.slice(opener.srcStart, i) : lab.raw);
        const ref = refs.get(key);
        if (ref) { href = ref.href; title = ref.title; end = lab.end; }
        else return -1; // a present-but-undefined label blocks the shortcut
      }
    }
    // Shortcut reference.
    if (end === -1) {
      const key = normalizeLabel(s.slice(opener.srcStart, i));
      const ref = refs.get(key);
      if (ref) { href = ref.href; title = ref.title; end = after; }
    }
    if (end === -1) return -1;
    // Process emphasis inside the link text first.
    processEmphasis(opener.delimLen);
    const oNode = opener.nodeIdx;
    const inner = nodes.slice(oNode + 1);
    stripExtAutos(inner);
    nodes.length = oNode;
    const node = {
      k: opener.image ? 'image' : 'link',
      href: cleanUrl(decodeLinkText(href)),
      title: title === null ? null : decodeLinkText(title),
      children: inner,
    };
    nodes.push(node);
    // Drop delimiters that belonged to the link text.
    while (delims.length > opener.delimLen) delims.pop();
    brackets.pop();
    if (!opener.image) deactivateBrackets();
    return end;
  }

  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n' && !/^\s*$/.test(s.slice(i + 2))) {
        // Hard break: drop trailing spaces already accumulated, and
        // marked's break rule also eats the next line's leading blanks.
        textBuf = textBuf.replace(/ +$/, '');
        flushText();
        nodes.push({ k: 'br' });
        i += 2;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else if (nx !== undefined && isPunct(nx)) {
        textBuf += s.slice(i, i + 2);
        i += 2;
      } else {
        textBuf += '\\';
        i++;
      }
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      while (sp < textBuf.length && textBuf[textBuf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2 && !/^\s*$/.test(s.slice(i + 1))) {
        textBuf = textBuf.slice(0, textBuf.length - sp);
        flushText();
        nodes.push({ k: 'br' });
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        flushText();
        nodes.push({ k: 'soft' });
        i++;
      }
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (i + run < n && s[i + run] === '`') run++;
      // Find a matching run. If the ']' that closes an enclosing
      // bracket (and would form a link there) comes first, the run is
      // literal text inside that link in marked: abandon the span.
      let j = i + run;
      let closeStart = -1;
      const vstack = brackets.slice();
      let depth = 0;
      while (j < n) {
        const cj = s[j];
        // An escaped bracket does not count for depth, but a
        // backslash does not hide a backtick from the closer search.
        if (cj === '\\' && (s[j + 1] === '[' || s[j + 1] === ']')) { j += 2; continue; }
        if (cj === '`') {
          let r2 = 1;
          while (j + r2 < n && s[j + r2] === '`') r2++;
          if (r2 === run) { closeStart = j; break; }
          j += r2;
          continue;
        }
        if (cj === '[') depth++;
        else if (cj === ']' && depth > 0) depth--;
        else if (cj === ']' && vstack.length) {
          const top = vstack[vstack.length - 1];
          if (top.active && bracketWouldLink(top, j)) { closeStart = -2; break; }
          vstack.pop();
        }
        j++;
      }
      if (closeStart < 0) {
        textBuf += s.slice(i, i + run);
        i += run;
      } else {
        flushText();
        let content = s.slice(i + run, closeStart).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ k: 'code', v: content });
        i = closeStart + run;
      }
      continue;
    }
    if (c === '<') {
      const rest = s.slice(i, i + 400);
      let m = AUTOLINK_RE.exec(rest);
      if (m) {
        flushText();
        nodes.push({ k: 'link', auto: true, href: cleanUrl(m[1]), title: null, children: [{ k: 'text', v: m[1] }] });
        i += m[0].length;
        continue;
      }
      m = AUTOLINK_EMAIL_RE.exec(rest);
      if (m) {
        flushText();
        nodes.push({ k: 'link', auto: true, href: cleanUrl('mailto:' + m[1]), title: null, children: [{ k: 'text', v: m[1] }] });
        i += m[0].length;
        continue;
      }
      const tagEnd = scanHtmlTag(s, i);
      if (tagEnd !== -1) {
        flushText();
        const tagText = s.slice(i, tagEnd);
        if (/^<a /i.test(tagText)) gInLink = true;
        else if (/^<\/a>/i.test(tagText)) gInLink = false;
        nodes.push({ k: 'html', v: tagText });
        i = tagEnd;
        continue;
      }
      textBuf += '<';
      i++;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      flushText();
      nodes.push({ k: 'open', v: '![' });
      brackets.push({ nodeIdx: nodes.length - 1, image: true, active: true, srcStart: i + 2, delimLen: delims.length });
      i += 2;
      continue;
    }
    if (c === '[') {
      flushText();
      nodes.push({ k: 'open', v: '[' });
      brackets.push({ nodeIdx: nodes.length - 1, image: false, active: true, srcStart: i + 1, delimLen: delims.length });
      i++;
      continue;
    }
    if (c === ']') {
      const opener = brackets[brackets.length - 1];
      if (!opener || !opener.active) {
        if (opener) brackets.pop();
        textBuf += ']';
        i++;
        continue;
      }
      flushText();
      const end = tryCloseBracket(opener);
      if (end === -1) {
        brackets.pop();
        textBuf += ']';
        i++;
      } else {
        i = end;
      }
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (i + run < n && s[i + run] === c) run++;
      if (c === '~' && run > 2) {
        // marked retries its del LDelim mid-run (text consumes one
        // '~', then '~~' can open), so long runs still form a delim;
        // delAttempt caps the effective opener length at 2 per try.
        flushText();
        nodes.push({ k: 'delim', ch: c, len: run });
        delims.push({ nodeIdx: nodes.length - 1, ch: c, len: run, canOpen: true, canClose: true, endPos: i + run, startPos: i, runStart: i, full: run });
        i += run;
        continue;
      }
      const prevCh = i > 0 ? s[i - 1] : undefined;
      const nextCh = i + run < n ? s[i + run] : undefined;
      const prevWhite = isUnicodeWhite(prevCh);
      const nextWhite = isUnicodeWhite(nextCh);
      const prevPunct = isUnicodePunct(prevCh);
      const nextPunct = isUnicodePunct(nextCh);
      const leftFlank = !nextWhite && (!nextPunct || prevWhite || prevPunct);
      const rightFlank = !prevWhite && (!prevPunct || nextWhite || nextPunct);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else if (c === '~') { canOpen = leftFlank; canClose = rightFlank; }
      else {
        canOpen = leftFlank && (!rightFlank || prevPunct);
        canClose = rightFlank && (!leftFlank || nextPunct);
      }
      flushText();
      nodes.push({ k: 'delim', ch: c, len: run });
      delims.push({ nodeIdx: nodes.length - 1, ch: c, len: run, canOpen, canClose, endPos: i + run, startPos: i, runStart: i, full: run });
      if (c === '_' && canOpen) usOpenVal = true;
      i += run;
      continue;
    }
    // Extended autolinks starting at word characters.
    if (!gInLink && (isAlnum(c.charCodeAt(0)) || c === '.' || c === '+')) {
      if (usOpenDirty) {
        usOpenVal = delims.some(d => d.ch === '_' && d.len > 0 && d.canOpen);
        usOpenDirty = false;
      }
      const lastDelim = delims[delims.length - 1];
      const ext = matchExtendedAutolink(s, i, {
        openUnderscore: usOpenVal,
        afterUnderscoreDelim: lastDelim !== undefined && lastDelim.endPos === i,
        bracketOpen: brackets.some(b => b.active),
      });
      if (ext) {
        flushText();
        nodes.push({ k: 'link', auto: true, ext: true, href: cleanUrl(ext.href), title: null, children: [{ k: 'text', v: ext.text }] });
        i += ext.text.length;
        continue;
      }
    }
    // Plain text: bulk-skip to the next special character, stopping at
    // potential autolink triggers inside the run.
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    let segEnd = m ? m.index : n;
    // Look for a trigger inside the segment.
    let trig = -1;
    for (let j = i; !gInLink && j < segEnd; j++) {
      const ch = s[j];
      if (ch === '@') {
        // Scan back to the start of the would-be local part. If that
        // start is not ahead of the current position (an attempt here
        // already failed), keep looking for a later trigger.
        let b = j;
        while (b > i && EMAIL_LOCAL_SET.indexOf(s[b - 1]) !== -1) b--;
        if (b > i) { trig = b; break; }
        continue;
      }
      if ((ch === 'w' && s.startsWith('www.', j)) ||
          (ch === 'h' && (s.startsWith('http://', j) || s.startsWith('https://', j))) ||
          (ch === 'f' && s.startsWith('ftp://', j))) {
        if (j > i) { trig = j; break; }
      }
    }
    if (trig > i) segEnd = trig;
    if (segEnd === i) {
      // A special char handled by no branch above (e.g. '&', '>').
      textBuf += c;
      i++;
    } else {
      textBuf += s.slice(i, segEnd);
      i = segEnd;
    }
  }
  flushText();
  computePoisonRanges();
  processEmphasis(0);
  return nodes;
}

// -------------------------------------------------------------- rendering

function escapeTextRun(v) {
  let out = '';
  let last = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 92 && i + 1 < v.length && isPunct(v[i + 1])) {
      out += v.slice(last, i) + escapeDecodedChar(v[i + 1]);
      i++;
      last = i + 1;
      continue;
    }
    let rep = null;
    if (c === 38) {
      const m = matchEntityRef(v, i);
      if (m) {
        rep = m.decoded !== null ? escapeDecodedChar(m.decoded) : m.raw;
        out += v.slice(last, i) + rep;
        i += m.raw.length - 1;
        last = i + 1;
        continue;
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += v.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? v : out + v.slice(last);
}

function plainTextOf(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text') {
      out += unescapeString(nd.v).replace(/&#?[A-Za-z0-9]+;/g, (m) => {
        const mm = matchEntityRef(m, 0);
        return mm && mm.decoded !== null ? mm.decoded : m;
      });
    } else if (nd.k === 'code') out += nd.v;
    else if (nd.k === 'soft' || nd.k === 'br') out += '\n';
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.k === 'open') out += nd.v;
    else if (nd.children) out += plainTextOf(nd.children);
  }
  return out;
}

function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += escapeTextRun(nd.v); break;
      case 'code': out += '<code>' + escapeHtml(nd.v, true) + '</code>'; break;
      case 'html': out += nd.v; break;
      case 'br': out += '<br>'; break;
      case 'soft': out += '\n'; break;
      case 'open': out += nd.v; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'em': out += '<em>' + renderInlineNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineNodes(nd.children) + '</del>'; break;
      case 'link': {
        // Autolinks render their text raw (only HTML-escaped), never
        // inline-parsed, and their href is fully escaped.
        const text = nd.auto
          ? escapeHtml(nd.children.map(ch => ch.v || '').join(''), true)
          : renderInlineNodes(nd.children);
        out += '<a href="' + escapeHtml(nd.href, nd.auto ? true : false) + '"' +
          (nd.title !== null ? ' title="' + escapeHtml(nd.title, false) + '"' : '') +
          '>' + text + '</a>';
        break;
      }
      case 'image':
        out += '<img src="' + escapeHtml(nd.href, false) + '" alt="' +
          escapeHtml(plainTextOf(nd.children), false) + '"' +
          (nd.title !== null ? ' title="' + escapeHtml(nd.title, false) + '"' : '') + '>';
        break;
    }
  }
  return out;
}

function renderInlineStr(str, refs) {
  if (str === '') return '';
  return renderInlineNodes(parseInlines(str, refs));
}

const TASK_RE = /^\[([ xX])\] /;

function renderChildren(b, refs, out, tight) {
  for (const child of b.children) renderBlock(child, refs, out, tight, b);
}

function renderBlock(b, refs, out, parentTight, parent) {
  switch (b.t) {
    case 'document':
      renderChildren(b, refs, out, false);
      break;
    case 'blockquote':
      out.push('<blockquote>\n');
      renderChildren(b, refs, out, false);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const d = b.listData;
      if (d.kind === 'bullet') out.push('<ul>\n');
      else out.push(d.start !== 1 ? '<ol start="' + d.start + '">\n' : '<ol>\n');
      renderChildren(b, refs, out, d.tight);
      out.push(d.kind === 'bullet' ? '</ul>\n' : '</ol>\n');
      break;
    }
    case 'item': {
      out.push('<li>');
      const kids = b.children;
      for (let idx = 0; idx < kids.length; idx++) {
        const kid = kids[idx];
        if (idx === 0 && kid.t === 'paragraph' && parentTight !== undefined) {
          const m = TASK_RE.exec(kid.str);
          if (m) {
            const input = m[1] === ' '
              ? '<input disabled="" type="checkbox"> '
              : '<input checked="" disabled="" type="checkbox"> ';
            const rest = kid.str.slice(4);
            if (parentTight) out.push(input + renderInlineStr(rest, refs));
            else out.push('<p>' + input + renderInlineStr(rest, refs) + '</p>\n');
            continue;
          }
        }
        if (kid.t === 'paragraph' && parentTight) {
          out.push(renderInlineStr(kid.str, refs));
        } else {
          renderBlock(kid, refs, out, false, b);
        }
      }
      out.push('</li>\n');
      break;
    }
    case 'paragraph':
      out.push('<p>' + renderInlineStr(b.str, refs) + '</p>\n');
      break;
    case 'heading':
      out.push('<h' + b.level + '>' + renderInlineStr(b.str, refs) + '</h' + b.level + '>\n');
      break;
    case 'code': {
      const lang = b.info ? b.info.split(/\s+/)[0] : '';
      out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang, false) + '"' : '') + '>' +
        escapeHtml(b.str, true) + '</code></pre>\n');
      break;
    }
    case 'html': {
      // marked applies ge() to the html raw: trailing blank lines in
      // the match are dropped when they span more than the final
      // newline; a following blank line (stripTrailNL, recorded at
      // parse time) also removes the trailing newline.
      let txt = b.str;
      const ls = txt.split('\n');
      let t = ls.length - 1;
      while (t >= 0 && /^[ \t]*$/.test(ls[t])) t--;
      if (ls.length - t > 2) txt = ls.slice(0, t + 1).join('\n');
      if (b.stripTrailNL && txt.endsWith('\n')) txt = txt.slice(0, -1);
      out.push(txt);
      break;
    }
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'table': {
      let h = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < b.header.length; c++) {
        const a = b.aligns[c];
        h += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInlineStr(b.header[c], refs) + '</th>\n';
      }
      h += '</tr>\n</thead>\n';
      if (b.rows.length) {
        h += '<tbody>';
        for (const row of b.rows) {
          h += '<tr>\n';
          for (let c = 0; c < b.header.length; c++) {
            const a = b.aligns[c];
            h += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInlineStr(row[c], refs) + '</td>\n';
          }
          h += '</tr>\n';
        }
        h += '</tbody></table>\n';
      } else {
        h += '</table>\n';
      }
      out.push(h);
      break;
    }
  }
}

// Marked keeps one inline-lexer state per parse: an inline <a ...>
// start tag switches it to inLink (extended autolinks are then not
// formed anywhere) until a </a> tag appears. The state deliberately
// persists across blocks within one parse call.
let gInLink = false;

export function parse(markdown) {
  let src = markdown === null || markdown === undefined ? '' : String(markdown);
  src = src.replace(/\r\n/g, '\n').replace(/\0/g, '�');
  gInLink = false;
  const doc = parseDocument(src);
  const refs = new Map();
  extractRefs(doc, refs);
  const out = [];
  renderBlock(doc, refs, out, false, null);
  return out.join('');
}
