import { createRoot } from 'react-dom/client';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';

// Cuando el servidor tiene una versión nueva, reemplaza a la guardada en el navegador y la página se recarga sola
// (sin esto se seguía viendo la versión anterior hasta recargar dos veces).
registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(<App />);
