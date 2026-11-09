import type { Entity, WorldEvent } from '../core/types';
import { TICKS_PER_SECOND } from '../core/time';
import { OBSERVER_SPEECH_MAX_LENGTH, observerSpeechProblem } from '../core/speech';
import { CHAT_LIFETIME_MS, SpeechChat, speechChatLine, speechMessageKey, type ChatLine } from './speech-chat';
import './speech-chat.css';

interface ChatContext {
  available: boolean;
  live: boolean;
  tick: number;
  entities: Pick<Entity, 'id' | 'name'>[];
  voice?: { name: string };
  settingsOpen: boolean;
}
type WorldApi = (path: string, params?: Record<string, string | number | undefined>) => string;

export class WorldChat {
  private root = document.createElement('div');
  private feed = new SpeechChat();
  private signature = '';
  private pending = false;
  private history = new Map<string, WorldEvent>();
  private historyEpoch = 0;
  private historyLoading = false;
  private hasMore = true;
  private log: HTMLElement;
  private panel: HTMLElement;
  private scroll: HTMLElement;
  private historyLines: HTMLElement;
  private historyStatus: HTMLElement;
  private input: HTMLInputElement;
  private status: HTMLElement;

  constructor(private container: HTMLElement, private api: WorldApi, private context: () => ChatContext) {
    this.root.className = 'world-chat-ui';
    this.root.innerHTML = `
      <div class="speech-chat" role="log" aria-live="polite" aria-relevant="additions" aria-label="World chat"></div>
      <section class="chat-panel" hidden aria-label="World chat history">
        <div class="chat-history" tabindex="0" aria-label="Conversation history">
          <div class="chat-history-status" role="status"></div>
          <div class="chat-history-lines"></div>
        </div>
        <form class="chat-composer" aria-label="Speak from the sky">
          <input id="world-chat-input" type="text" maxlength="${OBSERVER_SPEECH_MAX_LENGTH}" autocomplete="off" aria-label="Message as GOD" aria-describedby="world-chat-status">
          <p id="world-chat-status" class="chat-status" role="status"></p>
        </form>
      </section>`;
    const find = <T extends HTMLElement>(selector: string) => this.root.querySelector<T>(selector)!;
    this.log = find('.speech-chat'); this.panel = find('.chat-panel'); this.scroll = find('.chat-history');
    this.historyLines = find('.chat-history-lines'); this.historyStatus = find('.chat-history-status');
    this.input = find('input'); this.status = find('.chat-status');
    find<HTMLFormElement>('form').onsubmit = event => { event.preventDefault(); void this.send(); };
    this.scroll.onscroll = () => { if (this.scroll.scrollTop < 48 && this.hasMore) void this.loadHistory(); };
    this.input.oninput = () => this.renderControls();
    window.addEventListener('keydown', this.keydown, true);
    container.append(this.root);
  }
  private keydown = (event: KeyboardEvent) => {
    if (!this.panel.hidden && (event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape')) {
      event.preventDefault(); event.stopPropagation(); this.close(); return;
    }
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!this.panel.hidden && event.key === 'Enter' && event.target === this.input) {
      event.preventDefault(); event.stopPropagation(); void this.send(); return;
    }
    if (event.repeat || event.key.toLowerCase() !== 't' || (event.target as HTMLElement | null)?.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (this.context().available && !this.context().settingsOpen) { event.preventDefault(); this.open(); }
  };
  private row(line: ChatLine, transient: boolean) {
    const row = document.createElement('div'); row.className = 'speech-chat-line'; row.dataset.eventId = String(line.id);
    row.style.setProperty('--speaker-color', line.color);
    if (transient) row.style.setProperty('--chat-age', `${-(performance.now() - line.received)}ms`);
    const name = document.createElement('span'); name.className = 'speech-chat-name'; name.textContent = `${line.name}: `;
    row.append(name, document.createTextNode(line.text)); return row;
  }
  add(events: WorldEvent[]) {
    this.feed.add(events, this.context().entities, performance.now());
    if (!this.panel.hidden && events.some(event => event.type === 'speech')) {
      const atBottom = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 32;
      const top = this.scroll.scrollTop;
      this.mergeHistory(events);
      this.renderHistory();
      this.scroll.scrollTop = atBottom ? this.scroll.scrollHeight : top;
    }
  }
  reset(events: WorldEvent[] = []) {
    this.feed.reset(); this.log.replaceChildren(); this.signature = '';
    const earliest = this.context().tick / TICKS_PER_SECOND - CHAT_LIFETIME_MS / 1000;
    this.add(events.filter(event => event.time >= earliest));
    if (!this.panel.hidden) this.startHistory();
  }
  render(now: number) {
    const lines = this.feed.visible(now), signature = lines.map(line => line.id).join(',');
    if (signature !== this.signature) {
      this.signature = signature;
      const ids = new Set(lines.map(line => String(line.id)));
      for (const row of Array.from(this.log.children)) if (!ids.has((row as HTMLElement).dataset.eventId!)) row.remove();
      for (const line of lines) if (!this.log.querySelector(`[data-event-id="${line.id}"]`)) this.log.append(this.row(line, true));
      this.log.scrollTop = this.log.scrollHeight;
    }
    if (this.context().settingsOpen && !this.panel.hidden) this.close(false);
    this.renderControls();
  }
  private renderControls() {
    const state = this.context(), canSend = state.available && state.live && !!state.voice && !this.pending;
    this.input.disabled = !canSend;
    this.input.placeholder = !state.live ? 'Return to Live to speak.' : state.voice ? '' : 'Read-only chat';
    this.input.setAttribute('aria-label', `Message as ${state.voice?.name ?? 'observer'}`);
  }
  private open() {
    if (!this.panel.hidden) return;
    this.panel.hidden = false; this.root.classList.add('chat-is-open'); this.status.textContent = '';
    this.renderControls(); this.startHistory();
    if (!this.input.disabled) this.input.focus(); else this.scroll.focus();
  }
  private close(focus = true) {
    this.panel.hidden = true; this.root.classList.remove('chat-is-open'); this.historyEpoch++; this.historyLoading = false;
    this.renderControls();
    if (focus) this.container.querySelector('canvas')?.focus();
  }
  private startHistory() {
    this.historyEpoch++; this.historyLoading = false; this.hasMore = true; this.history.clear(); this.historyLines.replaceChildren();
    void this.loadHistory();
  }
  private renderHistory() {
    const fragment = document.createDocumentFragment(), entities = this.context().entities;
    for (const event of [...this.history.values()].sort((a, b) => a.id - b.id)) {
      const line = speechChatLine(event, entities, 0);
      if (line) fragment.append(this.row(line, false));
    }
    this.historyLines.replaceChildren(fragment);
  }
  private mergeHistory(events: WorldEvent[]) {
    for (const event of events) {
      const key = speechMessageKey(event);
      if (key === undefined) continue;
      const prior = this.history.get(key);
      if (!prior || event.id < prior.id) this.history.set(key, event);
    }
  }
  private async loadHistory() {
    if (this.historyLoading || !this.hasMore || this.panel.hidden) return;
    const epoch = this.historyEpoch, before = this.history.size ? [...this.history.values()].reduce((min, event) => Math.min(min, event.id), Number.MAX_SAFE_INTEGER) : undefined;
    this.historyLoading = true; this.historyStatus.textContent = 'Loading messages...';
    try {
      const response = await fetch(this.api('speech', { tick: this.context().tick, before }));
      if (!response.ok) throw new Error('Chat history could not be loaded.');
      const page = await response.json() as { events: WorldEvent[]; hasMore: boolean };
      if (epoch !== this.historyEpoch) return;
      const height = this.scroll.scrollHeight, top = this.scroll.scrollTop;
      this.mergeHistory(page.events);
      this.hasMore = page.hasMore; this.renderHistory();
      this.historyStatus.textContent = '';
      this.scroll.scrollTop = before === undefined ? this.scroll.scrollHeight : top + this.scroll.scrollHeight - height;
    } catch (error) {
      if (epoch === this.historyEpoch) { this.historyStatus.textContent = error instanceof Error ? error.message : 'Chat history unavailable.'; }
    } finally {
      if (epoch === this.historyEpoch) this.historyLoading = false;
    }
  }
  private async send() {
    if (this.pending || !this.context().live || !this.context().voice) return;
    const text = this.input.value.trim(), problem = observerSpeechProblem(text);
    if (problem) { this.status.textContent = problem; return; }
    this.pending = true; this.status.textContent = 'Sending...'; this.renderControls();
    try {
      const response = await fetch(this.api('speech'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const data = await response.json() as { error?: string; event?: WorldEvent };
      if (!response.ok) throw new Error(data.error ?? 'Your message could not be sent.');
      if (data.event && this.context().live) this.add([data.event]);
      this.input.value = ''; this.close();
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : 'Your message could not be sent.';
    } finally {
      this.pending = false; this.renderControls();
      if (!this.panel.hidden && !this.input.disabled) this.input.focus();
    }
  }
  dispose() { this.historyEpoch++; window.removeEventListener('keydown', this.keydown, true); this.root.remove(); }
}
