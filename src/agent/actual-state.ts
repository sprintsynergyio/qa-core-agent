import type { BrowserContext, Page } from 'playwright';

/** The message selectors read now and remembered while the page runs. */
const MESSAGE_SELECTORS = [
  '[role="alert"]', '[role="status"]', '[aria-live]',
  '.alert', '.error', '.invalid-feedback', '.field-error',
  '.toast', '.notification', '.help-block', '.text-danger',
];

/** How far back a remembered message counts for a finding. */
export const SEEN_MESSAGE_WINDOW_MS = 30_000;

/** The suffix on a message that was shown and is gone at the time of the reading. */
export const SHOWN_THEN_HIDDEN = ' (shown, then hidden)';

/**
 * Remembers every alert, status or validation message the page shows, with
 * the time it was first seen, on window.__qaCoreSeenMessages (capped at 20).
 * Run b4e41b D3: Toolshop shows its forgot-password error in an alert that
 * hides itself after 3 seconds, so the reading at finding time saw nothing
 * and the finding said no message was shown. Installed on every exploration
 * and replay context, beside the eval shim.
 */
const MESSAGE_MEMORY_SOURCE = `
(() => {
  if (window.__qaCoreSeenMessages) return;
  window.__qaCoreSeenMessages = [];
  var selectors = ${JSON.stringify(MESSAGE_SELECTORS)};
  function shown(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function scan() {
    var seen = window.__qaCoreSeenMessages;
    for (var s = 0; s < selectors.length; s++) {
      var nodes = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < nodes.length; i++) {
        if (!shown(nodes[i])) continue;
        var text = (nodes[i].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
        if (!text) continue;
        var known = false;
        for (var k = 0; k < seen.length; k++) if (seen[k].text === text) { seen[k].t = Date.now(); known = true; break; }
        if (!known) { seen.push({ text: text, t: Date.now() }); if (seen.length > 20) seen.shift(); }
      }
    }
  }
  function start() {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    scan();
  }
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();
`;

export async function installMessageMemory(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript({ content: MESSAGE_MEMORY_SOURCE });
}

/**
 * Reads what the page actually did, for a finding: the current URL plus any
 * visible alert / validation / toast / status text. This is the honest record
 * of "the expected outcome did not occur, here is what happened instead".
 * Shared by the Explorer (a finding at the retry cap, tools.ts) and by replay
 * and stability (an assertion that fails on a re-run, replay.ts), so both
 * record the same reading of the page.
 */
export async function captureActualState(page: Page): Promise<{ url: string; messages: string[] }> {
  const url = page.url();
  const messages = await page
    .evaluate(({ sel, windowMs, suffix }) => {
      // Every helper is a function declaration, never a const arrow, so tsx's
      // __name wrapper is not injected into the serialized body. See summarizeDom.
      const selectors = sel;
      function isShown(el: Element): boolean {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(e);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      }
      const out: string[] = [];
      for (const one of selectors) {
        const nodes = document.querySelectorAll(one);
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i] as HTMLElement;
          if (!isShown(el)) continue;
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text && out.indexOf(text) === -1) out.push(text.slice(0, 160));
          if (out.length >= 8) return out;
        }
      }
      // Messages the page showed and hid before this reading (a 3 s alert).
      const seen = ((window as unknown as { __qaCoreSeenMessages?: Array<{ text: string; t: number }> }).__qaCoreSeenMessages) ?? [];
      const now = Date.now();
      for (let i = 0; i < seen.length; i++) {
        const m = seen[i]!;
        if (now - m.t > windowMs || out.indexOf(m.text) !== -1) continue;
        out.push(m.text + suffix);
        if (out.length >= 8) break;
      }
      return out;
    }, { sel: MESSAGE_SELECTORS, windowMs: SEEN_MESSAGE_WINDOW_MS, suffix: SHOWN_THEN_HIDDEN })
    .catch(() => [] as string[]);
  return { url, messages };
}
