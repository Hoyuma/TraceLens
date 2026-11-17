// TraceLens データ形式 (schemaVersion 2)
// 収集側(拡張)と利用側(Selenium等)を分離するため、ここには特定の自動化技術や
// 業務固有の概念(PJ・工程など)を持ち込まない。

// v2 で追加した項目はすべて省略可能。v1 のレコードはそのまま読め、normalize* で既定値を補う。
export const SCHEMA_VERSION = 2;
/** 読み込める保存形式・出力形式の schemaVersion */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];
export type ISO = string;

export interface Rect { x: number; y: number; width: number; height: number }
/** 画像の編集マスク。fill=塗りつぶし(既定)、blur=復元できない強さのモザイク＋ぼかし */
export type MaskKind = 'fill' | 'blur';
export interface ImageMask extends Rect { kind?: MaskKind }

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

export interface StepGroup {
  id: string;
  name: string;
  /** 親グループ。null・未指定は最上位。循環は groups.ts の検証関数で防ぐ。(v2) */
  parentId?: string | null;
  /** 同じ親の中での表示順。未指定は配列の順。(v2) */
  order?: number;
}

/**
 * 出力時の値置換ルール。記録データ自体は変更しない。
 * isRegex のとき find は正規表現（export.ts の validateReplacementRule で検証）。
 * replaceWith は常にリテラル（$1 などの参照は展開しない。置換前の値の一部を出力に戻さないため）。
 */
export interface ReplacementRule {
  id: string;
  find: string;
  replaceWith: string;
  enabled: boolean;
  /** (v2) */
  isRegex?: boolean;
  /** 正規表現のフラグ。i / m / s / u のみ許可。g は常に付ける。(v2) */
  flags?: string;
}

/**
 * シナリオの変数 (v2)。値テンプレートの {{name}} で参照する。
 * secret の変数は defaultValue を保存しない（保存 API 側で落とす）。実行時の値も IndexedDB に保存しない。
 */
export interface ScenarioVariable {
  id: string;
  name: string;
  defaultValue?: string;
  description?: string;
  secret?: boolean;
}

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
  /** (v2) */
  variables?: ScenarioVariable[];
}

export type StepKind =
  | 'session-start' | 'click' | 'input' | 'select' | 'check' | 'key'
  | 'navigation' | 'reload' | 'spa-navigation'
  | 'manual-capture' | 'element-note' | 'session-end' | 'notice'
  /** 人が追加した、待機条件だけの手順（origin: authored）(v2) */
  | 'wait'
  /**
   * 入力済みの値の観測 (v2)。人の操作ではない。操作の直前に、入力欄に値が入っていることを観測した
   * （ブラウザの自動入力・入力内容の復元・ページのスクリプトなど。値が入った時刻・経緯は記録していない）。
   */
  | 'prefill';

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
  /**
   * 名前の候補。先頭に「accname 準拠の実装による計算結果」（source: 'accname'、rule に決定規則）が入ることがあり、
   * 以降は従来の簡易推定の候補。いずれもブラウザの Accessible Name と一致するとは保証しない。
   */
  nameCandidates: { source: string; value: string; /** 計算の出所（accname.ts の規則 ID）。省略可 */ rule?: string }[];
  nameMethodNote: string;
  /**
   * 計算した role（W3C ARIA の明示 role / HTML-AAM の暗黙 role の主要部分）。省略可。
   * 既存の `role` は従来どおりの簡易推定で、意味を変えていない。
   */
  computedRole?: { value: string | null; source: 'explicit' | 'implicit-html-aam' | 'none'; note?: string };
  /**
   * 計算した名前（accname-1.2 準拠の実装による）。省略可。
   * ブラウザの結果との一致は未検証。CSS 生成内容(::before/::after)・closed Shadow DOM・レイアウト依存の可視判定・ブラウザ固有の差は扱えない。
   * 機密欄の値は名前に含めない。
   */
  computedName?: { value: string; rule: string; ruleLabel: string; note: string };
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

// ---- 再生・編集用の層 (v2) ------------------------------------------------------
// 記録された事実（seq / operationAt / target / value / observations など）は変えず、
// 再生・編集のための指定は Step.replay / order / origin に別に持つ。

/** 記録した手順 / 取り込んだ手順 / 人が追加した手順。未指定は recorded。 */
export type StepOrigin = 'recorded' | 'imported' | 'authored';

/**
 * 再生時の待機条件。操作の間隔（記録時の時刻差）を待機時間に流用しない。
 * - element-present / element-absent: value は CSS セレクター（isRegex は使わない）
 * - text-present: value を含むテキストがページに現れる（isRegex なら正規表現）
 * - url-matches: URL が value を含む（isRegex なら正規表現）
 * - dom-quiet: DOM の変化が quietMs（未指定は既定値）止まる。画面変化の観測であり業務処理の完了ではない
 */
export interface WaitCondition {
  kind: 'none' | 'element-present' | 'element-absent' | 'text-present' | 'url-matches' | 'dom-quiet';
  value?: string;
  isRegex?: boolean;
  /** dom-quiet の静止時間 (ms) */
  quietMs?: number;
}

/** 人が指定した上書きセレクター */
export interface ReplaySelectorOverride { language: 'css' | 'xpath'; selector: string }

export interface StepReplayConfig {
  /** 再生しない（出力対象かどうか includeInExport とは独立） */
  skip?: boolean;
  /** 入力・選択に使う値。{{変数名}} を含められる。未指定は記録値。 */
  valueTemplate?: string;
  /** 人が指定したセレクター。記録された候補より先に試す。 */
  selector?: ReplaySelectorOverride;
  /** 操作後の待機条件。未指定は既定（短い DOM 静止待ち）。 */
  wait?: WaitCondition;
  /** 失敗時に止めるか続けるか。未指定は stop。 */
  onFail?: 'stop' | 'continue';
  timeoutMs?: number;
}

/**
 * 入力済みの値の観測 (v2)。
 * autofill: 観測した時点で、ブラウザの自動入力の表示（:autofill / :-webkit-autofill）に一致した。
 * 一致しなくても自動入力ではないとは限らない（ブラウザによって表示や判定が異なる）。
 */
export interface PrefillInfo { autofill: boolean }

/** 取り込み元の記録 (v2)。取り込んだ手順の元の番号・時刻はここに残す。 */
export interface ImportedFrom {
  source: 'scenario' | 'export-zip';
  scenarioId?: string;
  scenarioName?: string;
  stepId: string;
  seq: number;
  /** 取り込み元で操作を観測した時刻 */
  operationAt: ISO;
  operationEndAt?: ISO;
  /** 取り込み元で人間が完了を確認した時刻 */
  humanConfirmedAt?: ISO;
  importedAt: ISO;
}

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
  /** (v2) 未指定は recorded。authored / imported の operationAt は作成時刻（記録された操作時刻ではない）。 */
  origin?: StepOrigin;
  /** (v2) 表示・再生順。未指定は seq。並べ替えはこの値だけを変え、seq は変えない。 */
  order?: number;
  /** (v2) 再生・編集の設定 */
  replay?: StepReplayConfig;
  /** (v2) 取り込んだ手順の取り込み元 */
  importedFrom?: ImportedFrom;
  /** (v2) kind: 'prefill' の観測の内容 */
  prefill?: PrefillInfo;
  /**
   * (v2) 操作前の画面への参照（任意設定。既定は無効）。新しい画像ではなく、直前の観測で取得した画像を参照する。
   * 未設定は、設定が無効だった（または参照を試みていない）という意味。
   */
  beforeScreenshot?: BeforeScreenshot;
}

/**
 * 操作前の画面への参照 (v2)。「操作直前に取得した画像」ではない。
 * 直前の観測で取得した画像以降に、観測の範囲（MutationObserver・スクロール・リサイズ）で画面変化がなかったときだけ、
 * その画像を参照する。観測の範囲で変化なしであり、画面が同一である保証ではない
 * （CSS の :hover・アニメーション・動画・canvas・観測できないフレーム内の変化などは分からない）。
 * capturedAt は参照先の画像の取得時刻（操作時刻とは別。混ぜない）。
 */
export interface BeforeScreenshot extends ArtifactRef {
  basis: 'previous-observation';
  capturedAt?: ISO;
  /** 参照先の画像を持つ手順 */
  refStepId?: string;
}

/** 手動取得した画像の取得方法と合成の情報 (v2) */
export interface CaptureInfo {
  method: 'visible' | 'element' | 'full-page';
  /** full-page: 合成した画像の枚数 */
  frameCount?: number;
  /** full-page: 合成した範囲の高さと、取得開始時点のページ全体の高さ（CSS px） */
  composedHeightCss?: number;
  pageHeightCss?: number;
  /** 上限などにより、対象の一部だけを取得した */
  partial?: boolean;
  partialReason?: string;
  /** element: 切り出した範囲（保存した画像ではなく、取得した画像上のピクセル座標）と、要素の矩形（CSS px） */
  cropRect?: Rect;
  elementRectCss?: Rect;
  /** element: 要素の一部が表示領域外で、見えている部分だけを切り出した */
  elementClipped?: boolean;
  /** 実際の見た目と一致しないことがある理由など（断定しない） */
  notes: string[];
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
  /** (v2) 手動取得の方法と合成の情報。省略は、表示領域の通常取得 */
  captureInfo?: CaptureInfo;
  /** 塗りつぶし／ぼかしの矩形（原本画像のピクセル座標）。出力画像そのものに焼き込む。kind 省略は塗りつぶし。 */
  masks?: ImageMask[];
  /** 切り抜き範囲（原本画像のピクセル座標）。省略は切り抜きなし。範囲外の画素は出力に含めない。 */
  crop?: Rect;
  /** 切り抜きを設定した時点の原本画像のサイズ（操作位置の座標変換に使う）。 */
  cropSourceSize?: { width: number; height: number };
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
  'element-note': '要素注記', 'session-end': '記録終了', notice: '通知', wait: '待機', prefill: '入力済みの値',
};

export const ORIGIN_LABEL: Record<StepOrigin, string> = { recorded: '記録', imported: '取り込み', authored: '人が追加' };

// ---- v1 レコードの正規化 ----------------------------------------------------------
// 読み込み時に既定値を補う。schemaVersion は書き込まれた時点の値のまま残す（v1 は v2 の部分集合）。

export function normalizeProject(p: Project): Project {
  return { ...p, description: p.description ?? '' };
}

export function normalizeScenario(s: Scenario): Scenario {
  return {
    ...s,
    sessions: s.sessions ?? [],
    groups: (s.groups ?? []).map((g) => ({ ...g, parentId: g.parentId ?? null })),
    replacementRules: (s.replacementRules ?? []).map((r) => ({ ...r, isRegex: !!r.isRegex })),
    variables: s.variables ?? [],
  };
}

export function normalizeStep(s: Step): Step {
  return { ...s, origin: s.origin ?? 'recorded', annotation: { ...emptyAnnotation(), ...(s.annotation ?? {}) }, limitations: s.limitations ?? [], observations: s.observations ?? [] };
}

export const PHASE_LABEL: Record<ArtifactPhase, string> = {
  'session-start': '記録開始時の画面', 'at-operation': '操作時点', 'after-operation': '操作後の画面',
  'after-load': '読み込み後の画面', manual: '手動保存した画面', 'session-end': '記録終了時の画面',
};
