import { requiredElement } from './boundaries.ts';
import type { Corpus } from './types.ts';

// Starter questions offered in the search bar's dropdown while the query is empty.
export const EXAMPLE_QUERIES: Record<Corpus, readonly string[]> = {
  nfcorpus: [
    'Does vitamin D lower cancer risk?',
    'Is coffee good for your heart?',
    'Can turmeric reduce inflammation?',
  ],
  msmarco: [
    'what causes thunder',
    'how long to boil an egg',
    'what is the capital of australia',
  ],
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
