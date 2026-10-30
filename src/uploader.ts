import {
  AuthRequiredError,
  createUploadSession,
  type DriveFile,
  findByFingerprint,
  getFile,
  HttpError,
  queryUploadStatus,
  uploadChunk,
} from './drive';
import { fingerprint, IncrementalSha256, sha256File } from './hash';
import { type LocalMediaInfo, readLocalMediaInfo } from './media';

const CHUNK_SIZE = 8 * 1024 * 1024;
const CONCURRENCY = 2;
const MAX_RETRIES = 8;

export type ItemStatus =
  | 'pending'
  | 'checking'
  | 'uploading'
  | 'retrying'
  | 'verifying'
  | 'done'
  | 'exists'
  | 'paused'
  | 'failed';

export interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  uploaded: number;
  local?: LocalMediaInfo;
  fp?: string;
  localSha256?: string;
  drive?: DriveFile;
  error?: string;
  attempts: number;
  sessionUri?: string;
  hasher?: IncrementalSha256;
  offset: number;
}

type Listener = () => void;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('已中止', 'AbortError'));
    }, { once: true });
  });

function isRetryable(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (e.message.includes('storageQuotaExceeded')) return false;
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500 || e.status === 403;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export class UploadQueue {
  items: QueueItem[] = [];
  running = false;
  authRequired = false;
  folderId: string | null = null;
  onFinished: (() => void) | null = null;
  transferredBytes = 0;
  private activeMs = 0;
  private runStartedAt: number | null = null;
  private runFinished = true;
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<Listener>();
  private wakeLock: WakeLockSentinel | null = null;
  private lastProgressEmit = 0;
  private mediaInfoChain: Promise<void> = Promise.resolve();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.items = [...this.items];
    for (const fn of this.listeners) fn();
  }

  private update(item: QueueItem, patch: Partial<QueueItem>): void {
    Object.assign(item, patch);
    this.emit();
  }

  private progress(item: QueueItem, uploaded: number): void {
    if (uploaded > item.uploaded) this.transferredBytes += uploaded - item.uploaded;
    item.uploaded = uploaded;
    const now = performance.now();
    if (now - this.lastProgressEmit < 300) return;
    this.lastProgressEmit = now;
    this.emit();
  }

  elapsedMs(): number {
    return this.activeMs + (this.runStartedAt === null ? 0 : Date.now() - this.runStartedAt);
  }

  private stopClock(): void {
    if (this.runStartedAt !== null) this.activeMs += Date.now() - this.runStartedAt;
    this.runStartedAt = null;
  }

  add(files: File[]): void {
    const known = new Set(this.items.map((i) => `${i.file.name}|${i.file.size}`));
    for (const file of files) {
      const key = `${file.name}|${file.size}`;
      if (known.has(key)) continue;
      known.add(key);
      const item: QueueItem = { id: crypto.randomUUID(), file, status: 'pending', uploaded: 0, attempts: 0, offset: 0 };
      this.items.push(item);
      this.mediaInfoChain = this.mediaInfoChain
        .then(() => readLocalMediaInfo(file))
        .then((local) => this.update(item, { local }));
    }
    this.emit();
  }

  remove(id: string): void {
    if (this.controllers.has(id)) return;
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }

  clearFinished(): void {
    this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'exists');
    this.emit();
  }

  start(folderId: string): void {
    this.folderId = folderId;
    if (this.runFinished) {
      this.transferredBytes = 0;
      this.activeMs = 0;
      this.runFinished = false;
    }
    this.runStartedAt = Date.now();
    this.running = true;
    this.authRequired = false;
    for (const i of this.items) if (i.status === 'paused') i.status = 'pending';
    this.emit();
    this.acquireWakeLock();
    this.pump();
  }

  pause(): void {
    this.running = false;
    this.stopClock();
    for (const c of this.controllers.values()) c.abort();
    this.emit();
    this.releaseWakeLock();
  }

  retry(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'failed') return;
    this.update(item, { status: 'pending', error: undefined, attempts: 0 });
    if (this.running) this.pump();
  }

  retryAllFailed(): void {
    for (const i of this.items) if (i.status === 'failed') Object.assign(i, { status: 'pending', error: undefined, attempts: 0 });
    this.emit();
    if (this.running) this.pump();
  }

  private pump(): void {
    if (!this.running || !this.folderId) return;
    while (this.controllers.size < CONCURRENCY) {
      const next = this.items.find((i) => i.status === 'pending');
      if (!next) break;
      const controller = new AbortController();
      this.controllers.set(next.id, controller);
      this.process(next, this.folderId, controller.signal).finally(() => {
        this.controllers.delete(next.id);
        if (this.running && this.controllers.size === 0 && !this.items.some((i) => i.status === 'pending')) {
          this.running = false;
          this.stopClock();
          this.runFinished = true;
          this.releaseWakeLock();
          this.emit();
          this.onFinished?.();
        }
        this.pump();
      });
    }
  }

  private async process(item: QueueItem, folderId: string, signal: AbortSignal): Promise<void> {
    try {
      this.update(item, { status: 'checking', error: undefined });
      item.fp ??= await fingerprint(item.file);
      if (!item.sessionUri) {
        const existing = await findByFingerprint(folderId, item.fp);
        if (existing) {
          this.update(item, { status: 'verifying', drive: existing, uploaded: item.file.size });
          const localSha256 = await sha256File(item.file);
          this.update(item, { status: 'exists', localSha256 });
          return;
        }
      }
      const driveFile = await this.uploadWithRetry(item, folderId, signal);
      this.update(item, { status: 'verifying', uploaded: item.file.size });
      const localSha256 = item.hasher!.digest();
      let drive = driveFile;
      if (!drive.sha256Checksum) {
        try {
          drive = await getFile(driveFile.id);
        } catch {
          // 取不到完整 metadata 時沿用上傳回應
        }
      }
      this.update(item, { status: 'done', drive, localSha256, sessionUri: undefined, hasher: undefined });
    } catch (e) {
      if (isAbort(e)) {
        this.update(item, { status: 'paused' });
      } else if (e instanceof AuthRequiredError) {
        this.authRequired = true;
        this.update(item, { status: 'paused', error: e.message });
        this.pause();
      } else {
        this.update(item, { status: 'failed', error: (e as Error).message });
      }
    }
  }

  private async uploadWithRetry(item: QueueItem, folderId: string, signal: AbortSignal): Promise<DriveFile> {
    for (;;) {
      try {
        if (item.sessionUri) {
          const status = await queryUploadStatus(item.sessionUri, item.file.size, signal);
          if (status.kind === 'complete') return status.file;
          item.offset = status.nextOffset;
        }
        return await this.uploadFrom(item, folderId, signal);
      } catch (e) {
        if (isAbort(e) || e instanceof AuthRequiredError) throw e;
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) {
          const existing = item.fp ? await findByFingerprint(folderId, item.fp) : null;
          if (existing) return existing;
          Object.assign(item, { sessionUri: undefined, hasher: undefined, offset: 0, uploaded: 0 });
        } else if (!isRetryable(e) || item.attempts >= MAX_RETRIES) {
          throw e;
        }
        item.attempts += 1;
        const delay = Math.min(64000, 1000 * 2 ** (item.attempts - 1)) + Math.random() * 1000;
        this.update(item, { status: 'retrying', error: `${(e as Error).message}，${Math.round(delay / 1000)} 秒後重試（第 ${item.attempts} 次）` });
        await sleep(delay, signal);
      }
    }
  }

  private async uploadFrom(item: QueueItem, folderId: string, signal: AbortSignal): Promise<DriveFile> {
    if (!item.sessionUri) {
      item.sessionUri = await createUploadSession(item.file, folderId, item.fp!);
      item.hasher = await IncrementalSha256.create();
      item.offset = 0;
    }
    const total = item.file.size;
    for (;;) {
      const end = Math.min(item.offset + CHUNK_SIZE, total);
      const data = new Uint8Array(await item.file.slice(item.offset, end).arrayBuffer());
      item.hasher!.feed(data, item.offset);
      this.update(item, { status: 'uploading', uploaded: item.offset, error: undefined });
      const base = item.offset;
      const result = await uploadChunk(item.sessionUri, data, item.offset, total, (loaded) => {
        this.progress(item, base + loaded);
      }, signal);
      item.attempts = 0;
      if (result.kind === 'complete') return result.file;
      item.offset = result.nextOffset;
    }
  }

  handleVisible(): void {
    if (this.running && !this.wakeLock) this.acquireWakeLock();
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }

  private releaseWakeLock(): void {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}
