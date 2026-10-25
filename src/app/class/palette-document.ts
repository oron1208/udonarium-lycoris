/** Plain-text structure: no XML/schema change; commands remain ordinary lines. */
export interface PaletteNode {
  kind: 'line' | 'fold';
  text: string;
  start: number;
  end: number;
  closed?: boolean;
  children: PaletteNode[];
}
export interface PaletteSection {
  name: string;
  start: number;
  end: number;
  children: PaletteNode[];
}
export function paletteDirective(line: string): { kind: string; name: string } | null {
  // Space after // prevents collisions with existing //name=value variables.
  const match = /^\/\/ @(tab|fold) (\S.*)$/.exec(line.replace(/\r$/, ''));
  if (match) return { kind: match[1], name: match[2] };
  return /^\/\/ @end\s*$/.test(line) ? { kind: 'end', name: '' } : null;
}
export function parsePaletteDocument(source: string): { lines: string[]; tabs: PaletteSection[] } {
  const lines = source.split(/\r?\n/);
  const tabs: PaletteSection[] = [{ name: '共通', start: -1, end: lines.length, children: [] }];
  let tab = tabs[0];
  let stack: PaletteNode[] = [];
  const finish = (end: number) => { for (const fold of stack) fold.end = end; stack = []; tab.end = end; };
  lines.forEach((text, start) => {
    const directive = paletteDirective(text);
    if (directive?.kind === 'tab') {
      finish(start);
      tab = { name: directive.name, start, end: lines.length, children: [] };
      tabs.push(tab);
      return;
    }
    const children = stack.length ? stack[stack.length - 1].children : tab.children;
    if (directive?.kind === 'fold') {
      const fold: PaletteNode = { kind: 'fold', text: directive.name, start, end: lines.length, closed: false, children: [] };
      children.push(fold);
      stack.push(fold);
    } else if (directive?.kind === 'end' && stack.length) {
      const fold = stack.pop();
      fold.end = start + 1;
      fold.closed = true;
    } else {
      // Keep unmatched/unknown directives visible, never discard user text.
      children.push({ kind: 'line', text, start, end: start + 1, children: [] });
    }
  });
  finish(lines.length);
  return { lines, tabs };
}
export function flattenPalette(source: string): string {
  return source.split(/\r?\n/).filter(line => !paletteDirective(line)).join('\n');
}

/** Replace only a tab's body, preserving its header and all outside bytes. */
export function replacePaletteTabBody(source: string, tabStart: number, body: string): string | null {
  const tab = parsePaletteDocument(source).tabs.find(tab => tab.start === tabStart);
  if (!tab || body.split(/\r?\n/).some(line => paletteDirective(line)?.kind === 'tab')) return null;
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  const first = tab.start < 0 ? 0 : tab.start + 1;
  const start = offsets[first] ?? source.length;
  const end = offsets[tab.end] ?? source.length;
  const newline = source.match(/\r?\n/)?.[0] || '\n';
  let prefix = source.slice(0, start);
  const suffix = source.slice(end);
  let replacement = body.replace(/\r?\n/g, newline);
  // A last, empty tab can have a header without a terminating newline.
  if (tab.start >= 0 && first >= offsets.length && replacement) prefix += newline;
  // The delimiter before the next tab is not part of the editable body.
  if (suffix && replacement) replacement += newline;
  return prefix + replacement + suffix;
}
export function isPaletteCommand(line: string): boolean {
  return !!line.trim() && !paletteDirective(line) && !/^\s*[/／]{2}[^=＝{}｛｝\s]+\s*[=＝]/.test(line)
    && !/^(\/\/---|◆)/.test(line);
}

/** A drag is exactly one complete row or fold, never a tab delimiter. */
export function isPaletteDragItem(text: string): boolean {
  const doc = parsePaletteDocument(text);
  if (doc.tabs.length !== 1 || doc.tabs[0].children.length !== 1) return false;
  const valid = (node: PaletteNode): boolean => node.kind === 'fold'
    ? !!node.closed && node.children.every(valid)
    : !paletteDirective(node.text);
  return valid(doc.tabs[0].children[0]);
}

export function movePaletteItem(source: string, start: number, end: number, position: number): { lines: string[]; insertedAt: number } | null {
  const lines = source.split(/\r?\n/);
  if (![start, end, position].every(Number.isInteger) || start < 0 || start >= end || end > lines.length || position < 0 || position > lines.length) return null;
  // Including the two boundaries makes dropping back in the same slot a no-op.
  if (position >= start && position <= end) return null;
  const item = lines.slice(start, end);
  if (!isPaletteDragItem(item.join('\n'))) return null;
  lines.splice(start, end - start);
  const insertedAt = position > end ? position - (end - start) : position;
  lines.splice(insertedAt, 0, ...item);
  return { lines, insertedAt };
}
