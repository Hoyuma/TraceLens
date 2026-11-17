export const OP_KINDS = new Set(['click', 'input', 'select', 'check', 'key', 'manual-capture', 'element-note']);
export const STATUS_LABEL: Record<string, string> = { captured: '取得済み', failed: '取得失敗', skipped: '未取得', pending: '取得待ち', 'not-applicable': '対象外' };
