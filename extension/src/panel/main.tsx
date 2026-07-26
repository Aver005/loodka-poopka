import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initStoreSync, useStore } from '../store';
import { App } from './App';
import '../styles.css';

// Панель — отдельный документ со своим экземпляром стора. Без этой подписки
// она не увидит, что оверлей разобрал новый матч.
initStoreSync();
void useStore.persist.rehydrate();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
