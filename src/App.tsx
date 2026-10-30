import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CLIENT_ID, consumeRedirect, getToken, logout, startLogin, tokenExpiresAt } from './auth';
import { createFolder, type DriveFolder, getFolder, listFolders } from './drive';
import { playChime, unlockAudio } from './sound';
import { type QueueItem, UploadQueue } from './uploader';

const FOLDER_KEY = 'folder';
const ACCEPT_KEY = 'acceptMode';
const ACCEPT_MODES: Record<string, { label: string; accept: string | undefined }> = {
  none: { label: '不限制類型', accept: undefined },
  media: { label: 'image/*,video/*', accept: 'image/*,video/*' },
};

const queue = new UploadQueue();

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  pending: '待上傳',
  checking: '檢查中',
  uploading: '上傳中',
  retrying: '等待重試',
  verifying: '驗證中',
  done: '已完成',
  exists: '已存在',
  paused: '已暫停',
  failed: '失敗',
};

function verdict(item: QueueItem): 'match' | 'mismatch' | 'unknown' | null {
  if ((item.status !== 'done' && item.status !== 'exists') || !item.drive) return null;
  const sizeOk = item.drive.size === String(item.file.size);
  if (!sizeOk) return 'mismatch';
  if (!item.drive.sha256Checksum || !item.localSha256) return 'unknown';
  return item.drive.sha256Checksum === item.localSha256 ? 'match' : 'mismatch';
}

export default function App() {
  const [authError, setAuthError] = useState<string | null>(() => consumeRedirect());
  const [token, setToken] = useState(() => getToken());
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [folder, setFolder] = useState<DriveFolder | null>(() => {
    const raw = localStorage.getItem(FOLDER_KEY);
    return raw ? (JSON.parse(raw) as DriveFolder) : null;
  });
  const [newFolderName, setNewFolderName] = useState('iPhone 備份');
  const [acceptMode, setAcceptMode] = useState(() => localStorage.getItem(ACCEPT_KEY) ?? 'none');
  const [message, setMessage] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queue.onFinished = () => {
      const all = queue.items;
      const done = all.filter((i) => i.status === 'done' || i.status === 'exists').length;
      const failed = all.filter((i) => i.status === 'failed').length;
      const mismatch = all.filter((i) => verdict(i) === 'mismatch').length;
      setFinished(
        `成功 ${done} 個${failed ? `，失敗 ${failed} 個` : ''}${mismatch ? `，比對不一致 ${mismatch} 個` : '，全部比對一致'}`,
      );
      playChime();
    };
    return () => {
      queue.onFinished = null;
    };
  }, []);

  const items = useSyncExternalStore(
    (fn) => queue.subscribe(fn),
    () => queue.items,
  );

  useEffect(() => {
    const expiresAt = tokenExpiresAt();
    if (!expiresAt) return;
    const t = setTimeout(() => setToken(getToken()), Math.max(0, expiresAt - Date.now()) + 500);
    return () => clearTimeout(t);
  }, [token]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setToken(getToken());
        queue.handleVisible();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (queue.running) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (!token) return;
    listFolders()
      .then(setFolders)
      .catch((e: Error) => setMessage(e.message));
    if (folder) {
      getFolder(folder.id).then((f) => {
        if (!f) {
          setFolder(null);
          localStorage.removeItem(FOLDER_KEY);
          setMessage('上次的目的資料夾已不存在或已移至垃圾桶，請重新選擇');
        }
      }).catch(() => {});
    }
  }, [token]);

  const chooseFolder = (f: DriveFolder | null) => {
    setFolder(f);
    if (f) localStorage.setItem(FOLDER_KEY, JSON.stringify(f));
    else localStorage.removeItem(FOLDER_KEY);
  };

  const onCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const f = await createFolder(name);
      setFolders((list) => [...list, f].sort((a, b) => a.name.localeCompare(b.name)));
      chooseFolder(f);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const stats = useMemo(() => {
    const total = items.reduce((s, i) => s + i.file.size, 0);
    const uploaded = items.reduce((s, i) => s + Math.min(i.uploaded, i.file.size), 0);
    const count = (st: QueueItem['status'][]) => items.filter((i) => st.includes(i.status)).length;
    const verdicts = items.map(verdict);
    return {
      total,
      uploaded,
      done: count(['done', 'exists']),
      failed: count(['failed']),
      waiting: count(['pending', 'paused', 'checking', 'uploading', 'retrying', 'verifying']),
      match: verdicts.filter((v) => v === 'match').length,
      mismatch: verdicts.filter((v) => v === 'mismatch').length,
      unknown: verdicts.filter((v) => v === 'unknown').length,
    };
  }, [items]);

  const busy = queue.running;
  const hasPending = items.some((i) => i.status === 'pending' || i.status === 'paused');
  const beforeLogin = () => {
    if (items.length > 0 && !confirm('登入會重新載入頁面，已選取的檔案需要重新選取。確定要繼續？')) return;
    startLogin();
  };

  return (
    <main>
      <div className="version">{__APP_VERSION__}</div>
      <h1>照片備份到 Google Drive</h1>

      {!CLIENT_ID && <p className="error">尚未設定 VITE_GOOGLE_CLIENT_ID</p>}
      {authError && <p className="error" onClick={() => setAuthError(null)}>{authError}</p>}
      {message && <p className="error" onClick={() => setMessage(null)}>{message}</p>}

      <section>
        <h2>Google 帳號</h2>
        {token ? (
          <div className="row">
            <span className="ok">已登入</span>
            <button className="secondary" disabled={busy} onClick={() => { logout(); setToken(null); }}>登出</button>
          </div>
        ) : (
          <div className="row">
            <span>{queue.authRequired ? '授權已過期，請重新登入後繼續' : '未登入'}</span>
            <button disabled={!CLIENT_ID} onClick={beforeLogin}>登入 Google</button>
          </div>
        )}
      </section>

      <section>
        <h2>目的資料夾</h2>
        <select
          value={folder?.id ?? ''}
          disabled={!token || busy}
          onChange={(e) => chooseFolder(folders.find((f) => f.id === e.target.value) ?? null)}
        >
          <option value="">請選擇</option>
          {folder && !folders.some((f) => f.id === folder.id) && <option value={folder.id}>{folder.name}</option>}
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <div className="row">
          <input value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} disabled={!token || busy} />
          <button className="secondary" disabled={!token || busy} onClick={onCreateFolder}>建立資料夾</button>
        </div>
        <p className="hint">僅列出本 App 建立的資料夾（drive.file 權限）。</p>
      </section>

      <section>
        <h2>選取照片及影片</h2>
        <div className="row">
          <label>
            選取模式
            <select
              value={acceptMode}
              onChange={(e) => {
                setAcceptMode(e.target.value);
                localStorage.setItem(ACCEPT_KEY, e.target.value);
              }}
            >
              {Object.entries(ACCEPT_MODES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <button disabled={!token} onClick={() => inputRef.current?.click()}>選取檔案</button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_MODES[acceptMode]?.accept}
          hidden
          onChange={(e) => {
            queue.add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <p>已選取 {items.length} 個檔案，共 {formatBytes(stats.total)}</p>
      </section>

      <section>
        <h2>上傳</h2>
        <progress max={stats.total || 1} value={stats.uploaded} />
        <p>
          {formatBytes(stats.uploaded)} / {formatBytes(stats.total)}
          完成 {stats.done}・失敗 {stats.failed}・待上傳 {stats.waiting}
        </p>
        <p>
          比對：<span className="ok">一致 {stats.match}</span>・
          <span className="bad">不一致 {stats.mismatch}</span>・無法比對 {stats.unknown}
        </p>
        <div className="row wrap">
          {busy ? (
            <button onClick={() => queue.pause()}>暫停</button>
          ) : (
            <button
              disabled={!token || !folder || !hasPending}
              onClick={() => {
                if (!folder) return;
                unlockAudio();
                setFinished(null);
                queue.start(folder.id);
              }}
            >
              {items.some((i) => i.status === 'paused') ? '繼續上傳' : '開始上傳'}
            </button>
          )}
          <button className="secondary" disabled={stats.failed === 0} onClick={() => queue.retryAllFailed()}>重試失敗項目</button>
          <button className="secondary" disabled={stats.done === 0} onClick={() => queue.clearFinished()}>清除已完成</button>
        </div>
        <p className="hint">上傳期間請保持畫面開啟，切換 App 或鎖定螢幕會中斷，回來後會自動續傳。</p>
      </section>

      {finished && (
        <div className="overlay" onClick={() => setFinished(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>上傳完畢</h2>
            <p>{finished}</p>
            <button onClick={() => setFinished(null)}>確定</button>
          </div>
        </div>
      )}

      <ul className="items">
        {items.map((item) => <ItemCard key={item.id} item={item} />)}
      </ul>
    </main>
  );
}

function ItemCard({ item }: { item: QueueItem }) {
  const v = verdict(item);
  const pct = item.file.size ? Math.floor((Math.min(item.uploaded, item.file.size) / item.file.size) * 100) : 0;
  const l = item.local;
  const d = item.drive;
  const img = d?.imageMediaMetadata;
  const vid = d?.videoMediaMetadata;

  return (
    <li className={`item ${item.status}`}>
      <div className="row between">
        <strong className="name">{item.file.name}</strong>
        <span className={`badge ${item.status}`}>{STATUS_LABEL[item.status]}</span>
      </div>
      <progress max={100} value={pct} />
      <div className="meta">
        {item.file.type || '（無 MIME）'}・{formatBytes(item.file.size)}（{item.file.size.toLocaleString()} bytes）・{pct}%
      </div>
      <div className="meta">lastModified：{new Date(item.file.lastModified).toLocaleString()}</div>
      {l && (
        <div className="meta info">
          檔案格式：{l.container ?? ''} {l.codec ?? ''} {l.width ? `${l.width}×${l.height}` : ''}
          {l.durationSec ? `・${l.durationSec.toFixed(1)} 秒` : ''}
          {l.bitrateMbps ? `・${l.bitrateMbps.toFixed(1)} Mbps` : ''}
          {l.hdr ? `・${l.hdr}` : ''}
          {l.hasExif !== undefined ? `・EXIF ${l.hasExif ? '有' : '無'}` : ''}
          {l.note ? `・${l.note}` : ''}
        </div>
      )}
      {item.error && <div className="error small">{item.error}</div>}
      {item.status === 'failed' && <button className="secondary small" onClick={() => queue.retry(item.id)}>重試</button>}
      {item.status === 'pending' && <button className="secondary small" onClick={() => queue.remove(item.id)}>移除</button>}
      {d && v && (
        <table className="compare">
          <tbody>
            <tr>
              <th>比對結果</th>
              <td className={v === 'match' ? 'ok' : v === 'mismatch' ? 'bad' : ''}>
                {v === 'match' ? '一致' : v === 'mismatch' ? '不一致' : 'Drive 未提供 SHA-256，僅比對大小'}
              </td>
            </tr>
            <tr><th>大小</th><td>本地 {item.file.size.toLocaleString()} / Drive {Number(d.size ?? 0).toLocaleString()}</td></tr>
            <tr><th>SHA-256 本地</th><td className="mono">{item.localSha256}</td></tr>
            <tr><th>SHA-256 Drive</th><td className="mono">{d.sha256Checksum ?? '—'}</td></tr>
            <tr><th>Drive 檔名</th><td>{d.name}</td></tr>
            <tr><th>Drive MIME</th><td>{d.mimeType}</td></tr>
            <tr><th>File ID</th><td className="mono">{d.id}</td></tr>
            {img && (
              <tr>
                <th>Drive 影像資訊</th>
                <td>
                  {img.width}×{img.height}・拍攝 {img.time ?? '—'}・{[img.cameraMake, img.cameraModel].filter(Boolean).join(' ') || '無相機資訊'}
                  ・GPS {img.location ? '有' : '無'}
                </td>
              </tr>
            )}
            {vid && (
              <tr>
                <th>Drive 影片資訊</th>
                <td>{vid.width}×{vid.height}・{vid.durationMillis ? (Number(vid.durationMillis) / 1000).toFixed(1) : '—'} 秒</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </li>
  );
}
