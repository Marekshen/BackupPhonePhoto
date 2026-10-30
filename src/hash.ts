import { createSHA256 } from 'hash-wasm';

const EDGE = 1024 * 1024;
const READ_CHUNK = 8 * 1024 * 1024;

export async function fingerprint(file: File): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  hasher.update(String(file.size));
  hasher.update(new Uint8Array(await file.slice(0, EDGE).arrayBuffer()));
  if (file.size > EDGE) {
    hasher.update(new Uint8Array(await file.slice(Math.max(EDGE, file.size - EDGE)).arrayBuffer()));
  }
  return hasher.digest('hex').slice(0, 40);
}

export async function sha256File(file: Blob, onProgress?: (done: number) => void): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += READ_CHUNK) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + READ_CHUNK).arrayBuffer()));
    onProgress?.(Math.min(offset + READ_CHUNK, file.size));
  }
  return hasher.digest('hex');
}

export class IncrementalSha256 {
  private hashedUpTo = 0;
  private constructor(private hasher: Awaited<ReturnType<typeof createSHA256>>) {}

  static async create(): Promise<IncrementalSha256> {
    const hasher = await createSHA256();
    hasher.init();
    return new IncrementalSha256(hasher);
  }

  feed(data: Uint8Array, offset: number): void {
    const end = offset + data.byteLength;
    if (end <= this.hashedUpTo) return;
    if (offset > this.hashedUpTo) throw new Error('雜湊資料不連續');
    this.hasher.update(data.subarray(this.hashedUpTo - offset));
    this.hashedUpTo = end;
  }

  get position(): number {
    return this.hashedUpTo;
  }

  digest(): string {
    return this.hasher.digest('hex');
  }
}
