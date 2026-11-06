import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { openEarlySocket } from './lib/earlySocket.ts';
import { captureInjectedLookup } from './lib/injected.ts';
import { startVitals } from './lib/vitals.ts';
import './styles.css';

startVitals();
captureInjectedLookup();
openEarlySocket();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
