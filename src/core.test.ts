import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IncrementalSha256, sha256File } from './hash';
import { readLocalMediaInfo } from './media';

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const len = 8 + parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  out.set(new TextEncoder().encode(type), 4);
  let pos = 8;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function bytes(n: number, fill: (v: DataView) => void = () => {}): Uint8Array {
  const out = new Uint8Array(n);
  fill(new DataView(out.buffer));
  return out;
}

const ascii = (s: string) => new TextEncoder().encode(s);

describe('IncrementalSha256', () => {
  it('重疊餵入時結果與整檔雜湊相同', async () => {
    const data = bytes(1000, (v) => { for (let i = 0; i < 1000; i++) v.setUint8(i, i % 251); });
    const h = await IncrementalSha256.create();
    h.feed(data.subarray(0, 400), 0);
    h.feed(data.subarray(300, 700), 300);
    h.feed(data.subarray(700), 700);
    const expected = createHash('sha256').update(data).digest('hex');
    expect(h.digest()).toBe(expected);
    expect(await sha256File(new Blob([data]))).toBe(expected);
  });

  it('資料不連續時拋出錯誤', async () => {
    const h = await IncrementalSha256.create();
    h.feed(bytes(10), 0);
    expect(() => h.feed(bytes(10), 20)).toThrow();
  });
});

describe('readLocalMediaInfo', () => {
  it('解析 MOV 的編碼、解析度、長度與 HDR', async () => {
    const mvhd = box('mvhd', bytes(100, (v) => { v.setUint32(12, 600); v.setUint32(16, 6000); }));
    const hdlr = box('hdlr', bytes(4), bytes(4), ascii('vide'), bytes(12));
    const colr = box('colr', ascii('nclx'), bytes(7, (v) => { v.setUint16(0, 9); v.setUint16(2, 18); v.setUint16(4, 9); }));
    const hvc1 = box('hvc1', bytes(78, (v) => { v.setUint16(24, 3840); v.setUint16(26, 2160); }), box('hvcC', bytes(4)), colr, box('dvvC', bytes(24)));
    const stsd = box('stsd', bytes(4), bytes(4, (v) => v.setUint32(0, 1)), hvc1);
    const trak = box('trak', box('tkhd', bytes(84)), box('mdia', box('mdhd', bytes(24)), hdlr, box('minf', box('stbl', stsd))));
    const moov = box('moov', mvhd, trak);
    const ftyp = box('ftyp', ascii('qt  '), bytes(4));
    const mdat = box('mdat', bytes(5000));
    const file = new File([ftyp, mdat, moov], 'IMG_0001.MOV', { type: 'video/quicktime' });

    const info = await readLocalMediaInfo(file);
    expect(info).toMatchObject({ kind: 'video', container: 'qt', codec: 'hvc1', width: 3840, height: 2160, durationSec: 10 });
    expect(info.hdr).toBe('HLG + Dolby Vision');
  });

  it('解析 JPEG 解析度與 EXIF', async () => {
    const app1 = new Uint8Array([0xff, 0xe1, 0x00, 0x08, ...ascii('Exif'), 0, 0]);
    const sof = new Uint8Array([0xff, 0xc0, 0x00, 0x11, 8, 0x0b, 0xb8, 0x0f, 0xa0, 3]);
    const file = new File([new Uint8Array([0xff, 0xd8]), app1, sof, bytes(20)], 'a.jpg', { type: 'image/jpeg' });
    expect(await readLocalMediaInfo(file)).toMatchObject({ container: 'JPEG', width: 4000, height: 3000, hasExif: true });
  });

  it('解析 HEIC 主影像尺寸與 EXIF', async () => {
    const infe = (id: number, type: string) => box('infe', new Uint8Array([2, 0, 0, 0, 0, id, 0, 0]), ascii(type), bytes(1));
    const iinf = box('iinf', bytes(4), bytes(2, (v) => v.setUint16(0, 2)), infe(1, 'grid'), infe(2, 'Exif'));
    const ispe = (w: number, h: number) => box('ispe', bytes(12, (v) => { v.setUint32(4, w); v.setUint32(8, h); }));
    const meta = box('meta', bytes(4), box('hdlr', bytes(24)), iinf, box('iprp', box('ipco', ispe(512, 512), ispe(5712, 4284))));
    const file = new File([box('ftyp', ascii('heic'), bytes(4)), meta], 'IMG_0002.HEIC', { type: 'image/heic' });
    expect(await readLocalMediaInfo(file)).toMatchObject({ container: 'HEIF (heic)', width: 5712, height: 4284, hasExif: true });
  });
});
