/** Finite decimal arithmetic only: no JavaScript execution or partial parsing. */
export function evaluateArithmetic(source: string): number | null {
  if (source.length > 4096) return null;
  let pos = 0;
  let depth = 0;
  const skip = () => { while (/\s/.test(source[pos] || '') && pos < source.length) pos++; };
  const primary = (): number => {
    if (++depth > 64) throw new Error('Expression too deep');
    skip();
    let value: number;
    const sign = source[pos];
    if (sign === '+' || sign === '-') {
      pos++;
      value = primary() * (sign === '-' ? -1 : 1);
    } else if (sign === '(') {
      pos++;
      value = expression();
      skip();
      if (source[pos++] !== ')') throw new Error('Unclosed parenthesis');
    } else {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(pos));
      if (!match) throw new Error('Expected number');
      pos += match[0].length;
      value = Number(match[0]);
    }
    depth--;
    return value;
  };
  const product = (): number => {
    let value = primary();
    skip();
    while (source[pos] === '*' || source[pos] === '/') {
      const op = source[pos++];
      const right = primary();
      value = op === '*' ? value * right : value / right;
      skip();
    }
    return value;
  };
  const expression = (): number => {
    let value = product();
    skip();
    while (source[pos] === '+' || source[pos] === '-') {
      const op = source[pos++];
      const right = product();
      value = op === '+' ? value + right : value - right;
      skip();
    }
    return value;
  };
  try {
    const value = expression();
    skip();
    return pos === source.length && Number.isFinite(value) ? value : null;
  } catch (_) {
    return null;
  }
}
