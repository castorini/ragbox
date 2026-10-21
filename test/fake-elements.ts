export interface FakeElement {
  tagName: string;
  id: string;
  tabIndex: number;
  disabled: boolean;
  hidden: boolean;
  value: string;
  textContent: string;
  children: FakeElement[];
  onclick: () => unknown;
  onsubmit: (event: { preventDefault(): void }) => unknown;
  replaceChildren(...items: FakeElement[]): void;
  append(...items: FakeElement[]): void;
}

export function fakeElement(tagName = ''): FakeElement {
  return {
    tagName, id: '', tabIndex: 0, disabled: false, hidden: false,
    value: '', textContent: '', children: [],
    onclick: () => undefined,
    onsubmit: () => undefined,
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); },
  };
}

export class FakeElements extends Map<string, FakeElement> {
  override get(key: string): FakeElement {
    let value = super.get(key);
    if (!value) {
      value = fakeElement();
      this.set(key, value);
    }
    return value;
  }
}
