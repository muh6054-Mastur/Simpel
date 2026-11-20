import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { runDataPurgeIfNecessary } from './lib/purgeDummyData';
import { syncService } from './services/syncService';
import { ErrorBoundary } from './components/common/ErrorBoundary';

// Tarik state otoritatif terbaru dari server terlebih dahulu sebelum inisialisasi cache lokal
async function mountApp() {
  try {
    await Promise.race([
      syncService.bootstrap(),
      new Promise<void>((resolve) => setTimeout(resolve, 2500)),
    ]);
  } catch (err) {
    console.warn('[Sync] Initial bootstrap deferred:', err);
  }

  try {
    // Jalankan inisialisasi bersih hanya bila perangkat & server memang belum memiliki data tersinkron
    runDataPurgeIfNecessary();
  } catch (err) {
    console.warn('[Init] Initial purge skipped:', err);
  }

  const rootEl = document.getElementById('root');
  if (rootEl) {
    createRoot(rootEl).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );
  }
}

void mountApp();
