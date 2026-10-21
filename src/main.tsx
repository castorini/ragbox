import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRuntime } from './runtime.ts';
import { App } from './app/app.tsx';
import { RuntimeProvider } from './app/context.tsx';
import './style.css';
const runtime = new AppRuntime();
createRoot(document.getElementById('root')!).render(<StrictMode><RuntimeProvider runtime={runtime}><App /></RuntimeProvider></StrictMode>);
void runtime.start();
