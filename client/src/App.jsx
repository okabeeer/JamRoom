import { useCallback, useEffect, useState } from 'react';
import Home from './Home.jsx';
import Jam from './Jam.jsx';

const JAM_PATH = /^\/jam\/([a-z0-9]{6})\/?$/i;

export default function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to) => {
    window.history.pushState(null, '', to);
    setPath(to);
  }, []);

  const match = path.match(JAM_PATH);
  if (match) {
    const code = match[1].toLowerCase();
    return <Jam key={code} code={code} navigate={navigate} />;
  }
  return <Home navigate={navigate} />;
}
