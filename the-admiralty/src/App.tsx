import { useState } from 'react';
import Dashboard from './pages/Dashboard';
import Landing from './pages/Landing';

function App() {
  // L'upload del .FIT parte dalla landing: il CTA apre il file picker, la
  // selezione monta il Dashboard passandogli il file via initialFiles, che
  // fa partire l'analisi al mount. Stato locale e unidirezionale: un refresh
  // ripropone la landing.
  const [hasEntered, setHasEntered] = useState(false);
  const [initialFiles, setInitialFiles] = useState<FileList | null>(null);

  if (!hasEntered) {
    return (
      <Landing
        onEnter={(files) => {
          setInitialFiles(files);
          setHasEntered(true);
        }}
      />
    );
  }

  return <Dashboard initialFiles={initialFiles} />;
}

export default App;
