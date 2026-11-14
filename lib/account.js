import { driveRequest } from './running-drive.js';

export function sourceOverride(search) {
  const value = new URLSearchParams(search).get('source');
  return ['local', 'drive'].includes(value) ? value : null;
}

/** Only the explicit diagnostic URL reads the old local running file.
 * An unverified/offline session is not silently replaced with another dataset. */
export function runningSource(override, account) {
  if (override === 'local') return 'local';
  if (account.authenticated === true) return 'drive';
  if (account.phase === 'checking') return 'checking';
  if (account.phase === 'error') return 'unavailable';
  return 'guest';
}

export async function readAccount(previous, request = () => driveRequest('/api/google-auth', undefined,
  (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }))) {
  try {
    const value = await request();
    if (typeof value.configured !== 'boolean' || typeof value.authenticated !== 'boolean') throw Error('ACCOUNT_RESPONSE');
    return { phase: 'ready', configured: value.configured, authenticated: value.authenticated, error: '' };
  } catch (error) {
    if (error.code === 'NOT_CONFIGURED') return { phase: 'ready', configured: false, authenticated: false, error: '' };
    return { ...previous, phase: 'error', error: '接続を確認できませんでした。通信が戻ったら、もう一度お試しください。' };
  }
}

export function loginErrorMessage(code) {
  if (!code) return '';
  if (['OWNER_ONLY', 'DRIVE_ACCESS'].includes(code)) return '記録を保存したGoogleアカウントでログインしてください。表示用フォルダの所有者だけが利用できます。';
  if (code === 'SIGN_IN_CANCELLED') return 'Googleログインが完了していません。必要なときにもう一度ログインできます。';
  return 'Googleへの接続を完了できませんでした。もう一度ログインしてください。';
}
