import { getToken } from './auth';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const DRIVE_FILE_FIELDS =
  'id,name,mimeType,size,sha256Checksum,md5Checksum,createdTime,modifiedTime,' +
  'imageMediaMetadata(width,height,time,cameraMake,cameraModel,location),' +
  'videoMediaMetadata(width,height,durationMillis)';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  sha256Checksum?: string;
  md5Checksum?: string;
  createdTime?: string;
  modifiedTime?: string;
  imageMediaMetadata?: {
    width?: number;
    height?: number;
    time?: string;
    cameraMake?: string;
    cameraModel?: string;
    location?: { latitude?: number; longitude?: number };
  };
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
}

export interface DriveFolder {
  id: string;
  name: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class AuthRequiredError extends Error {
  constructor() {
    super('需要重新登入 Google');
  }
}

function authHeader(): Record<string, string> {
  const token = getToken();
  if (!token) throw new AuthRequiredError();
  return { Authorization: `Bearer ${token}` };
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...authHeader(), ...(init.headers ?? {}) } });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) throw new HttpError(res.status, `Drive API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function listFolders(): Promise<DriveFolder[]> {
  const q = `mimeType='${FOLDER_MIME}' and trashed=false`;
  const params = new URLSearchParams({ q, fields: 'files(id,name)', orderBy: 'name', pageSize: '200' });
  const data = await api<{ files: DriveFolder[] }>(`${API}/files?${params}`);
  return data.files;
}

export async function createFolder(name: string): Promise<DriveFolder> {
  return api<DriveFolder>(`${API}/files?fields=id,name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  });
}

export async function getFolder(id: string): Promise<DriveFolder | null> {
  try {
    const f = await api<DriveFolder & { trashed: boolean }>(`${API}/files/${id}?fields=id,name,trashed`);
    return f.trashed ? null : f;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

export async function findByFingerprint(folderId: string, fp: string): Promise<DriveFile | null> {
  const q =
    `'${escapeQuery(folderId)}' in parents and trashed=false and ` +
    `appProperties has { key='fp' and value='${escapeQuery(fp)}' }`;
  const params = new URLSearchParams({ q, fields: `files(${DRIVE_FILE_FIELDS})`, pageSize: '10' });
  const data = await api<{ files: DriveFile[] }>(`${API}/files?${params}`);
  return data.files[0] ?? null;
}

export async function listFingerprints(folderId: string): Promise<Map<string, DriveFile>> {
  const map = new Map<string, DriveFile>();
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${escapeQuery(folderId)}' in parents and trashed=false`,
      fields: `nextPageToken,files(${DRIVE_FILE_FIELDS},appProperties)`,
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await api<{ files: (DriveFile & { appProperties?: Record<string, string> })[]; nextPageToken?: string }>(
      `${API}/files?${params}`,
    );
    for (const { appProperties, ...f } of data.files) {
      const fp = appProperties?.fp;
      if (fp && !map.has(fp)) map.set(fp, f);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return map;
}

export async function getFile(id: string): Promise<DriveFile> {
  return api<DriveFile>(`${API}/files/${id}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`);
}

function fileMetadata(file: File, folderId: string, fp: string) {
  return {
    name: file.name,
    parents: [folderId],
    mimeType: file.type || undefined,
    appProperties: { fp, size: String(file.size) },
  };
}

export async function uploadMultipart(
  file: File,
  data: Uint8Array,
  folderId: string,
  fp: string,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<DriveFile> {
  const boundary = `b${crypto.randomUUID().replace(/-/g, '')}`;
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(fileMetadata(file, folderId, fp))}\r\n` +
    `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`;
  const headBytes = new TextEncoder().encode(head);
  const body = new Blob([headBytes, data as BlobPart, `\r\n--${boundary}--`]);
  const params = new URLSearchParams({ uploadType: 'multipart', fields: DRIVE_FILE_FIELDS });
  const result = await sendXhr(
    'POST',
    `${UPLOAD_API}/files?${params}`,
    { ...authHeader(), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    (loaded) => onProgress(Math.max(0, loaded - headBytes.byteLength)),
    signal,
  );
  if (result.kind !== 'complete') throw new HttpError(0, '上傳回應異常');
  return result.file;
}

export async function createUploadSession(
  file: File,
  folderId: string,
  fp: string,
): Promise<string> {
  const params = new URLSearchParams({ uploadType: 'resumable', fields: DRIVE_FILE_FIELDS });
  const res = await fetch(`${UPLOAD_API}/files?${params}`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': file.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(file.size),
    },
    body: JSON.stringify(fileMetadata(file, folderId, fp)),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) throw new HttpError(res.status, `建立上傳工作失敗 ${res.status}: ${await res.text()}`);
  const location = res.headers.get('Location');
  if (!location) throw new Error('無法讀取上傳 session URI（Location header）');
  return location;
}

export type ChunkResult =
  | { kind: 'incomplete'; nextOffset: number }
  | { kind: 'complete'; file: DriveFile };

function parseRange(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

function sendXhr(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | Blob | null,
  onProgress: ((loaded: number) => void) | null,
  signal: AbortSignal,
): Promise<ChunkResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort);
      if (xhr.status === 200 || xhr.status === 201) {
        resolve({ kind: 'complete', file: JSON.parse(xhr.responseText) as DriveFile });
      } else if (xhr.status === 308) {
        resolve({ kind: 'incomplete', nextOffset: parseRange(xhr.getResponseHeader('Range')) });
      } else if (xhr.status === 401) {
        reject(new AuthRequiredError());
      } else {
        reject(new HttpError(xhr.status, `上傳失敗 ${xhr.status}: ${xhr.responseText.slice(0, 300)}`));
      }
    };
    xhr.onerror = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new HttpError(0, '網路錯誤'));
    };
    xhr.onabort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('已中止', 'AbortError'));
    };
    xhr.send(body as XMLHttpRequestBodyInit | null);
  });
}

export function queryUploadStatus(sessionUri: string, total: number, signal: AbortSignal): Promise<ChunkResult> {
  return sendXhr('PUT', sessionUri, { ...authHeader(), 'Content-Range': `bytes */${total}` }, null, null, signal);
}

export function uploadChunk(
  sessionUri: string,
  data: Uint8Array,
  offset: number,
  total: number,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<ChunkResult> {
  const end = offset + data.byteLength - 1;
  return sendXhr(
    'PUT',
    sessionUri,
    { ...authHeader(), 'Content-Range': `bytes ${offset}-${end}/${total}` },
    data,
    onProgress,
    signal,
  );
}
