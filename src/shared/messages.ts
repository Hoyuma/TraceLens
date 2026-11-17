// 拡張内メッセージの型（コンテンツスクリプト ⇔ Service Worker ⇔ UI）
import type { ActedState, PreflightResult, ReplayAction, ReplayMode, ReplayStepResult, ResolvedReplayAction, WaitOutcome } from './replay';
import type { WaitCondition } from './types';
import type { ChangeKind, RefShot } from './beforeShot';
import type { TabRef } from './tabSwitch';
import type { Annotation, ArtifactPhase, ElementInfo, FormStateEntry, FrameInfo, Limitation, Observation, PageInfo, ScreenshotMeta, Step, StepKind, ValueInfo, CaptureStatus } from './types';

export interface DomPayload { html: string; formState: FormStateEntry[]; truncated: boolean; phase: ArtifactPhase; capturedAt: string; frameUrl: string }
export interface DomFailure { failed: true; reason: string }

export interface StepDraft {
  id: string;
  kind: StepKind;
  operationAt: string;
  operationEndAt?: string;
  page: PageInfo;
  frame: FrameInfo;
  target?: ElementInfo;
  value?: ValueInfo;
  key?: Step['key'];
  navigation?: Step['navigation'];
  elementCapture: CaptureStatus;
  limitations: Limitation[];
  annotation?: Annotation;
  /** 操作時点までに、このフレームで観測した最後の画面変化。null は観測なし、未指定は観測情報なし（操作前の画面の参照判定に使う） */
  observedChange?: { atMs: number; kind: ChangeKind } | null;
}

export type ContentMsg =
  | { t: 'hello'; top: boolean; init: boolean; url: string; navType?: string; timeOrigin?: number }
  | { t: 'step'; step: StepDraft; dom?: DomPayload | DomFailure }
  | { t: 'patch'; stepId: string; set?: Partial<Pick<Step, 'value' | 'operationEndAt' | 'page'>>; observations?: Observation[]; dom?: DomPayload | DomFailure }
  | { t: 'shot'; shots: { stepId: string; phase: ArtifactPhase; /** 取得方法。省略は表示領域 */ method?: 'visible' | 'element' }[]; timingNote?: string }
  /** (追加) 操作前の画面の参照判定用に、画面変化を観測したことを SW に知らせる（間引いて送る。内容は送らない） */
  | { t: 'change'; atMs: number; kind: ChangeKind }
  | { t: 'shot-skip'; stepId: string; reasonCode: string; reason: string }
  | { t: 'picker-done'; cancelled: boolean; stepId?: string }
  | { t: 'frames-changed' };

export interface HelloReply {
  recording: boolean;
  paused: boolean;
  picker: boolean;
  /** (追加) note: 要素注記 / element: 要素単位の画像 */
  pickerMode?: 'note' | 'element';
  /** (追加) 画面変化の観測を SW に知らせる（操作前の画面の設定が有効なとき） */
  trackChanges?: boolean;
  announce: 'session-start' | 'navigation' | null;
  fromUrl?: string;
}

export type ToContentMsg =
  | { t: 'sync' }
  | { t: 'manual-capture' }
  | { t: 'finish' }
  | { t: 'shot-meta'; stepId: string }
  /** (追加) ページ全体の取得: 開始（manual-capture の手順を作り、ページ寸法を返す） */
  | { t: 'scan-begin' }
  | { t: 'scan-scroll'; y: number }
  | { t: 'scan-end'; x: number; y: number };

/** scan-begin への応答 */
export interface ScanBeginReply {
  ok: boolean; reason?: string; stepId?: string; docToken?: string;
  pageHeight?: number; viewport?: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  /** ウィンドウ自体がスクロールしない（内部のスクロール領域だけが動く）可能性 */
  noWindowScroll?: boolean;
}
/** scan-scroll への応答 */
export interface ScanScrollReply { scrollY: number; pageHeight: number; docToken: string }
/** scan-end への応答。interfered: 取得中にユーザー操作があった */
export interface ScanEndReply { interfered: boolean; restored: boolean }

export interface ShotMetaReply { meta: ScreenshotMeta }
export interface FinishReply { step: StepDraft; dom?: DomPayload | DomFailure }

export interface ActiveSession {
  scenarioId: string;
  sessionId: string;
  tabId: number;
  windowId: number;
  status: 'recording' | 'paused';
  startedAt: number;
  pausedAccumMs: number;
  pausedAt?: number;
  lastUrl?: string;
  awaitingStart: boolean;
  needsPermission?: string;
  picker: boolean;
  nextSeq: number;
  /** トップ文書が切り替わるたびに増える。古いページ向けの画面取得を破棄するために使う */
  docEpoch: number;
  lastNoticeKey?: string;
  /** (追加) picker で要素単位の画像を取得する */
  pickerShot?: 'element';
  /** (追加) 開始時点の設定。操作前の画面の参照を作る */
  beforeShot?: boolean;
  /** (追加) 開始時点の設定。対象タブから開かれたタブへ記録対象を切り替える */
  followNewTab?: boolean;
  /** (追加) 切り替える前のタブ（直近が末尾）。戻る先 */
  tabStack?: TabRef[];
  /** (追加) 権限がなく切り替えられていない新しいタブ */
  pendingSwitch?: TabRef | null;
  /** (追加) 直前に取得した表示領域の画像（操作前の画面の参照元） */
  lastShot?: RefShot;
  /** (追加) 他のフレームを含め、SW に通知された画面変化の時刻（新しいものが末尾。最大 16 件）。内容は持たない */
  changes?: { atMs: number; kind: ChangeKind }[];
}

export type UiMsg =
  | { t: 'ui:start'; scenarioId: string; tabId: number }
  | { t: 'ui:pause' } | { t: 'ui:resume' } | { t: 'ui:stop' }
  /** mode 省略は表示領域 */
  | { t: 'ui:manual-capture'; mode?: 'visible' | 'full-page' }
  | { t: 'ui:picker'; on: boolean; /** element: 選んだ要素の画像を取得する */ shot?: 'element' }
  | { t: 'ui:state' };

export interface UiReply { ok: boolean; code?: string; message?: string; session?: ActiveSession | null }

export const STATE_KEY = 'tracelens.activeSession';
/** 記録の追加設定（chrome.storage.local）。いずれも既定は無効 */
export const SETTINGS_KEY = 'tracelens.settings';
export interface RecordSettings { beforeShot?: boolean; followNewTab?: boolean; /** 拡張 UI の表示言語（既定 ja）。記録・出力には影響しない */ lang?: 'ja' | 'en' }
export const EVT_CHANGED = 'evt:changed';

// ---- 再生 (v2) ----------------------------------------------------------------
// 型の契約だけを定義する。実装は src/background/（制御）と src/replay/（ページ内の操作・待機の観測）。
// 再生は記録セッションと同時に動かさない（どちらかが動いている間は、もう一方を開始しない）。

/** UI → Service Worker */
export type ReplayUiMsg =
  | {
      t: 'ui:replay-start';
      scenarioId: string;
      /** 省略時は、計画の最初の移動先 URL で SW が新しいタブを開いて再生する */
      tabId?: number;
      mode: ReplayMode;
      fromStepId?: string;
      toStepId?: string;
      onlyStepIds?: string[];
      /** 実行時の変数の値。secret の値は IndexedDB・storage.session に保存しない（SW のメモリのみ） */
      variableValues: Record<string, string>;
    }
  | { t: 'ui:replay-pause' }
  /** 一時停止からの再開。SW の再起動で secret の値が失われた場合は、ここで再入力を受け取る */
  | { t: 'ui:replay-resume'; variableValues?: Record<string, string> }
  /** 1 手順だけ進めて一時停止する */
  | { t: 'ui:replay-step' }
  | { t: 'ui:replay-stop' }
  /** 人の操作（manual の手順）が終わった */
  | { t: 'ui:replay-continue-manual'; stepId: string }
  | { t: 'ui:replay-state' };

export interface ReplayUiReply {
  ok: boolean;
  code?: string;
  message?: string;
  replay?: ActiveReplay | null;
  /** ui:replay-start で、実行前の確認に問題があった場合（開始しない） */
  preflight?: PreflightResult;
  /** (追加) code: permission-required のとき、アクセス権が足りないオリジン（分かる場合） */
  origin?: string;
  /** (追加) code: permission-required で、対象タブの URL が読めずオリジンが分からない（UI は <all_urls> の任意権限を案内する） */
  originUnknown?: boolean;
}

/** Service Worker → 再生スクリプト（対象タブ・対象フレームに注入） */
export type ToReplayMsg = {
  t: 'replay:run'; runId: string; action: ResolvedReplayAction;
  /** (追加) 1 回の試行の ID。操作の直前に replay:acted で SW に確認し、一致しなければ操作しない（SW 再起動後の二重操作を防ぐ） */
  attemptId?: string;
};

/** (追加) Service Worker → 再生スクリプト: 待機条件だけの観測と、再生中表示の更新 */
export type ToReplayAuxMsg =
  | { t: 'replay:wait'; runId: string; wait: WaitCondition; timeoutMs: number }
  | { t: 'replay:overlay'; text: string | null };

/** (追加) 再生スクリプト → Service Worker: 対象要素を特定でき、これから操作する（文書が切り替わっても操作済みと分かるように先に知らせる） */
export type ReplayPageMsg = { t: 'replay:acted'; runId: string; stepId: string; attemptId?: string };
export interface ReplayActedReply { proceed: boolean }

/** replay:run への応答。ok は操作を実行し待機条件を観測できたという意味で、業務処理の完了ではない */
export interface ReplayRunReply {
  status: 'ok' | 'failed' | 'manual';
  reason?: string;
  selectorUsed?: ReplayStepResult['selectorUsed'];
  matchCount?: number;
  waitOutcome?: WaitOutcome;
}

export type ActiveReplayWait =
  | { code: 'manual-step'; stepId: string; message: string }
  | { code: 'paused-by-user'; message: string }
  | { code: 'step-mode'; message: string }
  /** acted: (追加) 失敗した手順の操作を実行したか。yes / possibly のとき再試行は二重操作になり得る（UI は警告と確認を挟む） */
  | { code: 'failed-step'; stepId: string; message: string; acted?: ActedState }
  | { code: 'secret-required'; names: string[]; message: string }
  /**
   * origin: (追加) 実際にアクセス権が足りないオリジン。UI は chrome.permissions.request で要求してから再開する。
   * originUnknown: (追加) タブの URL が読めず分からない（origin は省略。UI は <all_urls> の任意権限の要求を案内する）。
   * actedResume: (追加) この手順は操作済みで、再開すると操作せず待機条件の観測から続ける（ActiveReplay.actedResume）。
   */
  | { code: 'permission'; message: string; origin?: string; originUnknown?: boolean; stepId?: string; actedResume?: boolean };

/**
 * 進行中の再生（chrome.storage.session の REPLAY_STATE_KEY）。SW が停止しても続きから再開できるように置く。
 * - 記録セッション（STATE_KEY）と同時に存在させない。
 * - plan は変数未解決のまま持つ（{{名前}} のまま）。secret の変数の値はここに入れない
 *   （SW のメモリだけに持ち、SW の再起動で失われたら waitReason: secret-required で一時停止する）。
 */
export interface ActiveReplay {
  runId: string;
  scenarioId: string;
  tabId: number;
  windowId?: number;
  mode: ReplayMode;
  status: 'running' | 'paused' | 'stopping';
  plan: ReplayAction[];
  /** 次に実行する plan の位置 */
  position: number;
  /** 1 手順ずつ進める（ui:replay-step） */
  stepMode: boolean;
  waitReason?: ActiveReplayWait;
  /** secret でない変数の実行時の値 */
  variableValues: Record<string, string>;
  /** 実行時に値が必要な secret の変数名（値は持たない） */
  secretVariableNames: string[];
  startedAt: number;
  /** トップ文書が切り替わるたびに増える（古いページ向けの応答を捨てるため） */
  docEpoch: number;
  /** (追加) 実行中の手順。acted: 操作を始めたことをページから受け取った（SW 再起動時に再試行してよいかの判定に使う） */
  inFlight?: { position: number; stepId: string; attemptId: string; acted: boolean };
  /** (追加) SW が計画の先頭の移動先で新しいタブを開いた（先頭の navigate では再読み込みせず読み込み完了を待つだけにする） */
  openedTab?: boolean;
  /**
   * (追加) この手順は操作済み。再開時（SW の再起動後を含む）は操作をせず、待機条件の観測だけを行う。
   * 遷移後のページの権限待ちで一時停止したとき、操作の後に文書が切り替わって観測し直すときに置く。手順の結果が確定したら消す。
   */
  actedResume?: { position: number; stepId: string; attemptId?: string; acted: true; startedAt: string; selectorUsed?: ReplayStepResult['selectorUsed']; matchCount?: number };
}

export const REPLAY_STATE_KEY = 'tracelens.replay';
