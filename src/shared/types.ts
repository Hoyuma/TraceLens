// TraceLens データ形式 (schemaVersion 1)
// 収集側(拡張)と利用側(Selenium等)を分離するため、ここには特定の自動化技術や
// 業務固有の概念(PJ・工程など)を持ち込まない。

export const SCHEMA_VERSION = 1;
export type ISO = string;

export interface Rect { x: number; y: number; width: number; height: number }

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  createdAt: ISO;
}

export interface EnvironmentInfo {
  userAgent: string;
  brands?: { brand: string; version: string }[];
  platform?: string;
  language?: string;
  extensionVersion: string;
}

export type SessionStatus = 'recording' | 'paused' | 'ended' | 'interrupted';

export interface RecordingSession {
  id: string;
  startedAt: ISO;
  endedAt?: ISO;
  status: SessionStatus;
  endReason?: string;
  startUrl?: string;
  environment: EnvironmentInfo;
  pauses: { pausedAt: ISO; resumedAt?: ISO }[];
}

export interface StepGroup { id: string; name: string }

/** 出力時の値置換ルール。記録データ自体は変更しない。 */
export interface ReplacementRule { id: string; find: string; replaceWith: string; enabled: boolean }

export interface Scenario {
  schemaVersion: number;
  id: string;
  projectId: string;
  name: string;
  purpose: string;
  preconditions: string;
  expectedResult: string;
  openQuestions: string;
  createdAt: ISO;
  updatedAt: ISO;
  sessions: RecordingSession[];
  groups: StepGroup[];
  replacementRules: ReplacementRule[];
}

export type StepKind =
  | 'session-start' | 'click' | 'input' | 'select' | 'check' | 'key'
  | 'navigation' | 'reload' | 'spa-navigation'
  | 'manual-capture' | 'element-note' | 'session-end' | 'notice';

/** 取得状況。failed/skipped は必ず reason を持つ（空の成功データにしない）。 */
export interface CaptureStatus {
  status: 'captured' | 'failed' | 'skipped' | 'pending' | 'not-applicable';
  reasonCode?: string;
  reason?: string;
}
export interface ArtifactRef extends CaptureStatus { artifactId?: string }

export interface FrameHop { index: number; selector?: string; crossOrigin: boolean; url?: string }
export interface FrameInfo {
  isTop: boolean;
  /** トップからこのフレームまでの経路。トップは空配列。 */
  path: FrameHop[];
  url: string;
  browserFrameId?: number;
}

export interface SelectorCandidate {
  kind: 'id' | 'test-attribute' | 'name' | 'aria-label' | 'href' | 'text-xpath' | 'css-path';
  selector: string;
  language: 'css' | 'xpath';
  /** 記録時点で、scope 内で一致した件数 */
  matchCount: number | null;
  scope: 'document' | 'shadow-root';
  /** 安定性は検証していない。suspect は動的生成・位置依存の疑いあり。 */
  stability: 'unverified' | 'suspect';
  stabilityNote: string;
}

export interface ElementInfo {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role: { value: string | null; source: 'attribute' | 'implicit-heuristic' | 'none' };
  /** 簡易推定による名前候補。完全な Accessible Name 計算の結果ではない。 */
  nameCandidates: { source: string; value: string }[];
  nameMethodNote: string;
  labels: string[];
  text?: string;
  placeholder?: string;
  state: Record<string, boolean | string>;
  /** 操作時点の、このフレームのビューポート基準の矩形 */
  rect: Rect;
  attributes: Record<string, string>;
  selectors: SelectorCandidate[];
  surroundingHtml: string;
  surroundingTruncated: boolean;
  shadowPath: { hostSelector: string; mode: 'open' }[];
  hints: string[];
}

export interface ValueInfo {
  kind: 'text' | 'select' | 'checked' | 'files' | 'redacted';
  text?: string;
  redacted?: boolean;
  redactionReason?: string;
  selectedOptions?: { value: string; label: string; index: number }[];
  availableOptions?: { value: string; label: string; disabled: boolean }[];
  availableOptionsTruncated?: boolean;
  checked?: boolean;
  usedIme?: boolean;
  editCount?: number;
}

export type Observation =
  | { type: 'dom-mutations'; firstAt: ISO; lastAt: ISO; count: number }
  | { type: 'dom-quiet'; at: ISO; quietMs: number }
  | { type: 'url-change'; at: ISO; from: string; to: string }
  | { type: 'live-region'; at: ISO; role: string; text: string }
  | { type: 'ended'; at: ISO; reason: 'quiet' | 'timeout' | 'next-operation' | 'page-unload' | 'paused' };

export type ConditionBasis = 'human-stated' | 'observed' | 'unverified';
export interface Condition {
  id: string;
  type: 'proceed' | 'success';
  text: string;
  basis: ConditionBasis;
  observedAt?: ISO;
}

export interface Annotation {
  purpose: string;
  note: string;
  valueKind: 'unspecified' | 'fixed' | 'variable';
  variableName: string;
  valueSource: string;
  transformRule: string;
  conditions: Condition[];
  branching: string;
  openQuestions: string;
}

export interface Limitation { code: string; message: string }

export interface PageInfo {
  url: string;
  title: string;
  viewport?: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
}

export interface Step {
  schemaVersion: number;
  id: string;
  scenarioId: string;
  sessionId: string;
  /** 元の操作順。除外・グループ化しても変えない。 */
  seq: number;
  kind: StepKind;
  /** 操作(またはイベント)を観測した時刻 */
  operationAt: ISO;
  /** 集約した入力の最終編集時刻 */
  operationEndAt?: ISO;
  page: PageInfo;
  frame: FrameInfo;
  target?: ElementInfo;
  value?: ValueInfo;
  key?: { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
  navigation?: { fromUrl?: string; toUrl: string; navigationType?: string; navigationStartAt?: ISO };
  notice?: { code: string; message: string };
  /** 画面変化の観測。業務処理の完了を意味しない。操作後、次の操作か観測時間の上限まで続ける。 */
  observations: Observation[];
  screenshot: ArtifactRef;
  dom: ArtifactRef;
  elementCapture: CaptureStatus;
  limitations: Limitation[];
  /** 人間が「完了を確認」した時刻 */
  humanConfirmedAt?: ISO;
  annotation: Annotation;
  includeInExport: boolean;
  groupId?: string;
}

export type ArtifactPhase = 'session-start' | 'at-operation' | 'after-operation' | 'after-load' | 'manual' | 'session-end';

export interface ScreenshotMeta {
  url?: string;
  viewport?: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  /** 取得直前に再計測した対象要素の矩形(トップのビューポート基準, CSS px)。確認できなければ null。 */
  targetRectAtCapture: Rect | null;
  targetRectNote?: string;
  /** 取得タイミングに関する注意（例: 次の操作の開始時点で取得） */
  timingNote?: string;
}

export interface FormStateEntry {
  ref: number;
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  value?: string;
  redacted?: boolean;
  checked?: boolean;
  selectedValues?: string[];
  disabled?: boolean;
}

export interface Artifact {
  id: string;
  scenarioId: string;
  stepId: string;
  type: 'screenshot' | 'dom';
  /** 実際に取得した時刻（操作時刻とは別） */
  capturedAt: ISO;
  phase: ArtifactPhase;
  includeInExport: boolean;
  // screenshot
  blob?: Blob;
  meta?: ScreenshotMeta;
  /** 塗りつぶし矩形（画像ピクセル座標）。出力画像そのものに焼き込む。 */
  masks?: Rect[];
  // dom
  html?: string;
  formState?: FormStateEntry[];
  truncated?: boolean;
  frameUrl?: string;
}

export function emptyAnnotation(): Annotation {
  return { purpose: '', note: '', valueKind: 'unspecified', variableName: '', valueSource: '', transformRule: '', conditions: [], branching: '', openQuestions: '' };
}

export function hasAnnotation(a: Annotation): boolean {
  return !!(a.purpose || a.note || a.valueKind !== 'unspecified' || a.variableName || a.valueSource || a.transformRule || a.conditions.length || a.branching || a.openQuestions);
}

export function newId(prefix: string): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += (x % 36).toString(36);
  return `${prefix}_${s}`;
}

export const KIND_LABEL: Record<StepKind, string> = {
  'session-start': '記録開始', click: 'クリック', input: '入力', select: '選択', check: 'チェック', key: 'キー',
  navigation: 'ページ遷移', reload: '再読込', 'spa-navigation': 'URL変更(SPA)', 'manual-capture': '画面保存',
  'element-note': '要素注記', 'session-end': '記録終了', notice: '通知',
};

export const PHASE_LABEL: Record<ArtifactPhase, string> = {
  'session-start': '記録開始時の画面', 'at-operation': '操作時点', 'after-operation': '操作後の画面',
  'after-load': '読み込み後の画面', manual: '手動保存した画面', 'session-end': '記録終了時の画面',
};
