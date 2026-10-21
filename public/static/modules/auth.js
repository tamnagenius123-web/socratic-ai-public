// SocraticAI v27 — Auth Module
// Extracted from app.js monolith for modular architecture
import { resetPrivateLearningState } from './state.js';

export function initAuth(State, helpers) {
  const { setDisplay, showToast, apiGet, tryRefreshToken, isTokenExpired } = helpers;

  function clearSavedAuth() {
    resetPrivateLearningState();
    State.accessToken = null;
    State.refreshToken = null;
    State.user = null;
    localStorage.removeItem('sat_access');
    localStorage.removeItem('sat_refresh');
    localStorage.removeItem('sat_user');
  }

  function applyCurrentIdentity(data) {
    if (!data?.user || typeof data.user !== 'object' || Array.isArray(data.user)) return false;
    State.user = data.user;
    localStorage.setItem('sat_user', JSON.stringify(data.user));
    helpers.syncNavigation?.(State.user);
    return true;
  }

  function showRegister() { setDisplay('login-form', 'none'); setDisplay('register-form', 'block'); }
  function showLogin() { setDisplay('register-form', 'none'); setDisplay('login-form', 'block'); }

  async function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) return showToast('이메일과 비밀번호를 입력하세요.', 'error');
    try {
      document.getElementById('login-btn').disabled = true;
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await res.json();
      if (!res.ok || data.error || !data.accessToken) throw new Error(data.error || '로그인에 실패했습니다.');
      loginSuccess(data);
    } catch (e) { showToast(e.message, 'error'); } finally { document.getElementById('login-btn').disabled = false; }
  }

  async function doRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const studentId = document.getElementById('reg-studentid').value.trim();
    const grade = document.getElementById('reg-grade').value;
    if (!username || !email || !password) return showToast('필수 항목을 입력하세요.', 'error');
    if (password.length < 6) return showToast('비밀번호는 최소 6자 이상입니다.', 'error');
    try {
      document.getElementById('reg-btn').disabled = true;
      const data = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, email, password, studentId: studentId || undefined, grade: grade ? parseInt(grade) : undefined }) }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      loginSuccess(data);
    } catch (e) { showToast(e.message, 'error'); } finally { document.getElementById('reg-btn').disabled = false; }
  }

  function loginSuccess(data) {
    resetPrivateLearningState();
    State.user = data.user;
    State.accessToken = data.accessToken;
    State.refreshToken = data.refreshToken;
    localStorage.setItem('sat_access', data.accessToken);
    localStorage.setItem('sat_refresh', data.refreshToken);
    localStorage.setItem('sat_user', JSON.stringify(data.user));
    showToast('환영합니다, ' + data.user.username + '님!', 'success');
    // Bootstrap validates the saved identity in a fresh document, so another account
    // cannot inherit module-local caches, pending requests or the previous tab's DOM.
    location.reload();
  }

  function doLogout() {
    resetPrivateLearningState();
    State.user = null; State.accessToken = null; State.refreshToken = null;
    localStorage.removeItem('sat_access'); localStorage.removeItem('sat_refresh'); localStorage.removeItem('sat_user');
    location.reload();
  }

  async function checkSavedAuth() {
    const epoch = State.authEpoch;
    const token = localStorage.getItem('sat_access');
    const refresh = localStorage.getItem('sat_refresh');
    if (!token) return;
    try {
      State.accessToken = token;
      State.refreshToken = refresh;
      let identityData;
      if (isTokenExpired(token)) {
        const refreshed = await tryRefreshToken();
        if (!refreshed) {
          if (epoch === State.authEpoch) clearSavedAuth();
          return;
        }
        identityData = { user: State.user };
      } else {
        identityData = await apiGet('/api/auth/me');
      }
      if (epoch !== State.authEpoch) return;
      if (!applyCurrentIdentity(identityData)) throw new Error('Current identity response is malformed.');
      if (typeof window._enterApp === 'function') window._enterApp();
    } catch {
      if (epoch === State.authEpoch) clearSavedAuth();
    }
  }

  // Expose to window for onclick handlers
  window.doLogin = doLogin;
  window.doRegister = doRegister;
  window.doLogout = doLogout;
  window.showRegister = showRegister;
  window.showLogin = showLogin;

  return {
    doLogin, doRegister, loginSuccess, doLogout,
    checkSavedAuth, showRegister, showLogin
  };
}
