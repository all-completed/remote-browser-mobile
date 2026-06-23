import { createRoot } from 'react-dom/client';
import { IonApp, setupIonicReact } from '@ionic/react';
import App from './App';

import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import '@ionic/react/css/padding.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/text-alignment.css';
import './theme/variables.css';

setupIonicReact({ mode: 'md' });

// NOTE: React.StrictMode is intentionally omitted — its dev double-mount cancels
// Ionic overlay (IonModal) presentation. Ionic React apps run without it.
createRoot(document.getElementById('root')!).render(
  <IonApp>
    <App />
  </IonApp>
);
