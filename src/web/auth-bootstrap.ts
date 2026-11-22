/**
 * 前端门禁（独立页面与 Console 浮窗共用）。
 *
 * 两种形态，由服务端 `/session` 决定：
 * - `bootstrapRequired: true`：**首次初始化**——弹「创建管理密钥」，可留空由服务端生成，
 *   成功后把密钥**一次性**展示（可复制），同时已写入 `<wikiDir>/.patchouli/api-token.txt`；
 * - 其余：普通登录——粘贴已保存的密钥换会话。
 *
 * 之后每个 `/api` 请求自动带 `Authorization: Bearer <sid>`；401 清票据重弹。
 * 浏览器只存短票据，长期密钥永不落 localStorage。
 */

const SESSION_KEY = 'patchouli.session';
const EXPIRY_KEY = 'patchouli.expires';

export function authBootstrap(basePath: string): string {
  return `(() => {
  const base = ${JSON.stringify(basePath)};
  const SESSION_KEY = ${JSON.stringify(SESSION_KEY)};
  const EXPIRY_KEY = ${JSON.stringify(EXPIRY_KEY)};
  const OVERLAY_ID = 'ptx-auth-gate';
  const read = (key) => { try { return window.localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { window.localStorage.setItem(key, value); } catch {} };
  const clear = () => { try { window.localStorage.removeItem(SESSION_KEY); window.localStorage.removeItem(EXPIRY_KEY); } catch {} };

  const session = () => {
    const sid = read(SESSION_KEY);
    const exp = Number(read(EXPIRY_KEY) || '0');
    if (!sid) return null;
    if (!Number.isFinite(exp) || exp <= Date.now() + 30000) return null;
    return sid;
  };
  const saveSession = (payload) => {
    write(SESSION_KEY, payload.session);
    write(EXPIRY_KEY, String(payload.expiresAt || 0));
  };

  const rawFetch = window.fetch.bind(window);
  let overlayOpen = false;

  const shell = (inner) => {
    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(5,9,16,.9);backdrop-filter:blur(6px);font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;color:#e8edf7');
    const card = document.createElement('form');
    card.setAttribute('style', 'width:min(440px,88vw);padding:26px 24px;border-radius:16px;background:rgba(19,25,40,.97);border:1px solid rgba(255,255,255,.13);box-shadow:0 24px 70px rgba(0,0,0,.55)');
    card.innerHTML = inner;
    root.appendChild(card);
    return { root, card };
  };

  const mountOverlay = (root) => {
    if (overlayOpen) return false;
    overlayOpen = true;
    document.body.appendChild(root);
    return true;
  };

  const finish = () => {
    overlayOpen = false;
    const node = document.getElementById(OVERLAY_ID);
    if (node) node.remove();
  };

  /* 普通登录：粘贴已保存的密钥。 */
  const showLogin = (message) => {
    const { root, card } = shell(
      '<div style="font-size:15px;font-weight:600;letter-spacing:.02em">需要访问密钥</div>' +
      '<div style="margin-top:8px;font-size:12px;line-height:1.85;color:rgba(232,237,247,.62)">管理面已启用鉴权。填入首次初始化时保存的密钥；' +
      '服务器上的副本在 <code>&lt;知识库&gt;/.patchouli/api-token.txt</code>。</div>' +
      '<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="管理密钥" ' +
      'style="margin-top:14px;width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8edf7;font:13px/1.4 ui-monospace,monospace;outline:none">' +
      '<div data-err style="margin-top:8px;font-size:12px;color:#f08a7a;min-height:16px">' + (message || '') + '</div>' +
      '<button type="submit" style="margin-top:6px;width:100%;padding:10px;border-radius:10px;border:0;background:#3f9d78;color:#06120d;font-size:13px;font-weight:600;cursor:pointer">进入</button>'
    );
    if (!mountOverlay(root)) return;
    const input = card.querySelector('input');
    const err = card.querySelector('[data-err]');
    if (input) input.focus();
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = (input && input.value || '').trim();
      if (value === '') return;
      const response = await rawFetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token: value }),
      }).catch(() => null);
      if (response === null || !response.ok) {
        if (err) err.textContent = '密钥无效（服务器返回 ' + (response ? response.status : '网络错误') + '）';
        return;
      }
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.session) {
        if (err) err.textContent = '登录响应缺少会话票据';
        return;
      }
      saveSession(payload);
      finish();
      window.dispatchEvent(new CustomEvent('patchouli:auth'));
      window.location.reload();
    });
  };

  /* 首次初始化：留空自动生成，成功后一次性展示密钥。 */
  const showInit = () => {
    const { root, card } = shell(
      '<div style="font-size:15px;font-weight:600;letter-spacing:.02em">首次初始化</div>' +
      '<div style="margin-top:8px;font-size:12px;line-height:1.85;color:rgba(232,237,247,.62)">还没有管理密钥。可以留空由服务端生成，' +
      '也可以自己填一个（至少 16 个字符）。密钥会写入 <code>&lt;知识库&gt;/.patchoulI/api-token.txt</code>，之后每次打开面板用它登录。</div>'
        .replace('.patchoulI', '.patchouli') +
      '<input name="token" type="text" autocomplete="off" spellcheck="false" placeholder="留空 = 自动生成" ' +
      'style="margin-top:14px;width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8edf7;font:13px/1.4 ui-monospace,monospace;outline:none">' +
      '<div data-err style="margin-top:8px;font-size:12px;color:#f08a7a;min-height:16px"></div>' +
      '<button type="submit" style="margin-top:6px;width:100%;padding:10px;border-radius:10px;border:0;background:#3f9d78;color:#06120d;font-size:13px;font-weight:600;cursor:pointer">生成并进入</button>'
    );
    if (!mountOverlay(root)) return;
    const input = card.querySelector('input');
    const err = card.querySelector('[data-err]');
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = (input && input.value || '').trim();
      const response = await rawFetch(base + '/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(value === '' ? {} : { token: value }),
      }).catch(() => null);
      if (response === null) {
        if (err) err.textContent = '网络错误，请重试';
        return;
      }
      if (response.status === 409) {
        finish();
        showLogin('已完成初始化，请输入管理密钥。');
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (err) err.textContent = (payload && payload.message) || ('初始化失败（' + response.status + '）');
        return;
      }
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.token || !payload.session) {
        if (err) err.textContent = '初始化响应不完整';
        return;
      }
      saveSession(payload);
      card.innerHTML =
        '<div style="font-size:15px;font-weight:600">初始化完成</div>' +
        '<div style="margin-top:8px;font-size:12px;line-height:1.85;color:rgba(232,237,247,.62)">这是管理密钥，只显示这一次；已写入 <code>' +
        String(payload.tokenPath || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code>。请复制保存，之后打开面板用它登录。</div>' +
        '<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);font:12px/1.6 ui-monospace,monospace;word-break:break-all;user-select:all">' +
        String(payload.token).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>' +
        '<button type="button" data-enter style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:0;background:#3f9d78;color:#06120d;font-size:13px;font-weight:600;cursor:pointer">我已保存，进入</button>';
      const enter = card.querySelector('[data-enter]');
      if (enter) enter.addEventListener('click', () => {
        finish();
        window.dispatchEvent(new CustomEvent('patchouli:auth'));
        window.location.reload();
      });
    });
  };

  /* 每个 /api 请求自动带会话票据；401 视为过期/吊销，重新门禁。 */
  window.fetch = (input, init) => {
    const target = typeof input === 'string' ? input : (input && input.url) || '';
    const isApi = target.includes(base + '/api/');
    const sid = session();
    if (sid && isApi) {
      const headers = new Headers((init && init.headers) || (typeof input === 'string' ? undefined : input.headers));
      if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + sid);
      init = Object.assign({}, init, { headers });
    }
    const pending = rawFetch(input, init);
    if (!isApi) return pending;
    return pending.then((response) => {
      if (response.status === 401) {
        clear();
        gate('会话已过期，请重新输入。');
      }
      return response;
    });
  };

  /**
   * 门禁入口：无有效会话时按服务端状态选「首次初始化」或「登录」。
   * 独立页面在加载时调用，Console 组件在打开悬浮窗时调用；重复调用幂等。
   */
  const gate = (message) => {
    if (overlayOpen) return;
    if (!session()) {
      rawFetch(base + '/session', { credentials: 'same-origin' })
        .then((response) => response.json())
        .then((state) => {
          if (state && state.authenticated === true) return;
          if (state && state.bootstrapRequired === true) showInit();
          else showLogin(message || '');
        })
        .catch(() => showLogin(message || '网络错误'));
      return;
    }
    rawFetch(base + '/session', {
      headers: { Authorization: 'Bearer ' + session() },
      credentials: 'same-origin',
    })
      .then((response) => response.json())
      .then((state) => {
        if (state && state.authenticated === true) {
          if (state.expiresAt) write(EXPIRY_KEY, String(state.expiresAt));
          return;
        }
        clear();
        if (state && state.bootstrapRequired === true) showInit();
        else showLogin('会话已失效，请重新输入。');
      })
      .catch(() => undefined);
  };

  window.__ptxAuth = { gate, hasSession: () => session() !== null };
})();`;
}

/** localStorage 里会话票据与到期时间的键（测试与文档引用）。 */
