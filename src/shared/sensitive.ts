// 機密入力欄の判定。該当する欄の値は、イベント・DOM・状態データのいずれにも保存しない。

const everSensitive = new WeakSet<Element>();
const SENSITIVE_AUTOCOMPLETE = /(password|one-time-code|cc-number|cc-csc|cc-exp)/i;

export const REDACTED_NOTE = 'パスワード等の機密欄のため値を保存しない';

export function isSensitiveField(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (everSensitive.has(el)) return true;
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  const ac = el.getAttribute('autocomplete') || '';
  if (type === 'password' || SENSITIVE_AUTOCOMPLETE.test(ac)) {
    // 「パスワードを表示」で type=text に切り替わった後も機密として扱い続ける
    everSensitive.add(el);
    return true;
  }
  return false;
}

/** ドキュメント内の機密欄を事前に印付けする（type 切替前に観測しておくため） */
export function markSensitiveFields(root: ParentNode): void {
  root.querySelectorAll('input[type="password" i], input[autocomplete], textarea[autocomplete]').forEach((el) => { isSensitiveField(el); });
}
