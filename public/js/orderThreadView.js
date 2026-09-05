// Shared renderer for a per-order message thread (migration 0037). Each
// view (owner detail, buyer review, worker card, driver card) calls
// renderOrderThread(container, orderId) with its own element; the compose
// box posts via orderMessages.sendMessage. Re-renders itself on send and on
// any orderMessages cache change the caller has subscribed to.
import { timeAgo } from './data.js';
import { getCurrentUserId } from './identity.js';
import { getMessagesForOrder, sendMessage } from './orderMessages.js';

// Message bodies are free-form user text — unlike most of this codebase's
// template-literal HTML, this one MUST escape before interpolating.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderOrderThread(container, orderId, initialDraft) {
  if (!container) return;
  const me = getCurrentUserId();
  const msgs = getMessagesForOrder(orderId);
  // Preserve an in-progress draft across a re-render (a message arriving via
  // Realtime must not wipe what the reader is typing). initialDraft lets a
  // caller that rebuilds the whole container (a list re-render) pass the
  // value it captured before the old element was destroyed.
  const prevInput = container.querySelector('.msg-input');
  const draft = prevInput ? prevInput.value : (initialDraft || '');
  const hadFocus = (prevInput && document.activeElement === prevInput) || (initialDraft != null && initialDraft !== '');
  container.innerHTML = `
    <div class="msg-list">
      ${msgs.length === 0
        ? '<p class="empty-hint">No messages yet — ask a question or leave a note about this order.</p>'
        : msgs.map(m => `
          <div class="msg-row${m.authorId === me ? ' msg-row-mine' : ''}">
            <span class="msg-meta">${esc(m.authorName)} &middot; ${timeAgo(m.createdAt)}</span>
            <span class="msg-body">${esc(m.body)}</span>
          </div>`).join('')}
    </div>
    <div class="msg-compose">
      <input type="text" class="text-input msg-input" placeholder="Write a message…" maxlength="2000" />
      <button type="button" class="btn btn-secondary msg-send">Send</button>
    </div>
    <p class="form-status msg-status" aria-live="polite"></p>
  `;

  const input = container.querySelector('.msg-input');
  const btn = container.querySelector('.msg-send');
  const status = container.querySelector('.msg-status');
  if (draft) input.value = draft;
  if (hadFocus) { input.focus(); input.setSelectionRange(draft.length, draft.length); }

  const submit = async () => {
    const body = input.value.trim();
    if (!body) return;
    btn.disabled = true;
    input.disabled = true;
    const result = await sendMessage(orderId, body);
    if (!result.ok) {
      btn.disabled = false;
      input.disabled = false;
      status.textContent = result.error;
      status.className = 'form-status error';
      return;
    }
    renderOrderThread(container, orderId);
    const fresh = container.querySelector('.msg-input');
    if (fresh) fresh.focus();
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}
