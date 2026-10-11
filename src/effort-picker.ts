import { requiredElement } from './boundaries.ts';
import type { ThinkingEffort } from './types.ts';

// Thinking effort control inside the search box: a pill button showing the
// level, opening a popover with a three-stop slider (Off · Low · Medium).
export const EFFORT_LEVELS: readonly { value: ThinkingEffort; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'Fastest replies, no reasoning' },
  { value: 'low', label: 'Low', description: 'Brief reasoning before answering' },
  { value: 'balanced', label: 'Medium', description: 'More reasoning, slower replies' },
];

export function effortIndex(value: ThinkingEffort) {
  return Math.max(0, EFFORT_LEVELS.findIndex(level => level.value === value));
}

export function setupEffortPicker({ get, set }: { get: () => ThinkingEffort; set: (value: ThinkingEffort) => void }) {
  const button = requiredElement<HTMLButtonElement>('#chat-thinking-effort');
  const label = requiredElement<HTMLElement>('#effort-label');
  const popover = requiredElement<HTMLElement>('#effort-popover');
  const title = requiredElement<HTMLElement>('#effort-popover-label');
  const description = requiredElement<HTMLElement>('#effort-popover-description');
  const range = requiredElement<HTMLInputElement>('#effort-range');

  function render() {
    const level = EFFORT_LEVELS[effortIndex(get())];
    label.textContent = level.label;
    title.textContent = level.label;
    description.textContent = level.description;
    range.value = String(effortIndex(get()));
    range.setAttribute('aria-valuetext', level.label);
    // The filled part of the track follows the thumb.
    range.style.setProperty('--fill', `${effortIndex(get()) / (EFFORT_LEVELS.length - 1) * 100}%`);
    button.setAttribute('aria-label', `Thinking effort: ${level.label}`);
  }
  function setOpen(open: boolean, focusButton = false) {
    popover.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) range.focus();
    else if (focusButton) button.focus();
  }
  button.onclick = () => setOpen(Boolean(popover.hidden));
  range.oninput = () => { set(EFFORT_LEVELS[Number(range.value)]?.value ?? 'off'); render(); };
  const onPointer = (event: PointerEvent) => {
    if (!popover.hidden && !popover.contains(event.target as Node) && !button.contains(event.target as Node)) setOpen(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !popover.hidden) { event.preventDefault(); setOpen(false, true); }
  };
  document.addEventListener('pointerdown', onPointer);
  document.addEventListener('keydown', onKey);
  render();
  return {
    render,
    setDisabled(disabled: boolean) { button.disabled = disabled; if (disabled) setOpen(false); },
    dispose() {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      button.onclick = null; range.oninput = null;
    },
  };
}
