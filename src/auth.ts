const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'gd_token';
const STATE_KEY = 'gd_oauth_state';

export const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

function redirectUri(): string {
  return window.location.origin + import.meta.env.BASE_URL;
}

export function startLogin(): void {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

export function consumeRedirect(): string | null {
  if (!window.location.hash.includes('access_token') && !window.location.hash.includes('error')) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  history.replaceState(null, '', window.location.pathname + window.location.search);
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (params.get('error')) return `登入失敗：${params.get('error')}`;
  if (!expected || params.get('state') !== expected) return '登入失敗：state 不符';
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in') ?? '3600');
  if (!accessToken) return '登入失敗：未取得 token';
  const token: StoredToken = { accessToken, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return null;
}

export function getToken(): string | null {
  const raw = sessionStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  const token = JSON.parse(raw) as StoredToken;
  if (Date.now() >= token.expiresAt) {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return token.accessToken;
}

export function tokenExpiresAt(): number | null {
  const raw = sessionStorage.getItem(TOKEN_KEY);
  return raw ? (JSON.parse(raw) as StoredToken).expiresAt : null;
}

export function logout(): void {
  const token = getToken();
  sessionStorage.removeItem(TOKEN_KEY);
  if (token) {
    fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }
}
