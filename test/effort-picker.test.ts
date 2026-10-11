import { it, expect, vi, afterEach } from 'vitest';
import { EFFORT_LEVELS, effortIndex, setupEffortPicker } from '../src/effort-picker.ts';
import type { ThinkingEffort } from '../src/types.ts';

type Fake = {
  hidden: boolean; disabled: boolean; value: string; textContent: string; attributes: Map<string, string>;
  style: { setProperty: ReturnType<typeof vi.fn> }; focus: ReturnType<typeof vi.fn>;
  onclick?: () => void; oninput?: () => void;
  setAttribute(name: string, value: string): void; contains(node: unknown): boolean;
};

function harness(initial: ThinkingEffort = 'off') {
  const elements = new Map<string, Fake>();
  const listeners = new Map<string, (event: unknown) => void>();
  const make = (): Fake => ({
    hidden: false, disabled: false, value: '', textContent: '', attributes: new Map(),
    style: { setProperty: vi.fn() }, focus: vi.fn(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    contains(node) { return node === this; },
  });
  vi.stubGlobal('document', {
    querySelector: (id: string) => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  let effort = initial;
  const set = vi.fn((value: ThinkingEffort) => { effort = value; });
  const picker = setupEffortPicker({ get: () => effort, set });
  const get = (id: string) => elements.get(id)!;
  get('#effort-popover').hidden = true;
  return { picker, get, set, listeners };
}

afterEach(() => vi.unstubAllGlobals());

it('orders the levels Off, Low, Medium and maps Medium to the stored balanced value', () => {
  expect(EFFORT_LEVELS.map(level => level.label)).toEqual(['Off', 'Low', 'Medium']);
  expect(effortIndex('balanced')).toBe(2);
});

it('shows the current level on the button and in the popover', () => {
  const { get } = harness('low');
  expect(get('#effort-label').textContent).toBe('Low');
  expect(get('#effort-popover-label').textContent).toBe('Low');
  expect(get('#effort-range').value).toBe('1');
  expect(get('#chat-thinking-effort').attributes.get('aria-label')).toBe('Thinking effort: Low');
});

it('opens the slider, changes the level live, and closes on Escape', () => {
  const { get, set, listeners } = harness();
  get('#chat-thinking-effort').onclick?.();
  expect(get('#effort-popover').hidden).toBe(false);
  expect(get('#chat-thinking-effort').attributes.get('aria-expanded')).toBe('true');
  expect(get('#effort-range').focus).toHaveBeenCalled();
  get('#effort-range').value = '2';
  get('#effort-range').oninput?.();
  expect(set).toHaveBeenCalledWith('balanced');
  expect(get('#effort-label').textContent).toBe('Medium');
  listeners.get('keydown')?.({ key: 'Escape', preventDefault() {} });
  expect(get('#effort-popover').hidden).toBe(true);
  expect(get('#chat-thinking-effort').focus).toHaveBeenCalled();
});

it('closes when clicking elsewhere and when disabled', () => {
  const { picker, get, listeners } = harness();
  get('#chat-thinking-effort').onclick?.();
  listeners.get('pointerdown')?.({ target: {} });
  expect(get('#effort-popover').hidden).toBe(true);
  get('#chat-thinking-effort').onclick?.();
  picker.setDisabled(true);
  expect(get('#effort-popover').hidden).toBe(true);
  expect(get('#chat-thinking-effort').disabled).toBe(true);
});
