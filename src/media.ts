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
    if (marker === 0xe1 && pos + 10 <= view.byteLength && fourcc(view, pos + 4) === 'Exif') info.hasExif = true;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      info.height = view.getUint16(pos + 5);
      info.width = view.getUint16(pos + 7);
      return;
    }
    pos += 2 + len;
  }
}

function heifInfo(view: DataView, info: LocalMediaInfo): void {
  const root: Box = { type: 'root', start: 0, end: view.byteLength, bodyStart: 0 };
  const meta = child(view, root, 'meta');
  if (!meta) return;
  const iinf = child(view, meta, 'iinf', 4);
  if (iinf) {
    for (let p = iinf.bodyStart; p + 4 < iinf.end; p++) {
      if (fourcc(view, p) === 'infe') {
        const v = view.getUint8(p + 4);
        if (v >= 2) {
          const typePos = p + 4 + 4 + (v === 2 ? 2 : 4) + 2;
          if (typePos + 4 <= iinf.end && fourcc(view, typePos) === 'Exif') info.hasExif = true;
        }
      }
    }
    info.hasExif ??= false;
  }
  const iprp = child(view, meta, 'iprp', 4);
  const ipco = iprp && child(view, iprp, 'ipco');
  if (!ipco) return;
  for (const b of boxes(view, ipco.bodyStart, ipco.end)) {
    if (b.type !== 'ispe') continue;
    const w = view.getUint32(b.bodyStart + 4);
    const h = view.getUint32(b.bodyStart + 8);
    if (w * h > (info.width ?? 0) * (info.height ?? 0)) {
      info.width = w;
      info.height = h;
    }
  }
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
    heifInfo(view, info);
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
  try {
    if (file.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(file.name)) return await videoInfo(file);
    if (file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(file.name)) return await imageInfo(file);
    return { kind: 'other' };
  } catch (e) {
    return { kind: 'other', note: `解析失敗：${(e as Error).message}` };
  }
}
