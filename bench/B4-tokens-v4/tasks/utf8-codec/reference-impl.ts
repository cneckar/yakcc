// SPDX-License-Identifier: MIT
// UTF-8 encode/decode without TextEncoder/TextDecoder.

export class Utf8Codec {
  encode(str: string): Uint8Array {
    const out: number[] = [];
    let i = 0;
    while (i < str.length) {
      let cp = str.charCodeAt(i++);
      // High surrogate — try to combine with following low surrogate
      if (cp >= 0xD800 && cp <= 0xDBFF && i < str.length) {
        const lo = str.charCodeAt(i);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          i++;
        }
        // Unpaired high surrogate: fall through to 3-byte encoding (CESU-8 lenient)
      }

      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      } else if (cp < 0x10000) {
        out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(
          0xF0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3F),
          0x80 | ((cp >> 6) & 0x3F),
          0x80 | (cp & 0x3F),
        );
      }
    }
    return new Uint8Array(out);
  }

  decode(bytes: Uint8Array): string {
    let str = '';
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i++]!;
      let cp: number;
      let extraBytes: number;

      if ((b0 & 0x80) === 0) {
        cp = b0;
        extraBytes = 0;
      } else if ((b0 & 0xE0) === 0xC0) {
        cp = b0 & 0x1F;
        extraBytes = 1;
      } else if ((b0 & 0xF0) === 0xE0) {
        cp = b0 & 0x0F;
        extraBytes = 2;
      } else if ((b0 & 0xF8) === 0xF0) {
        cp = b0 & 0x07;
        extraBytes = 3;
      } else {
        throw new TypeError(`Invalid UTF-8 lead byte 0x${b0.toString(16).padStart(2, '0')} at index ${i - 1}`);
      }

      if (i + extraBytes > bytes.length) {
        throw new TypeError(`Truncated UTF-8 sequence at index ${i - 1}`);
      }

      for (let j = 0; j < extraBytes; j++) {
        const cb = bytes[i++]!;
        if ((cb & 0xC0) !== 0x80) {
          throw new TypeError(`Invalid UTF-8 continuation byte 0x${cb.toString(16).padStart(2, '0')} at index ${i - 1}`);
        }
        cp = (cp << 6) | (cb & 0x3F);
      }

      // Reject overlong encodings
      if (
        (extraBytes === 1 && cp < 0x80) ||
        (extraBytes === 2 && cp < 0x800) ||
        (extraBytes === 3 && cp < 0x10000)
      ) {
        throw new TypeError(`Overlong UTF-8 encoding for U+${cp.toString(16).padStart(4, '0')}`);
      }

      // Reject surrogate code points in decoded bytes
      if (cp >= 0xD800 && cp <= 0xDFFF) {
        throw new TypeError(`UTF-8 bytes decode to surrogate code point U+${cp.toString(16).padStart(4, '0')}`);
      }

      // Reject code points above U+10FFFF
      if (cp > 0x10FFFF) {
        throw new TypeError(`Code point U+${cp.toString(16)} exceeds U+10FFFF`);
      }

      if (cp >= 0x10000) {
        cp -= 0x10000;
        str += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        str += String.fromCharCode(cp);
      }
    }
    return str;
  }
}
