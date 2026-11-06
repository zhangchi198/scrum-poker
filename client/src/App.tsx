import { Home } from './components/Home.tsx';
import { NotFound } from './components/NotFound.tsx';
import { RoomPage } from './components/RoomPage.tsx';
import { roomIdFromPath } from './lib/invite.ts';
import { usePath } from './lib/router.ts';

export function App() {
  const path = usePath();
  if (path === '/') return <Home />;
  const roomId = roomIdFromPath(path);
  if (roomId) return <RoomPage key={roomId} roomId={roomId} />;
  return <NotFound />;
}
