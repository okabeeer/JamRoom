// The JamRoom UI inside Spotify. Spotify owns the page URL, so the app keeps its own
// route (and remembers it, to reopen your Jam after a restart).

import { useCallback, useState } from 'react';
import Home from '../../client/src/Home.jsx';
import Jam from '../../client/src/Jam.jsx';

const ROUTE_KEY = 'jamroom:route';
const JAM_PATH = /^\/jam\/([a-z0-9]{6})$/;

function savedRoute() {
  try {
    return localStorage.getItem(ROUTE_KEY) || '/';
  } catch {
    return '/';
  }
}

export default function PluginApp() {
  const [path, setPath] = useState(savedRoute);
  const navigate = useCallback((to) => {
    setPath(to);
    try {
      localStorage.setItem(ROUTE_KEY, to);
    } catch {
      // not remembered
    }
  }, []);
  const match = path.match(JAM_PATH);
  return match ? <Jam key={match[1]} code={match[1]} navigate={navigate} /> : <Home navigate={navigate} />;
}
