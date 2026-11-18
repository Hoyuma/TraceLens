// 再生時の URL の置き換え（純粋関数）
// 記録した URL（遷移先・待機条件の URL・フレームの URL）の先頭部分を、再生時だけ別の URL に置き換える。
// 記録そのもの（Step.page・navigation・frame）は書き換えない（原則 14: 元の記録を保持する）。
// 例: https://test.example.com/app/ → https://staging2.example.com/app/
import type { UrlRewrite } from './types';
import { newId } from './types';

export function newUrlRewrite(from = '', to = ''): UrlRewrite { return { id: newId('url'), from, to, enabled: true }; }

const httpUrl = (v: string): URL | null => {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:' ? u : null; } catch { return null; }
};

/** 規則の検査。問題がなければ空配列 */
export function validateUrlRewrite(r: Pick<UrlRewrite, 'from' | 'to'>): string[] {
  const out: string[] = [];
  const f = httpUrl(r.from.trim()), t = httpUrl(r.to.trim());
  if (!r.from.trim()) out.push('置き換える URL（元）が空');
  else if (!f) out.push('置き換える URL（元）は http:// または https:// で始まる URL にする');
  else if (f.search || f.hash) out.push('置き換える URL（元）に ? や # 以降は含めない（先頭部分で一致させるため）');
  if (!r.to.trim()) out.push('置き換え後の URL が空');
  else if (!t) out.push('置き換え後の URL は http:// または https:// で始まる URL にする');
  else if (t.search || t.hash) out.push('置き換え後の URL に ? や # 以降は含めない');
  return out;
}

/**
 * from が url の先頭に一致するか。境界で区切れている場合だけ（https://a.example と https://a.example.org を区別する）。
 * from の末尾が / なら、その後に何が続いてもよい。そうでなければ url が from で終わるか、次の文字が / ? # のとき。
 */
function prefixMatch(url: string, from: string): boolean {
  if (!url.startsWith(from)) return false;
  if (url.length === from.length || from.endsWith('/')) return true;
  return '/?#'.includes(url[from.length]);
}

/** 最初に一致した有効な規則で置き換える。一致しなければそのまま */
export function rewriteUrl(url: string, rules: readonly UrlRewrite[] | undefined): { url: string; rule?: UrlRewrite } {
  for (const r of rules ?? []) {
    if (!r.enabled || validateUrlRewrite(r).length) continue;
    const from = r.from.trim(), to = r.to.trim();
    if (prefixMatch(url, from)) {
      // 末尾の / の有無の違いで // や欠落が生じないよう合わせる
      const rest = url.slice(from.length);
      const joined = to.endsWith('/') && rest.startsWith('/') ? to + rest.slice(1) : !to.endsWith('/') && from.endsWith('/') && rest && !rest.startsWith('/') ? `${to}/${rest}` : to + rest;
      return { url: joined, rule: r };
    }
  }
  return { url };
}
