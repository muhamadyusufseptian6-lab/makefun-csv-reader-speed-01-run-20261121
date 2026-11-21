// csv-reader-speed-01: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// The reading policy, as the competition states it: one left-to-right pass;
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a
// line left with no characters is no record; a CR outside quotes that is not
// followed by LF is dropped (stray_cr); a field that opens with a quote runs
// to the next quote that is not doubled ("" inside it is one quote, and each
// CRLF or lone CR inside it is read as LF); what follows its closing quote,
// up to the next comma or line break, is appended as it stands (quote_junk,
// when the field ends); a quote that never closes is a literal character and
// the text after it is read again as unquoted (unterminated_quote); a quote
// inside an unquoted field is a literal character; fields stay strings,
// never trimmed or converted; columns is the first record when header is
// true, else null; rows holds the records after it, each padded with ""
// (short_row, with fields: its field count) or cut (long_row, with extra:
// the cut fields) to the first record's width; each error is
// {code, line, row}, in the order met, a record's short_row or long_row when
// the record ends, line the 1-based line its record starts on (every LF,
// CRLF and lone CR inside quotes counted), row its record's index in rows,
// null for the header.
//
// Speed comes from never reading the common case one character at a time.
// A record whose line holds no quote at all is split in one go (a slice and
// one split(','), with a single scan for stray CRs). A record that does hold
// a quote is read in stretches: the quote-free stretch up to the next quote
// splits whole, a quoted field is found with indexOf and sliced whole, and
// only a quoted field holding a doubled quote or a line break needs
// piece-by-piece work. Nothing is cached from one case to the next.

const COMMA = 44; // ','
const LF = 10; // '\n'
const CR = 13; // '\r'
const QUOTE = 34; // '"'
const BOM = 0xfeff;

// How a field ended: at a comma, at a line break, or at the end of the text.
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === BOM) pos = 1;

  // The record being read: the line it starts on, and the index in rows it
  // takes (null for the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  // Finishes a record that was read whole: sets the width, keeps the header,
  // or pads/cuts the row to the width and records short_row/long_row.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  // The field the readers below just read, and how it ended. The readers
  // write these instead of returning an object, so a hot field costs no
  // allocation.
  let fValue = '';
  let fEnded = AT_END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Sets fValue,
  // fEnded and fAdded, where `added` counts the characters kept. Used for
  // the field after an unterminated quote, for the junk after a closing
  // quote, and for an unquoted field that holds a literal quote.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      const iComma = text.indexOf(',', pos);
      const iLF = text.indexOf('\n', pos);
      const iCR = text.indexOf('\r', pos);
      let end = iComma;
      let kind = AT_COMMA;
      if (iLF !== -1 && (end === -1 || iLF < end)) {
        end = iLF;
        kind = AT_BREAK;
      }
      if (iCR !== -1 && (end === -1 || iCR < end)) {
        end = iCR;
        kind = CR;
      }
      if (end === -1) {
        added += n - pos;
        fValue = value + text.slice(pos, n);
        pos = n;
        fEnded = AT_END;
        fAdded = added;
        return;
      }
      if (kind === AT_COMMA) {
        added += end - pos;
        value += text.slice(pos, end);
        pos = end + 1;
        fValue = value;
        fEnded = AT_COMMA;
        fAdded = added;
        return;
      }
      if (kind === AT_BREAK) {
        added += end - pos;
        value += text.slice(pos, end);
        pos = end + 1;
        line += 1;
        fValue = value;
        fEnded = AT_BREAK;
        fAdded = added;
        return;
      }
      // A CR: with LF after it the record ends; alone it is dropped.
      if (text.charCodeAt(end + 1) === LF) {
        added += end - pos;
        value += text.slice(pos, end);
        pos = end + 2;
        line += 1;
        fValue = value;
        fEnded = AT_BREAK;
        fAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      added += end - pos;
      value += text.slice(pos, end);
      pos = end + 1;
    }
  }

  // Reads the inside of a quoted field, the span [a, b), where a doubled
  // quote is one quote and each CRLF or lone CR is one LF. Only called when
  // the span holds a line break, so every line it crosses is counted here.
  function readQuotedSpan(a, b) {
    let value = '';
    let p = a;
    while (p < b) {
      let next = b;
      const iQuote = text.indexOf('"', p);
      if (iQuote !== -1 && iQuote < next) next = iQuote;
      const iCR = text.indexOf('\r', p);
      if (iCR !== -1 && iCR < next) next = iCR;
      const iLF = text.indexOf('\n', p);
      if (iLF !== -1 && iLF < next) next = iLF;
      if (next > p) value += text.slice(p, next);
      p = next;
      if (p >= b) break;
      const c = text.charCodeAt(p);
      if (c === QUOTE) {
        value += '"';
        p += 2;
      } else if (c === CR) {
        value += '\n';
        line += 1;
        p += text.charCodeAt(p + 1) === LF ? 2 : 1;
      } else {
        value += '\n';
        line += 1;
        p += 1;
      }
    }
    return value;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // Find the closing quote: the first '"' not followed by '"'.
    let close = -1;
    let doubled = false;
    let i = pos;
    for (;;) {
      const j = text.indexOf('"', i);
      if (j === -1) break;
      if (text.charCodeAt(j + 1) === QUOTE) {
        doubled = true;
        i = j + 2;
        continue;
      }
      close = j;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted. The line is as it was when the
      // quote opened, since the failed scan counts no lines.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    let value;
    const iLF = text.indexOf('\n', pos);
    const iCR = text.indexOf('\r', pos);
    const hasBreak =
      (iLF !== -1 && iLF < close) || (iCR !== -1 && iCR < close);
    if (!doubled && !hasBreak) {
      value = text.slice(pos, close);
    } else if (!hasBreak) {
      value = text.slice(pos, close).replaceAll('""', '"');
    } else {
      value = readQuotedSpan(pos, close);
    }
    pos = close + 1;
    if (pos >= n) {
      fValue = value;
      fEnded = AT_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      fValue = value;
      fEnded = AT_COMMA;
      return;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = AT_BREAK;
      return;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = AT_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Pushes the unquoted fields of `lineText` (a whole line, or the rest of
  // a record), dropping stray CRs, onto `fields`. The line holds no quote.
  function pushUnquotedLine(lineText, fields) {
    const parts = lineText.split(',');
    if (lineText.indexOf('\r') !== -1) {
      for (let k = 0; k < parts.length; k++) {
        const f = parts[k];
        if (f.indexOf('\r') !== -1) {
          const segs = f.split('\r');
          for (let m = 1; m < segs.length; m++) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          parts[k] = segs.join('');
        }
      }
    }
    fields.push(...parts);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's line, up to its line break: a quote anywhere in it means
    // the record needs stretch-by-stretch reading; without one it splits whole.
    const lineEnd = text.indexOf('\n', pos);
    const le = lineEnd === -1 ? n : lineEnd;
    let lineText = text.slice(pos, le);
    if (lineEnd !== -1 && lineText.charCodeAt(lineText.length - 1) === CR) {
      lineText = lineText.slice(0, -1);
    }

    if (lineText.indexOf('"') === -1) {
      // No quote: split the line whole; the split itself is the fields.
      const fields = lineText.split(',');
      if (lineText.indexOf('\r') !== -1) {
        for (let k = 0; k < fields.length; k++) {
          const f = fields[k];
          if (f.indexOf('\r') !== -1) {
            const segs = f.split('\r');
            for (let m = 1; m < segs.length; m++) {
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            }
            fields[k] = segs.join('');
          }
        }
      }
      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (!(fields.length === 1 && fields[0] === '')) finishRecord(fields);
      if (lineEnd !== -1) {
        pos = lineEnd + 1;
        line += 1;
      } else {
        pos = n;
      }
      continue;
    }

    // The record holds a quote: read it in stretches. `quoted` says whether
    // the last field read was a quoted one, for the stray-CRs-only check.
    const fields = [];
    let quoted = false;
    for (;;) {
      // The next quote and the next line break from here.
      const nl = text.indexOf('\n', pos);
      const q = text.indexOf('"', pos);
      if (q === -1 || (nl !== -1 && nl < q)) {
        // No quote before the next line break (or no quote at all): the rest
        // of the record is unquoted fields up to that break, or to the end.
        const end = nl === -1 ? n : nl;
        let rest = text.slice(pos, end);
        if (nl !== -1 && rest.charCodeAt(rest.length - 1) === CR) rest = rest.slice(0, -1);
        pushUnquotedLine(rest, fields);
        quoted = false;
        if (nl !== -1) {
          pos = nl + 1;
          line += 1;
        } else {
          pos = n;
        }
        break;
      }
      if (q === pos) {
        // A quoted field opens here.
        readQuoted();
        fields.push(fValue);
        quoted = true;
        if (fEnded !== AT_COMMA) break;
        continue;
      }
      // A quote-free stretch up to the quote: every piece but the last is a
      // whole field; the last piece is either empty (the quote opens the
      // next field) or the start of an unquoted field holding a literal
      // quote. A stray CR in the stretch falls back to one slow field.
      const stretch = text.slice(pos, q);
      if (stretch.indexOf('\r') !== -1) {
        readUnquoted('');
        fields.push(fValue);
        quoted = false;
        if (fEnded !== AT_COMMA) break;
        continue;
      }
      const parts = stretch.split(',');
      const last = parts[parts.length - 1];
      for (let k = 0; k < parts.length - 1; k++) fields.push(parts[k]);
      quoted = false;
      if (last === '') {
        pos = q;
      } else {
        pos = q - last.length;
        readUnquoted('');
        fields.push(fValue);
        quoted = false;
        if (fEnded !== AT_COMMA) break;
      }
    }
    if (!(fields.length === 1 && fields[0] === '' && !quoted)) finishRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
