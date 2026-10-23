import {
  AppWindow, ArrowDown, ArrowRight, ArrowUp, BookOpen, BrainCircuit, ChevronDown, Cpu,
  Database, Download, Files, FileText, HardDrive, History, Lightbulb, LockKeyhole, Maximize2,
  MessagesSquare, MessageSquareText, RefreshCw, Repeat2, Ruler, Search,
  ShieldCheck, SlidersHorizontal, Sparkles, SquarePen, Tag, TextSearch, Trash2, createElement, createIcons,
  type IconNode, type SVGProps,
} from 'lucide';

export function appIcon(icon: IconNode, size: number, attrs: SVGProps = {}) {
  return createElement(icon, {
    width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
    'stroke-width': 1.7, ...attrs,
  });
}

export function setupIcons() {
  createIcons({
    icons: {
      AppWindow, ArrowDown, ArrowRight, ArrowUp, BookOpen, BrainCircuit, ChevronDown, Cpu,
      Database, Download, Files, FileText, HardDrive, History, Lightbulb, LockKeyhole, Maximize2,
      MessagesSquare, MessageSquareText, RefreshCw, Repeat2, Ruler, Search,
      ShieldCheck, SlidersHorizontal, Sparkles, SquarePen, Tag, TextSearch, Trash2,
    },
    attrs: { 'aria-hidden': 'true', focusable: 'false', 'stroke-width': 1.7 },
  });

  // CSS backgrounds and masks use the same Lucide artwork as DOM icons.
  const cssIcons = {
    '--icon-chevron-down': appIcon(ChevronDown, 24, { stroke: '#60736c' }),
    '--icon-search': appIcon(Search, 24, { stroke: '#000' }),
  };
  for (const [name, icon] of Object.entries(cssIcons)) {
    document.documentElement.style.setProperty(name, `url("data:image/svg+xml,${encodeURIComponent(icon.outerHTML)}")`);
  }
}
