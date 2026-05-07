import { describe, it, expect } from 'vitest';
import { escapeCell, toCsv } from '../server/lib/csv.js';

describe('escapeCell', () => {
  it('passes plain text through unchanged', () => {
    expect(escapeCell('hello')).toBe('hello');
    expect(escapeCell('Acme Co')).toBe('Acme Co');
  });

  it('coerces numbers to their decimal string', () => {
    expect(escapeCell(0)).toBe('0');
    expect(escapeCell(1234)).toBe('1234');
    expect(escapeCell(12.5)).toBe('12.5');
  });

  it('renders null and undefined as empty strings', () => {
    expect(escapeCell(null)).toBe('');
    expect(escapeCell(undefined)).toBe('');
  });

  it('wraps in quotes when the cell contains a comma', () => {
    expect(escapeCell('Smith, John')).toBe('"Smith, John"');
  });

  it('wraps and doubles internal quotes', () => {
    expect(escapeCell('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('wraps when the cell contains a newline or carriage return', () => {
    expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCell('line1\rline2')).toBe('"line1\rline2"');
  });
});

describe('toCsv', () => {
  it('joins headers and rows with CRLF line terminators (RFC 4180)', () => {
    const out = toCsv(['a', 'b'], [[1, 2], [3, 4]]);
    expect(out).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('does not emit a trailing newline', () => {
    const out = toCsv(['x'], [['y']]);
    expect(out.endsWith('\r\n')).toBe(false);
  });

  it('escapes cells per row', () => {
    const out = toCsv(['name', 'note'], [['Acme, Inc.', 'has "quotes"']]);
    expect(out).toBe('name,note\r\n"Acme, Inc.","has ""quotes"""');
  });

  it('handles an empty rows array (header-only output)', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});
