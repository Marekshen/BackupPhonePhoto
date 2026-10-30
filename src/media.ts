export interface LocalMediaInfo {
  kind: 'image' | 'video' | 'other';
  container?: string;
  codec?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  bitrateMbps?: number;
  hdr?: string;
  hasExif?: boolean;
  note?: string;
  captureTime?: number;
  captureSource?: string;
}

interface Box {
  type: string;
  start: number;
  end: number;
  bodyStart: number;
}

function fourcc(view: DataView, pos: number): string {
  return String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
}

function* boxes(view: DataView, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = fourcc(view, pos + 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos, end: pos + size, bodyStart: pos + header };
    pos += size;
  }
}

function child(view: DataView, parent: Box, type: string, offset = 0): Box | undefined {
  for (const b of boxes(view, parent.bodyStart + offset, parent.end)) if (b.type === type) return b;
  return undefined;
}

async function readTopLevelBox(file: File, type: string): Promise<DataView | null> {
  let pos = 0;
  while (pos + 8 <= file.size) {
    const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const t = fourcc(head, 4);
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) return null;
    if (t === type) {
      if (size > 64 * 1024 * 1024) return null;
      return new DataView(await file.slice(pos, pos + size).arrayBuffer());
    }
    pos += size;
  }
  return null;
}

function exifDate(text: string, offset?: string): number | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (!y) return undefined;
  const tz = offset ? /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim()) : null;
  if (tz) {
    const sign = tz[1] === '-' ? -1 : 1;
    return Date.UTC(y, mo - 1, d, h, mi, se) - sign * (Number(tz[2]) * 60 + Number(tz[3])) * 60000;
  }
  return new Date(y, mo - 1, d, h, mi, se).getTime();
}

export function parseExifTime(view: DataView, tiff: number): number | undefined {
  if (tiff + 8 > view.byteLength) return undefined;
  const le = view.getUint16(tiff) === 0x4949;
  const u16 = (p: number) => view.getUint16(p, le);
  const u32 = (p: number) => view.getUint32(p, le);
  const readIfd = (ifd: number) => {
    const tags = new Map<number, string | number>();
    const start = tiff + ifd;
    if (start + 2 > view.byteLength) return tags;
    const n = u16(start);
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > view.byteLength) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (type === 2) {
        const at = count > 4 ? tiff + u32(e + 8) : e + 8;
        if (at + count > view.byteLength) continue;
        let str = '';
        for (let k = 0; k < count; k++) {
          const c = view.getUint8(at + k);
          if (c === 0) break;
          str += String.fromCharCode(c);
        }
        tags.set(tag, str);
      } else if (type === 4) {
        tags.set(tag, u32(e + 8));
      }
    }
    return tags;
  };
  const ifd0 = readIfd(u32(tiff + 4));
  const exifPtr = ifd0.get(0x8769);
  const exif = typeof exifPtr === 'number' ? readIfd(exifPtr) : new Map<number, string | number>();
  const str = (tag: number) => {
    const v = exif.get(tag);
    return typeof v === 'string' ? v : undefined;
  };
  const original = str(0x9003) ?? str(0x9004);
  const t = original && exifDate(original, str(0x9011) ?? str(0x9012) ?? str(0x9010));
  if (t) return t;
  const dt = ifd0.get(0x0132);
  return typeof dt === 'string' ? exifDate(dt, str(0x9010)) : undefined;
}

function isoTime(text: string): number | undefined {
  const t = Date.parse(text.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? undefined : t;
}

function readString(view: DataView, start: number, end: number): string {
  return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + start, Math.max(0, end - start)));
}

function appleCreationDate(view: DataView, moov: Box): number | undefined {
  const meta = child(view, moov, 'meta');
  if (!meta) return undefined;
  const offset = child(view, meta, 'hdlr') ? 0 : 4;
  const keys = child(view, meta, 'keys', offset);
  const ilst = child(view, meta, 'ilst', offset);
  if (!keys || !ilst) return undefined;
  let index = 0;
  let target = 0;
  for (let p = keys.bodyStart + 8; p + 8 <= keys.end; ) {
    const size = view.getUint32(p);
    if (size < 8) break;
    index++;
    if (readString(view, p + 8, p + size) === 'com.apple.quicktime.creationdate') target = index;
    p += size;
  }
  if (!target) return undefined;
  for (const item of boxes(view, ilst.bodyStart, ilst.end)) {
    if (view.getUint32(item.start + 4) !== target) continue;
    const data = child(view, item, 'data');
    return data ? isoTime(readString(view, data.bodyStart + 8, data.end)) : undefined;
  }
  return undefined;
}

const TRANSFER: Record<number, string> = { 16: 'HDR10 (PQ)', 18: 'HLG' };

async function videoInfo(file: File): Promise<LocalMediaInfo> {
  const info: LocalMediaInfo = { kind: 'video' };
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  if (head.byteLength >= 12 && fourcc(head, 4) === 'ftyp') info.container = fourcc(head, 8).trim();
  const moovView = await readTopLevelBox(file, 'moov');
  if (!moovView) {
    info.note = '找不到 moov，無法解析影片資訊';
    return info;
  }
  const moov: Box = { type: 'moov', start: 0, end: moovView.byteLength, bodyStart: 8 };
  const mvhd = child(moovView, moov, 'mvhd');
  if (mvhd) {
    const v = moovView.getUint8(mvhd.bodyStart);
    const p = mvhd.bodyStart + 4;
    const timescale = v === 1 ? moovView.getUint32(p + 16) : moovView.getUint32(p + 8);
    const duration = v === 1 ? Number(moovView.getBigUint64(p + 20)) : moovView.getUint32(p + 12);
    if (timescale) info.durationSec = duration / timescale;
    const created = v === 1 ? Number(moovView.getBigUint64(p)) : moovView.getUint32(p);
    if (created > 2082844800) {
      info.captureTime = (created - 2082844800) * 1000;
      info.captureSource = '影片建立時間';
    }
  }
  const apple = appleCreationDate(moovView, moov);
  if (apple) {
    info.captureTime = apple;
    info.captureSource = '影片拍攝時間';
  }
  for (const trak of boxes(moovView, moov.bodyStart, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(moovView, trak, 'mdia');
    const hdlr = mdia && child(moovView, mdia, 'hdlr');
    if (!mdia || !hdlr || fourcc(moovView, hdlr.bodyStart + 8) !== 'vide') continue;
    const minf = child(moovView, mdia, 'minf');
    const stbl = minf && child(moovView, minf, 'stbl');
    const stsd = stbl && child(moovView, stbl, 'stsd');
    if (!stsd) continue;
    const entry = boxes(moovView, stsd.bodyStart + 8, stsd.end).next().value as Box | undefined;
    if (!entry) continue;
    info.codec = entry.type;
    info.width = moovView.getUint16(entry.bodyStart + 24);
    info.height = moovView.getUint16(entry.bodyStart + 26);
    const hdr: string[] = [];
    for (const b of boxes(moovView, entry.bodyStart + 78, entry.end)) {
      if (b.type === 'dvcC' || b.type === 'dvvC') hdr.push('Dolby Vision');
      if (b.type === 'colr' && fourcc(moovView, b.bodyStart) === 'nclx') {
        const t = TRANSFER[moovView.getUint16(b.bodyStart + 6)];
        if (t) hdr.push(t);
      }
    }
    info.hdr = hdr.length ? hdr.join(' + ') : 'SDR';
    break;
  }
  if (info.durationSec) info.bitrateMbps = (file.size * 8) / info.durationSec / 1e6;
  return info;
}

function jpegInfo(view: DataView, info: LocalMediaInfo): void {
  let pos = 2;
  while (pos + 4 <= view.byteLength) {
    if (view.getUint8(pos) !== 0xff) return;
    const marker = view.getUint8(pos + 1);
    const len = view.getUint16(pos + 2);
    if (marker === 0xe1 && pos + 10 <= view.byteLength && fourcc(view, pos + 4) === 'Exif') {
      info.hasExif = true;
      const t = parseExifTime(view, pos + 10);
      if (t) {
        info.captureTime = t;
        info.captureSource = 'EXIF';
      }
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      info.height = view.getUint16(pos + 5);
      info.width = view.getUint16(pos + 7);
      return;
    }
    pos += 2 + len;
  }
}

function readSized(view: DataView, pos: number, size: number): number {
  if (size === 4) return view.getUint32(pos);
  if (size === 8) return Number(view.getBigUint64(pos));
  return 0;
}

type Extent = { offset: number; length: number };

function ilocExtent(view: DataView, iloc: Box, itemId: number): Extent | undefined {
  const v = view.getUint8(iloc.bodyStart);
  let p = iloc.bodyStart + 4;
  const offsetSize = view.getUint8(p) >> 4;
  const lengthSize = view.getUint8(p) & 15;
  const baseSize = view.getUint8(p + 1) >> 4;
  const indexSize = v >= 1 ? view.getUint8(p + 1) & 15 : 0;
  p += 2;
  const count = v < 2 ? view.getUint16(p) : view.getUint32(p);
  p += v < 2 ? 2 : 4;
  for (let i = 0; i < count && p < iloc.end; i++) {
    const id = v < 2 ? view.getUint16(p) : view.getUint32(p);
    p += v < 2 ? 2 : 4;
    const method = v >= 1 ? view.getUint16(p) & 15 : 0;
    if (v >= 1) p += 2;
    p += 2;
    const base = readSized(view, p, baseSize);
    p += baseSize;
    const extents = view.getUint16(p);
    p += 2;
    let first: Extent | undefined;
    for (let e = 0; e < extents; e++) {
      p += indexSize;
      const offset = readSized(view, p, offsetSize);
      p += offsetSize;
      const length = readSized(view, p, lengthSize);
      p += lengthSize;
      first ??= { offset: base + offset, length };
    }
    if (id === itemId) return method === 0 ? first : undefined;
  }
  return undefined;
}

function heifInfo(view: DataView, info: LocalMediaInfo): Extent | undefined {
  const root: Box = { type: 'root', start: 0, end: view.byteLength, bodyStart: 0 };
  const meta = child(view, root, 'meta');
  if (!meta) return;
  const iinf = child(view, meta, 'iinf', 4);
  let exifId = 0;
  if (iinf) {
    for (let p = iinf.bodyStart; p + 4 < iinf.end; p++) {
      if (fourcc(view, p) === 'infe') {
        const v = view.getUint8(p + 4);
        if (v >= 2) {
          const typePos = p + 4 + 4 + (v === 2 ? 2 : 4) + 2;
          if (typePos + 4 <= iinf.end && fourcc(view, typePos) === 'Exif') {
            info.hasExif = true;
            exifId = v === 2 ? view.getUint16(p + 8) : view.getUint32(p + 8);
          }
        }
      }
    }
    info.hasExif ??= false;
  }
  const iloc = child(view, meta, 'iloc', 4);
  const exif = exifId && iloc ? ilocExtent(view, iloc, exifId) : undefined;
  const iprp = child(view, meta, 'iprp', 4);
  const ipco = iprp && child(view, iprp, 'ipco');
  if (!ipco) return exif;
  for (const b of boxes(view, ipco.bodyStart, ipco.end)) {
    if (b.type !== 'ispe') continue;
    const w = view.getUint32(b.bodyStart + 4);
    const h = view.getUint32(b.bodyStart + 8);
    if (w * h > (info.width ?? 0) * (info.height ?? 0)) {
      info.width = w;
      info.height = h;
    }
  }
  return exif;
}

async function imageInfo(file: File): Promise<LocalMediaInfo> {
  const info: LocalMediaInfo = { kind: 'image' };
  const view = new DataView(await file.slice(0, 1024 * 1024).arrayBuffer());
  if (view.byteLength >= 3 && view.getUint16(0) === 0xffd8) {
    info.container = 'JPEG';
    info.hasExif = false;
    jpegInfo(view, info);
  } else if (view.byteLength >= 12 && fourcc(view, 4) === 'ftyp') {
    info.container = `HEIF (${fourcc(view, 8).trim()})`;
    const exif = heifInfo(view, info);
    if (exif && exif.length > 8 && exif.length < 1024 * 1024) {
      const data = new DataView(await file.slice(exif.offset, exif.offset + exif.length).arrayBuffer());
      const t = data.byteLength > 8 ? parseExifTime(data, 4 + data.getUint32(0)) : undefined;
      if (t) {
        info.captureTime = t;
        info.captureSource = 'EXIF';
      }
    }
  } else if (view.byteLength >= 24 && view.getUint32(0) === 0x89504e47) {
    info.container = 'PNG';
    info.width = view.getUint32(16);
    info.height = view.getUint32(20);
  } else {
    info.note = '未知的影像格式';
  }
  return info;
}

export async function readLocalMediaInfo(file: File): Promise<LocalMediaInfo> {
  const info = await parseMedia(file);
  if (!info.captureTime && file.lastModified) {
    info.captureTime = file.lastModified;
    info.captureSource = '檔案修改時間（找不到拍攝時間）';
  }
  return info;
}

async function parseMedia(file: File): Promise<LocalMediaInfo> {
  try {
    if (file.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(file.name)) return await videoInfo(file);
    if (file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(file.name)) return await imageInfo(file);
    return { kind: 'other' };
  } catch (e) {
    return { kind: 'other', note: `解析失敗：${(e as Error).message}` };
  }
}
