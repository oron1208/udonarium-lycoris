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
