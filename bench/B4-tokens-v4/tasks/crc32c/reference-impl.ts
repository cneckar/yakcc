// SPDX-License-Identifier: MIT
// CRC-32C (Castagnoli) reference implementation.
// Polynomial: 0x82F63B78 (reflected) — NOT CRC-32 (0xEDB88320).

/** @decision DEC-BENCH-B4-V4-TASK-CRC32C-001: reference uses Castagnoli poly 0x82F63B78 */
export class CRC32C {
  private static readonly TABLE: Uint32Array = CRC32C.buildTable();
  private crc: number = 0xFFFFFFFF;

  private static buildTable(): Uint32Array {
    const POLY = 0x82F63B78;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  }

  update(data: Uint8Array | string): this {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let crc = this.crc;
    const table = CRC32C.TABLE;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    }
    this.crc = crc;
    return this;
  }

  digest(): number {
    return (this.crc ^ 0xFFFFFFFF) >>> 0;
  }

  reset(): void {
    this.crc = 0xFFFFFFFF;
  }

  clone(): CRC32C {
    const copy = new CRC32C();
    copy.crc = this.crc;
    return copy;
  }
}
