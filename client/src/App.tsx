import { Home } from './components/Home.tsx';
import { RoomPage } from './components/RoomPage.tsx';
import { usePath } from './lib/router.ts';

export function App() {
  const path = usePath();
  const match = /^\/r\/([1-9A-HJ-NP-Za-km-z]{10})\/?$/.exec(path);
  if (match) return <RoomPage key={match[1]} roomId={match[1]!} />;
  return <Home />;
}
