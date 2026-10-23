import { requiredElement } from './boundaries.ts';
import definition from '../docs/diagrams/local-inference.mmd?raw';
import type { PanzoomObject } from '@panzoom/panzoom';

export function setupInferenceDiagram() {
  const page = requiredElement<HTMLElement>('#duckdb-view');
  const status = requiredElement<HTMLElement>('#inference-diagram-status');
  const inline = requiredElement<HTMLElement>('#inference-diagram-inline');
  const interactive = requiredElement<HTMLElement>('#inference-diagram-interactive');
  const viewport = requiredElement<HTMLElement>('#inference-diagram-viewport');
  const canvas = requiredElement<HTMLElement>('#inference-diagram-canvas');
  const zoomOut = requiredElement<HTMLButtonElement>('#inference-zoom-out');
  const zoomIn = requiredElement<HTMLButtonElement>('#inference-zoom-in');
  const reset = requiredElement<HTMLButtonElement>('#inference-zoom-reset');
  const level = requiredElement<HTMLOutputElement>('#inference-zoom-level');
  const expand = requiredElement<HTMLButtonElement>('#inference-expand');
  const dialog = requiredElement<HTMLDialogElement>('#inference-diagram-dialog');
  const expanded = requiredElement<HTMLElement>('#inference-diagram-expanded');
  let rendering = false;
  let panzoom: PanzoomObject | undefined;

  function updateControls() {
    if (!panzoom) return;
    const scale = panzoom.getScale();
    const { x, y } = panzoom.getPan();
    const label = `${Math.round(scale * 100)}%`;
    if (level.value !== label) level.value = label;
    zoomOut.disabled = scale <= 0.5;
    zoomIn.disabled = scale >= 4;
    reset.disabled = Math.abs(scale - 1) < 0.001 && Math.abs(x) < 0.01 && Math.abs(y) < 0.01;
  }

  async function render() {
    if (panzoom) return;
    if (rendering || page.hidden) return;
    rendering = true;
    status.textContent = 'Rendering diagram…';
    try {
      const [{ default: mermaid }, { default: Panzoom }] = await Promise.all([
        import('mermaid'), import('@panzoom/panzoom'),
      ]);
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      const { svg, bindFunctions } = await mermaid.render('localInferenceFlow', definition);
      canvas.innerHTML = svg;
      const drawing = canvas.querySelector<SVGSVGElement>('svg');
      if (!drawing?.viewBox.baseVal.width) throw new Error('Mermaid returned an empty diagram.');
      drawing.style.maxWidth = 'none';
      bindFunctions?.(canvas);
      interactive.hidden = false;
      panzoom = Panzoom(canvas, { canvas: true, minScale: 0.5, maxScale: 4, step: 0.25, animate: false, pinchAndPan: true });
      status.hidden = true;
      expand.disabled = false;
      updateControls();
    } catch (error) {
      status.textContent = 'The diagram could not be loaded. Reload the page to retry.';
      console.error('Could not render the local inference diagram.', error);
    } finally {
      rendering = false;
    }
  }

  canvas.addEventListener('panzoomchange', updateControls);
  zoomIn.onclick = () => { panzoom?.zoomIn(); };
  zoomOut.onclick = () => { panzoom?.zoomOut(); };
  reset.onclick = () => { panzoom?.reset(); };
  viewport.addEventListener('wheel', event => {
    if (dialog.open || event.ctrlKey || event.metaKey) panzoom?.zoomWithWheel(event);
  }, { passive: false });
  viewport.addEventListener('keydown', event => {
    if (!panzoom || event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const { x, y } = panzoom.getPan();
    panzoom.pan(x + direction[0], y + direction[1]);
  });
  expand.onclick = () => {
    inline.style.minHeight = `${inline.getBoundingClientRect().height}px`;
    expanded.append(interactive);
    dialog.showModal();
    panzoom?.reset();
  };
  requiredElement<HTMLButtonElement>('#inference-dialog-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    inline.append(interactive);
    inline.style.minHeight = '';
    panzoom?.reset();
    expand.focus({ preventScroll: true });
  });

  const resize = new ResizeObserver(() => { panzoom?.reset(); });
  resize.observe(viewport);
  const visibility = new MutationObserver(() => { void render(); });
  visibility.observe(page, { attributes: true, attributeFilter: ['hidden'] });
  void render();
}
