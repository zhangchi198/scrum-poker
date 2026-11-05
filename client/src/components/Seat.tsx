import type { ParticipantView } from '../../../shared/protocol.ts';

export function Seat({ p, isMe, revealed }: { p: ParticipantView; isMe: boolean; revealed: boolean }) {
  const state = revealed ? (p.vote !== null ? 'up' : 'none') : p.voted ? 'down' : 'empty';
  const label = revealed
    ? p.vote !== null
      ? `${p.name} voted ${p.vote}`
      : `${p.name} did not vote`
    : p.voted
      ? `${p.name} has voted`
      : `${p.name} is thinking`;
  return (
    <div className={`seat ${p.connected ? '' : 'offline'} ${isMe ? 'me' : ''}`} aria-label={label} title={(isMe ? 'You · ' : '') + (p.connected ? label : `${p.name} (offline)`)}>
      <div className={`slot ${state}`}>
        <div className="flip">
          <div className="face back" />
          <div className="face front">{p.vote ?? ''}</div>
        </div>
      </div>
      <div className="seat-name">{p.name}</div>
    </div>
  );
}
