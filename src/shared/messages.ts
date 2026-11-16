// 拡張内メッセージの型（コンテンツスクリプト ⇔ Service Worker ⇔ UI）
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
}

export type ContentMsg =
  | { t: 'hello'; top: boolean; init: boolean; url: string; navType?: string; timeOrigin?: number }
  | { t: 'step'; step: StepDraft; dom?: DomPayload | DomFailure }
  | { t: 'patch'; stepId: string; set?: Partial<Pick<Step, 'value' | 'operationEndAt' | 'page'>>; observations?: Observation[]; dom?: DomPayload | DomFailure }
  | { t: 'shot'; shots: { stepId: string; phase: ArtifactPhase }[]; timingNote?: string }
  | { t: 'shot-skip'; stepId: string; reasonCode: string; reason: string }
  | { t: 'picker-done'; cancelled: boolean; stepId?: string }
  | { t: 'frames-changed' };

export interface HelloReply {
  recording: boolean;
  paused: boolean;
  picker: boolean;
  announce: 'session-start' | 'navigation' | null;
  fromUrl?: string;
}

export type ToContentMsg =
  | { t: 'sync' }
  | { t: 'manual-capture' }
  | { t: 'finish' }
  | { t: 'shot-meta'; stepId: string };

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
}

export type UiMsg =
  | { t: 'ui:start'; scenarioId: string; tabId: number }
  | { t: 'ui:pause' } | { t: 'ui:resume' } | { t: 'ui:stop' }
  | { t: 'ui:manual-capture' }
  | { t: 'ui:picker'; on: boolean }
  | { t: 'ui:state' };

export interface UiReply { ok: boolean; code?: string; message?: string; session?: ActiveSession | null }

export const STATE_KEY = 'tracelens.activeSession';
export const EVT_CHANGED = 'evt:changed';
