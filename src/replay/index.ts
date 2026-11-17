// TraceLens 再生スクリプト（再生対象タブの各フレームに、Service Worker から都度注入される。マニフェストには登録しない）
// - 記録用スクリプト（window.__tracelensContent）とは別のガードで二重注入を防ぐ
// - 操作・待機の観測は core.ts。ここは拡張内メッセージの受け口と、再生中の表示だけ
import type { ReplayActedReply, ReplayMainClickReply, ReplayPageMsg, ReplayRunReply, ToReplayAuxMsg, ToReplayMsg } from '../shared/messages';
import { cssPath } from '../shared/selectors';
import { executeAction, waitFor, waitReply, MAIN_CLICK_ATTR, OVERLAY_TAG, type FrameDescription } from './core';

declare global { interface Window { __tracelensReplay?: { version: number; describe(): FrameDescription } } }

(() => {
  if (window.__tracelensReplay) return;
  const isTop = window.top === window;

  function describe(): FrameDescription {
    const path: FrameDescription['path'] = [];
    let w: Window = window;
    let guard = 0;
    while (w !== w.parent && guard++ < 20) {
      const parent = w.parent;
      let index = -1;
      try { for (let i = 0; i < parent.frames.length; i++) if (parent.frames[i] === w) { index = i; break; } } catch { /* ignore */ }
      const hop: { index: number; selector?: string; url?: string } = { index };
      try { const fe = w.frameElement; if (fe) hop.selector = cssPath(fe).selector; } catch { /* cross-origin */ }
      try { hop.url = w.location.href; } catch { /* cross-origin */ }
      path.unshift(hop);
      w = parent;
    }
    let iframeCount: number | undefined;
    try { iframeCount = document.querySelectorAll('iframe,frame').length; } catch { /* ignore */ }
    return { isTop, path, url: location.href, readyState: document.readyState, iframeCount };
  }
  window.__tracelensReplay = { version: 1, describe };

  // ---- 再生中の表示（トップのみ。クリックを妨げず、記録・待機の観測に混ざらない） ----
  let overlay: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  function setOverlay(text: string | null) {
    if (!isTop) return;
    if (text === null) { overlay?.remove(); overlay = null; label = null; return; }
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement(OVERLAY_TAG);
      const sr = overlay.attachShadow({ mode: 'closed' });
      sr.innerHTML = `<style>.b{position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none;background:#243b53;color:#fff;font:12px/1.5 system-ui,sans-serif;padding:6px 10px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:360px;opacity:.92}.t{font-weight:600}</style><div class="b"><div class="t">TraceLens 再生中</div><div class="s"></div></div>`;
      label = sr.querySelector('.s');
      document.documentElement.appendChild(overlay);
    }
    if (label) label.textContent = text;
  }

  const env = { doc: document, win: window };

  chrome.runtime.onMessage.addListener((msg: ToReplayMsg | ToReplayAuxMsg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.t !== 'string') return;
    if (msg.t === 'replay:run') {
      const { runId, action, attemptId } = msg;
      void executeAction(action, {
        ...env,
        beforeAct: async () => {
          // 操作の直前に SW へ知らせる（この後ページが遷移して応答が届かなくても、操作済みと分かるように）
          try {
            const r = (await chrome.runtime.sendMessage({ t: 'replay:acted', runId, stepId: action.stepId, attemptId } satisfies ReplayPageMsg)) as ReplayActedReply | undefined;
            return !!r?.proceed;
          } catch { return false; }
        },
        mainWorldClick: async (el) => {
          // 印を付けて SW に依頼し、SW が world: 'MAIN' でその要素を click() する（javascript: URL を拡張側の CSP で止めないため）
          const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
          try {
            el.setAttribute(MAIN_CLICK_ATTR, token);
            const r = (await chrome.runtime.sendMessage({ t: 'replay:main-click', runId, stepId: action.stepId, attemptId, token } satisfies ReplayPageMsg)) as ReplayMainClickReply | undefined;
            return r ?? { ok: false, reason: 'Service Worker から応答がない' };
          } catch (e) {
            return { ok: false, reason: String((e as Error)?.message || e) };
          } finally {
            try { if (el.getAttribute(MAIN_CLICK_ATTR) === token) el.removeAttribute(MAIN_CLICK_ATTR); } catch { /* ignore */ }
          }
        },
      }).then((r: ReplayRunReply) => sendResponse(r), (e) => sendResponse({ status: 'failed', reason: `再生スクリプトの例外: ${(e as Error)?.name ?? 'Error'}` } satisfies ReplayRunReply));
      return true;
    }
    if (msg.t === 'replay:wait') {
      void waitFor(msg.wait, env, Date.now() + msg.timeoutMs).then((wo) => sendResponse({ ...waitReply(wo, false), href: location.href } satisfies ReplayRunReply));
      return true;
    }
    if (msg.t === 'replay:overlay') {
      if (!isTop) return;
      setOverlay(msg.text);
      sendResponse({ ok: true });
    }
    return;
  });
})();
