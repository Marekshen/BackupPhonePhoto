import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IncrementalSha256, sha256File } from './hash';
import { parseFilenameTime, readLocalMediaInfo } from './media';

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

function exifTiff(date: string, offset: string): Uint8Array {
  return bytes(56 + 20 + 7, (v) => {
    v.setUint16(0, 0x4949);
    v.setUint16(2, 42, true);
    v.setUint32(4, 8, true);
    v.setUint16(8, 1, true);
    v.setUint16(10, 0x8769, true);
    v.setUint16(12, 4, true);
    v.setUint32(14, 1, true);
    v.setUint32(18, 26, true);
    v.setUint16(26, 2, true);
    [[0x9003, 20, 56], [0x9011, 7, 76]].forEach(([tag, count, at], i) => {
      const e = 28 + i * 12;
      v.setUint16(e, tag, true);
      v.setUint16(e + 2, 2, true);
      v.setUint32(e + 4, count, true);
      v.setUint32(e + 8, at, true);
    });
    ascii(date).forEach((c, i) => v.setUint8(56 + i, c));
    ascii(offset).forEach((c, i) => v.setUint8(76 + i, c));
  });
}

const SHOT = Date.UTC(2024, 4, 1, 2, 20, 30);

describe('拍攝時間', () => {
  it('JPEG 讀取 EXIF DateTimeOriginal 與時區', async () => {
    const tiff = exifTiff('2024:05:01 10:20:30', '+08:00');
    const app1 = new Uint8Array([0xff, 0xe1, 0, 0, ...ascii('Exif'), 0, 0, ...tiff]);
    new DataView(app1.buffer).setUint16(2, app1.length - 2);
    const sof = new Uint8Array([0xff, 0xc0, 0x00, 0x11, 8, 0x0b, 0xb8, 0x0f, 0xa0, 3]);
    const file = new File([new Uint8Array([0xff, 0xd8]), app1, sof, bytes(20)], 'a.jpg', { type: 'image/jpeg', lastModified: 1 });
    expect(await readLocalMediaInfo(file)).toMatchObject({ captureTime: SHOT, captureSource: 'EXIF' });
  });

  it('HEIC 經由 iloc 讀取 Exif 項目', async () => {
    const payload = new Uint8Array([0, 0, 0, 6, ...ascii('Exif'), 0, 0, ...exifTiff('2024:05:01 10:20:30', '+08:00')]);
    const infe = (id: number, type: string) => box('infe', new Uint8Array([2, 0, 0, 0, 0, id, 0, 0]), ascii(type), bytes(1));
    const iinf = box('iinf', bytes(4), bytes(2, (v) => v.setUint16(0, 2)), infe(1, 'hvc1'), infe(2, 'Exif'));
    const iloc = (offset: number) => box('iloc', bytes(18, (v) => {
      v.setUint8(4, 0x44);
      v.setUint16(6, 1);
      v.setUint16(8, 2);
      v.setUint16(12, 1);
      v.setUint32(14, offset);
    }), bytes(4, (v) => v.setUint32(0, payload.length)));
    const ftyp = box('ftyp', ascii('heic'), bytes(4));
    const makeMeta = (offset: number) => box('meta', bytes(4), box('hdlr', bytes(24)), iinf, iloc(offset));
    const meta = makeMeta(ftyp.length + makeMeta(0).length);
    const file = new File([ftyp, meta, payload], 'IMG_0003.HEIC', { type: 'image/heic', lastModified: 1 });
    expect(await readLocalMediaInfo(file)).toMatchObject({ captureTime: SHOT, captureSource: 'EXIF' });
  });

  it('MOV 優先使用 Apple creationdate，否則用 mvhd', async () => {
    const mvhd = box('mvhd', bytes(100, (v) => {
      v.setUint32(4, Math.floor(SHOT / 1000) + 2082844800 - 3600);
      v.setUint32(12, 600);
      v.setUint32(16, 6000);
    }));
    const key = 'com.apple.quicktime.creationdate';
    const keys = box('keys', bytes(4), bytes(4, (v) => v.setUint32(0, 1)), bytes(8, (v) => v.setUint32(0, 8 + key.length)), ascii(key));
    ascii('mdta').forEach((c, i) => keys[20 + i] = c);
    const value = ascii('2024-05-01T10:20:30+0800');
    const data = box('data', bytes(8, (v) => v.setUint32(0, 1)), value);
    const entry = box('xxxx', data);
    new DataView(entry.buffer).setUint32(4, 1);
    const meta = box('meta', box('hdlr', bytes(24)), keys, box('ilst', entry));
    const make = (...parts: Uint8Array[]) => new File([box('ftyp', ascii('qt  '), bytes(4)), box('moov', ...parts)], 'a.mov', { type: 'video/quicktime', lastModified: 1 });
    expect(await readLocalMediaInfo(make(mvhd, meta))).toMatchObject({ captureTime: SHOT, captureSource: '影片拍攝時間' });
    expect(await readLocalMediaInfo(make(mvhd))).toMatchObject({ captureTime: SHOT - 3600000, captureSource: '影片建立時間' });
  });

  it('螢幕錄影優先使用檔名時間，而非 mvhd 的匯出時間', async () => {
    const mvhd = box('mvhd', bytes(100, (v) => {
      v.setUint32(4, Math.floor(Date.now() / 1000) + 2082844800);
      v.setUint32(12, 600);
      v.setUint32(16, 6000);
    }));
    const file = new File([box('ftyp', ascii('qt  '), bytes(4)), box('moov', mvhd)], 'ScreenRecording_06-27-2026 17-14-45_1.mov', { type: 'video/quicktime' });
    expect(await readLocalMediaInfo(file)).toMatchObject({ captureTime: new Date(2026, 5, 27, 17, 14, 45).getTime(), captureSource: '檔名' });
    expect(parseFilenameTime('PXL_20240501_102030123.jpg')).toBe(new Date(2024, 4, 1, 10, 20, 30).getTime());
    expect(parseFilenameTime('IMG_8379.jpeg')).toBeUndefined();
  });

  it('找不到時改用檔案修改時間', async () => {
    const file = new File([bytes(10)], 'a.png', { type: 'image/png', lastModified: 123456 });
    expect(await readLocalMediaInfo(file)).toMatchObject({ captureTime: 123456 });
  });
});
