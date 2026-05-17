// SPDX-License-Identifier: MIT
// Reference implementation for B4-v3 oracle validation.

export function parseJSON5(input: string): unknown {
  let pos = 0;

  function error(msg: string): never {
    throw new SyntaxError(`JSON5 parse error at position ${pos}: ${msg}`);
  }

  function skipWhitespaceAndComments(): void {
    while (pos < input.length) {
      const ch = input[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' ||
          ch === '\v' || ch === '\f' || ch === ' ' ||
          ch === ' ' || ch === ' ') {
        pos++;
        continue;
      }
      if (ch === '/' && input[pos + 1] === '/') {
        pos += 2;
        while (pos < input.length &&
               input[pos] !== '\n' && input[pos] !== '\r' &&
               input[pos] !== ' ' && input[pos] !== ' ') {
          pos++;
        }
        continue;
      }
      if (ch === '/' && input[pos + 1] === '*') {
        pos += 2;
        const end = input.indexOf('*/', pos);
        if (end === -1) error('Unterminated block comment');
        pos = end + 2;
        continue;
      }
      break;
    }
  }

  function parseValue(): unknown {
    skipWhitespaceAndComments();
    if (pos >= input.length) error('Unexpected end of input');
    const ch = input[pos];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === "'") return parseString(ch);
    if (ch === 't') return parseKeyword('true', true);
    if (ch === 'f') return parseKeyword('false', false);
    if (ch === 'n') return parseKeyword('null', null);
    if (ch === 'I') return parseKeyword('Infinity', Infinity);
    if (ch === 'N') return parseKeyword('NaN', NaN);
    if (ch === '-' || ch === '+' || ch === '.' ||
        (ch >= '0' && ch <= '9')) return parseNumber();
    error(`Unexpected character: ${JSON.stringify(ch)}`);
  }

  function parseKeyword(keyword: string, value: unknown): unknown {
    if (input.startsWith(keyword, pos)) {
      pos += keyword.length;
      return value;
    }
    error(`Expected '${keyword}'`);
  }

  function parseObject(): Record<string, unknown> {
    pos++; // consume '{'
    const obj: Record<string, unknown> = {};
    skipWhitespaceAndComments();
    if (pos < input.length && input[pos] === '}') { pos++; return obj; }
    while (true) {
      skipWhitespaceAndComments();
      if (pos >= input.length) error('Unterminated object');
      const kch = input[pos];
      let key: string;
      if (kch === '"' || kch === "'") {
        key = parseString(kch) as string;
      } else {
        key = parseIdentifier();
      }
      skipWhitespaceAndComments();
      if (pos >= input.length || input[pos] !== ':') error("Expected ':' after key");
      pos++;
      const value = parseValue();
      obj[key] = value;
      skipWhitespaceAndComments();
      if (pos >= input.length) error('Unterminated object');
      if (input[pos] === ',') {
        pos++;
        skipWhitespaceAndComments();
        if (pos < input.length && input[pos] === '}') { pos++; break; }
      } else if (input[pos] === '}') {
        pos++;
        break;
      } else {
        error("Expected ',' or '}' in object");
      }
    }
    return obj;
  }

  function parseArray(): unknown[] {
    pos++; // consume '['
    const arr: unknown[] = [];
    skipWhitespaceAndComments();
    if (pos < input.length && input[pos] === ']') { pos++; return arr; }
    while (true) {
      skipWhitespaceAndComments();
      if (pos >= input.length) error('Unterminated array');
      if (input[pos] === ']') { pos++; break; }
      arr.push(parseValue());
      skipWhitespaceAndComments();
      if (pos >= input.length) error('Unterminated array');
      if (input[pos] === ',') {
        pos++;
        skipWhitespaceAndComments();
        if (pos < input.length && input[pos] === ']') { pos++; break; }
      } else if (input[pos] === ']') {
        pos++;
        break;
      } else {
        error("Expected ',' or ']' in array");
      }
    }
    return arr;
  }

  function parseString(quote: string): string {
    pos++; // consume opening quote
    let result = '';
    while (pos < input.length) {
      const ch = input[pos];
      if (ch === quote) { pos++; return result; }
      if (ch === '\\') {
        pos++;
        if (pos >= input.length) error('Unterminated escape sequence');
        const esc = input[pos];
        pos++;
        switch (esc) {
          case '"': result += '"'; break;
          case "'": result += "'"; break;
          case '\\': result += '\\'; break;
          case '/': result += '/'; break;
          case 'b': result += '\b'; break;
          case 'f': result += '\f'; break;
          case 'n': result += '\n'; break;
          case 'r': result += '\r'; break;
          case 't': result += '\t'; break;
          case 'v': result += '\v'; break;
          case '0': result += '\0'; break;
          case 'x': {
            const hex = input.slice(pos, pos + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) error('Invalid \\x escape');
            result += String.fromCharCode(parseInt(hex, 16));
            pos += 2;
            break;
          }
          case 'u': {
            const hex = input.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) error('Invalid \\u escape');
            result += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          case '\r':
            if (input[pos] === '\n') pos++; // CRLF
            break; // line continuation
          case '\n':
          case ' ':
          case ' ':
            break; // line continuation
          default:
            result += esc; // other escapes pass through
        }
      } else if (ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ') {
        error('Unescaped newline in string');
      } else {
        result += ch;
        pos++;
      }
    }
    error('Unterminated string');
  }

  function parseIdentifier(): string {
    let result = '';
    while (pos < input.length) {
      const ch = input[pos];
      if (result.length === 0) {
        if (!/[\p{ID_Start}$_]/u.test(ch)) error(`Expected identifier start, got ${JSON.stringify(ch)}`);
      } else {
        if (!/[\p{ID_Continue}$_‌‍]/u.test(ch)) break;
      }
      result += ch;
      pos++;
    }
    if (result.length === 0) error('Expected identifier');
    return result;
  }

  function parseNumber(): number {
    let sign = 1;
    if (input[pos] === '+') { pos++; }
    else if (input[pos] === '-') { sign = -1; pos++; }

    if (input.startsWith('Infinity', pos)) { pos += 8; return sign * Infinity; }

    if (input[pos] === '0' && (input[pos + 1] === 'x' || input[pos + 1] === 'X')) {
      pos += 2;
      const start = pos;
      while (pos < input.length && /[0-9a-fA-F]/.test(input[pos])) pos++;
      if (pos === start) error('Invalid hex literal');
      return sign * parseInt(input.slice(start, pos), 16);
    }

    const start = pos;
    while (pos < input.length && input[pos] >= '0' && input[pos] <= '9') pos++;
    if (pos < input.length && input[pos] === '.') {
      pos++;
      while (pos < input.length && input[pos] >= '0' && input[pos] <= '9') pos++;
    }
    if (pos < input.length && (input[pos] === 'e' || input[pos] === 'E')) {
      pos++;
      if (pos < input.length && (input[pos] === '+' || input[pos] === '-')) pos++;
      while (pos < input.length && input[pos] >= '0' && input[pos] <= '9') pos++;
    }
    const numStr = input.slice(start, pos);
    if (numStr === '' || numStr === '.') error('Invalid number literal');
    return sign * parseFloat(numStr);
  }

  const result = parseValue();
  skipWhitespaceAndComments();
  if (pos !== input.length) error('Unexpected content after value');
  return result;
}
