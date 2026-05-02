import { useState } from 'react';
import Dashboard from './pages/Dashboard';
import Landing from './pages/Landing';

function App() {
  // La landing e' la prima schermata: l'upload del .FIT vive nel Dashboard,
  // raggiunto solo dopo il click sul CTA. Stato volutamente locale e
  // unidirezionale: una volta entrati non si torna indietro nella stessa
  // sessione (un refresh ripropone la landing).
  const [hasEntered, setHasEntered] = useState(false);

  if (!hasEntered) {
    return <Landing onEnter={() => setHasEntered(true)} />;
  }

  return <Dashboard />;
}

export default App;
