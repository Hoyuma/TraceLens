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

// ---- 値の有無・自動入力の状態（値の内容は返さない） ---------------------------------
// 機密欄でも読めるよう、ここでは値の「有無」と「初期値との違い」だけを真偽値で返す。値そのものを返す関数を足さない。

function isValueField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

/** 入力欄に値が入っているか（値の内容は返さない） */
export function fieldHasValue(el: Element): boolean {
  if (!isValueField(el)) return false;
  try { return el.value !== ''; } catch { return false; }
}

/** 入力欄の値が、HTML の初期値（value 属性・textarea の中身）と違うか（値の内容は返さない） */
export function valueDiffersFromDefault(el: Element): boolean {
  if (!isValueField(el)) return false;
  try { return el.value !== el.defaultValue; } catch { return false; }
}

/**
 * ブラウザの自動入力の表示（:autofill / :-webkit-autofill）に一致するか。
 * 判定できない（擬似クラスに未対応など）場合は false。一致しないことは、自動入力でないことを意味しない。
 */
export function isAutofilled(el: Element): boolean {
  for (const sel of [':autofill', ':-webkit-autofill']) {
    try { if (el.matches(sel)) return true; } catch { /* 未対応の擬似クラス */ }
  }
  return false;
}

/**
 * 自動入力の表示はあるが、値がページに渡っていない欄か。
 * Chromium は、パスワードの自動入力の値を、人がページを操作する（クリック・キー入力）まで
 * ページのスクリプトにもフォームの送信にも渡さないことがある。再生のイベント（isTrusted=false）ではこの操作にならない。
 */
export function autofillPending(el: Element): boolean {
  return isAutofilled(el) && !fieldHasValue(el);
}
