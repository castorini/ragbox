import { requiredElement } from './boundaries.ts';
import type { Corpus, ModelCacheAvailability, ModelStatus } from './types.ts';
import { ModelService, citationTargetMap } from './model-service.ts';
import type { CitationTargets, Capability, ControllerState } from './model-service.ts';
import type { LoadCoordinator } from './load-coordinator.ts';
import { formatBytes } from './format.ts';
export { detectWebGPU, citedIds } from './model-service.ts';
export type { Capability, ControllerState, GenerateOptions } from './model-service.ts';
const CITATION = /\[([A-Za-z0-9_.:-]+)\]/g;
interface ControllerElements {
  setup?: HTMLElement | null;
  loadButton: HTMLButtonElement;
  stopButton?: HTMLButtonElement;
  cancelLoadButton?: HTMLButtonElement;
  searchStatus?: HTMLElement;
  searchLoadButton?: HTMLButtonElement;
  searchCancelButton?: HTMLButtonElement;
  installedStatus?: HTMLElement;
  announcement?: HTMLElement;
  settingsLink?: HTMLElement;
  repairLink?: HTMLElement;
  answerControls?: Partial<Record<Corpus, AnswerControls>>;
  status: HTMLElement;
  progress: HTMLProgressElement;
  answers?: Partial<Record<Corpus, HTMLElement>>;
  answer?: HTMLElement;
  generating?: Partial<Record<Corpus, HTMLElement>>;
  modelCard?: HTMLElement;
}

interface AnswerControls {
  stop: HTMLButtonElement;
  copy: HTMLButtonElement;
  retry: HTMLButtonElement;
  load: HTMLButtonElement;
  status: HTMLElement;
  feedback: HTMLElement;
}

export function renderAnswer(container: HTMLElement, text: unknown, citationTargets: CitationTargets = new Map()) {
  const value = String(text ?? '');
  const targets = citationTargetMap(citationTargets);
  if (!container.ownerDocument || typeof container.replaceChildren !== 'function') {
    container.textContent = value;
    return;
  }
  const nodes = [];
  let position = 0;
  for (const match of value.matchAll(CITATION)) {
    if (match.index > position) nodes.push(container.ownerDocument.createTextNode(value.slice(position, match.index)));
    const id = match[1];
    if (targets.has(id)) {
      const link = container.ownerDocument.createElement('a');
      link.href = targets.get(id) ?? '';
      link.textContent = match[0];
      link.title = `Jump to retrieved evidence ${id}`;
      nodes.push(link);
    } else {
      nodes.push(container.ownerDocument.createTextNode(match[0]));
    }
    position = match.index + match[0].length;
  }
  if (position < value.length) nodes.push(container.ownerDocument.createTextNode(value.slice(position)));
  container.replaceChildren(...nodes);
}

function setText(element: HTMLElement | undefined, text: string) {
  if (element && element.textContent !== text) element.textContent = text;
}

export class LLMController extends ModelService {
  private elements: ControllerElements;
  private answers: Partial<Record<Corpus, HTMLElement>>;
  private announcementKey = '';
  constructor(options: ConstructorParameters<typeof ModelService>[0] & { elements: ControllerElements }) {
    super(options);
    this.elements = options.elements;
    this.answers = options.elements.answers ?? { nfcorpus: options.elements.answer };
  }
  answerFor(corpus: Corpus) {
    const answer = this.answers[corpus];
    if (!answer) throw new Error(`No answer destination is configured for ${corpus}.`);
    return answer;
  }
  protected override renderSession(corpus: Corpus, text: string, targets = new Map<string, string>()) {
    const answer = this.answers[corpus];
    if (answer) renderAnswer(answer, this.elements.answerControls?.[corpus] && this.retrievalMessages.has(corpus) ? '' : text, targets);
  }
  protected override setFeedback(corpus: Corpus, message: string) {
    setText(this.elements.answerControls?.[corpus]?.feedback, message);
  }
  updateControls(restoreFocus = true) {
    const focused = this.elements.loadButton.ownerDocument?.activeElement;
    const message = this.statusText();
    setText(this.elements.status, message);
    setText(this.elements.searchStatus, message);
    const cacheLabels: Record<ModelCacheAvailability, string> = {
      checking: 'Checking installed files…', missing: 'Not installed', incomplete: 'Incomplete install',
      installed: 'Installed · MiniCPM5-2B', corrupt: 'Invalid model files', unknown: 'Installed files unavailable',
    };
    setText(this.elements.installedStatus, cacheLabels[this.model.cache]);
    const canLoad = !['checking', 'unsupported', 'loading', 'ready', 'generating'].includes(this.state);
    for (const button of [this.elements.loadButton, this.elements.searchLoadButton]) {
      if (!button) continue;
      button.hidden = !canLoad;
      button.disabled = !canLoad;
      button.textContent = this.loadAction();
    }
    for (const button of [this.elements.cancelLoadButton, this.elements.searchCancelButton]) {
      if (!button) continue;
      button.hidden = this.state !== 'loading';
      button.disabled = this.state !== 'loading';
      button.textContent = this.model.stage === 'downloading' ? 'Cancel download' : 'Cancel loading';
    }
    this.elements.progress.hidden = this.state !== 'loading';
    this.elements.progress.removeAttribute?.('value');
    if (this.elements.setup) this.elements.setup.hidden = !canLoad;
    if (this.elements.settingsLink) this.elements.settingsLink.hidden = this.ready || this.state === 'loading' || this.state === 'checking';
    if (this.elements.repairLink) this.elements.repairLink.hidden = !this.repairNeeded;
    if (this.elements.stopButton) {
      this.elements.stopButton.hidden = !this.activeRequest && !this.pending;
      this.elements.stopButton.disabled = !this.activeRequest && !this.pending;
    }
    for (const corpus of ['nfcorpus', 'msmarco'] as const) {
      const session = this.sessions.get(corpus);
      const running = session?.phase === 'waiting' || session?.phase === 'generating';
      const indicator = this.elements.generating?.[corpus];
      if (indicator) indicator.hidden = !running;
      const controls = this.elements.answerControls?.[corpus];
      if (!controls) continue;
      setText(controls.status, session?.message ?? this.retrievalMessages.get(corpus) ?? '');
      controls.stop.hidden = !running;
      controls.stop.disabled = !running;
      controls.copy.disabled = !session?.text.trim();
      const recover = session?.phase === 'blocked' && canLoad;
      controls.load.hidden = !recover;
      controls.load.disabled = !recover;
      controls.load.textContent = this.loadAction();
      controls.retry.hidden = !session || running || recover || this.state === 'unsupported';
      controls.retry.disabled = !session || running || this.state === 'unsupported';
    }
    this.elements.modelCard?.toggleAttribute?.('data-repair', this.repairNeeded);
    this.elements.modelCard?.setAttribute?.('data-phase', this.state);
    this.elements.searchStatus?.setAttribute?.('data-phase', this.state);
    const key = `${this.state}:${this.model.stage}:${this.model.failure ?? ''}:${this.model.cache}`;
    if (key !== this.announcementKey) {
      this.announcementKey = key;
      setText(this.elements.announcement, this.model.stage === 'downloading' ? 'Downloading model…' : message);
    }
    if (restoreFocus) this.restoreControlFocus(focused);
    super.updateControls(restoreFocus);
  }

  private restoreControlFocus(focused: Element | null | undefined) {
    if (!focused || !('hidden' in focused) || (!focused.hidden && !('disabled' in focused && focused.disabled))) return;
    let next: HTMLElement | undefined;
    for (const [load, cancel] of [
      [this.elements.loadButton, this.elements.cancelLoadButton],
      [this.elements.searchLoadButton, this.elements.searchCancelButton],
    ]) {
      if (focused === load) next = cancel;
      else if (focused === cancel) next = load;
    }
    for (const corpus of ['nfcorpus', 'msmarco'] as const) {
      const controls = this.elements.answerControls?.[corpus];
      if (!controls || ![controls.stop, controls.copy, controls.retry, controls.load].includes(focused as HTMLButtonElement)) continue;
      next = !controls.stop.hidden ? controls.stop : !controls.load.hidden ? controls.load
        : !controls.copy.disabled ? controls.copy : controls.retry;
    }
    if (next && !next.hidden && !('disabled' in next && next.disabled)) next.focus();
  }

}

export function setupLLM(onState?: (state: ControllerState, message: string, model: ModelStatus) => void, loads?: LoadCoordinator) {
  const answerControls = Object.fromEntries((['nfcorpus', 'msmarco'] as const).map(corpus => {
    const prefix = corpus === 'nfcorpus' ? 'fts' : 'marco';
    if (!document.querySelector(`#${prefix}-answer`)) return [corpus, undefined];
    return [corpus, {
      stop: requiredElement<HTMLButtonElement>(`#${prefix}-answer-stop`),
      copy: requiredElement<HTMLButtonElement>(`#${prefix}-answer-copy`),
      retry: requiredElement<HTMLButtonElement>(`#${prefix}-answer-retry`),
      load: requiredElement<HTMLButtonElement>(`#${prefix}-answer-load`),
      status: requiredElement<HTMLElement>(`#${prefix}-answer-status`),
      feedback: requiredElement<HTMLElement>(`#${prefix}-answer-feedback`),
    }];
  })) as Record<Corpus, AnswerControls>;
  const elements: ControllerElements = {
    setup: requiredElement<HTMLElement>('#llm-setup'),
    loadButton: requiredElement<HTMLButtonElement>('#llm-load'),
    cancelLoadButton: requiredElement<HTMLButtonElement>('#llm-cancel-load'),
    searchStatus: requiredElement<HTMLElement>('#model-search-status'),
    searchLoadButton: requiredElement<HTMLButtonElement>('#model-search-load'),
    searchCancelButton: requiredElement<HTMLButtonElement>('#model-search-cancel'),
    installedStatus: requiredElement<HTMLElement>('#model-installed-status'),
    announcement: requiredElement<HTMLElement>('#model-announcement'),
    settingsLink: requiredElement<HTMLElement>('#model-setup-link'),
    repairLink: requiredElement<HTMLElement>('#model-repair-link'),
    modelCard: requiredElement<HTMLElement>('#model'),
    status: requiredElement<HTMLElement>('#llm-status'),
    progress: requiredElement<HTMLProgressElement>('#llm-progress'),
    generating: { nfcorpus: document.querySelector<HTMLElement>('#fts-generating') ?? undefined, msmarco: document.querySelector<HTMLElement>('#marco-generating') ?? undefined },
    answers: { nfcorpus: document.querySelector<HTMLElement>('#fts-answer') ?? undefined, msmarco: document.querySelector<HTMLElement>('#marco-answer') ?? undefined },
    answerControls,
  };
  const controller = new LLMController({ elements, onState, loads });
  elements.loadButton.onclick = elements.searchLoadButton!.onclick = () => { void controller.recoverModel(); };
  elements.cancelLoadButton!.onclick = elements.searchCancelButton!.onclick = () => { controller.cancelLoad(); };
  for (const corpus of ['nfcorpus', 'msmarco'] as const) {
    const controls = answerControls[corpus];
    if (!controls) continue;
    controls.stop.onclick = () => { controller.cancel(); };
    controls.copy.onclick = () => { void controller.copyAnswer(corpus); };
    controls.retry.onclick = () => { controller.retryAnswer(corpus); };
    controls.load.onclick = () => { void controller.recoverModel(); controller.retryAnswer(corpus); };
  }
  controller.updateControls();
  return controller;
}
