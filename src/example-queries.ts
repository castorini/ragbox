import { requiredElement } from './boundaries.ts';
import type { Corpus } from './types.ts';

// Pools of starter questions. Each was checked against its collection's BM25 index:
// the top results must state the answer itself, not just discuss the topic. Only the
// first few NFCorpus abstracts fit the model's 3,500-token input, so an answer that
// appears only lower in the ranking is not good enough. Check new ones the same way.
export const EXAMPLE_POOL: Record<Corpus, readonly string[]> = {
  nfcorpus: [
    'Does soy increase breast cancer risk?',
    'Does curcumin have anti-inflammatory effects?',
    'Does dairy cause acne?',
    'Does green tea help prevent cancer?',
    'Can a vegan diet help manage type 2 diabetes?',
    'Do nuts lower cholesterol?',
    'Does red meat increase colorectal cancer risk?',
  ],
  msmarco: [
    'who invented the telephone',
    'how does the greenhouse effect warm the earth',
    'how do solar panels generate electricity',
    'how does caffeine affect the body',
    'how does insulin regulate blood sugar',
    'what are the side effects of antibiotics',
  ],
};
export const EXAMPLE_COUNT = 3;

// Distinct random picks in random order (partial Fisher–Yates shuffle).
export function pickExamples(pool: readonly string[], count = EXAMPLE_COUNT, random = Math.random): string[] {
  const items = [...pool];
  const picks = Math.min(count, items.length);
  for (let i = 0; i < picks; i++) {
    const j = i + Math.floor(random() * (items.length - i));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items.slice(0, picks);
}

// Chosen once per page load, so the start page and the search dropdown agree.
export const EXAMPLE_QUERIES: Record<Corpus, readonly string[]> = {
  nfcorpus: pickExamples(EXAMPLE_POOL.nfcorpus),
  msmarco: pickExamples(EXAMPLE_POOL.msmarco),
};

export function setupExampleQueries() {
  for (const [corpus, prefix] of [['nfcorpus', 'fts'], ['msmarco', 'marco']] as const) {
    const list = requiredElement<HTMLUListElement>(`#${prefix}-examples`);
    const form = requiredElement<HTMLFormElement>(`#${prefix}-form`);
    const input = requiredElement<HTMLInputElement>(`#${prefix}-query`);
    const search = requiredElement<HTMLButtonElement>(`#${prefix}-search`);
    const doc = list.ownerDocument;
    let active = -1;

    const options = EXAMPLE_QUERIES[corpus].map((query, index) => {
      const option = doc.createElement('li');
      option.id = `${prefix}-example-${index}`;
      option.className = 'example-query';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.textContent = query;
      // Keep focus in the input so choosing an option doesn't close the list first.
      option.onmousedown = event => event.preventDefault();
      option.onclick = () => choose(query);
      return option;
    });
    list.replaceChildren(...options);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-autocomplete', 'list');

    function highlight(index: number) {
      active = index;
      options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
      if (index >= 0) input.setAttribute('aria-activedescendant', options[index].id);
      else input.removeAttribute('aria-activedescendant');
    }
    function setOpen(open: boolean) {
      list.hidden = !open;
      form.classList.toggle('examples-open', open);
      input.setAttribute('aria-expanded', String(open));
      if (!open) highlight(-1);
    }
    function choose(query: string) {
      input.value = query;
      setOpen(false);
      // Search right away when the collection is ready; otherwise leave the query for later.
      if (!search.disabled) form.requestSubmit();
      else input.focus();
    }

    input.onfocus = () => setOpen(!input.value.trim());
    input.oninput = () => setOpen(!input.value.trim());
    input.onblur = () => setOpen(false);
    input.onkeydown = event => {
      if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (input.value.trim()) return;
        event.preventDefault();
        if (list.hidden) setOpen(true);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        highlight(active < 0
          ? (step > 0 ? 0 : options.length - 1)
          : (active + step + options.length) % options.length);
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
        event.preventDefault();
        choose(EXAMPLE_QUERIES[corpus][active]);
      }
    };
    setOpen(false);
  }
}
