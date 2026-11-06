import type { RoundStats } from '../../../shared/protocol.ts';
import { cardLen, formatNumber } from '../lib/format.ts';

export function StatsPanel({ stats }: { stats: RoundStats }) {
  const max = Math.max(...stats.distribution.map((d) => d.count));
  return (
    <section className="stats panel" aria-label="Round results">
      <div className="stat-row">
        {stats.average !== null && (
          <div className="stat">
            <span className="stat-label">Average</span>
            <span className="stat-value">{formatNumber(stats.average)}</span>
          </div>
        )}
        {stats.median !== null && (
          <div className="stat">
            <span className="stat-label">Median</span>
            <span className="stat-value">{formatNumber(stats.median)}</span>
          </div>
        )}
        {stats.agreement !== null && (
          <div className="stat">
            <span className="stat-label">Agreement</span>
            <span className="stat-value">{Math.round(stats.agreement * 100)}%</span>
          </div>
        )}
        <div className="stat">
          <span className="stat-label">Votes</span>
          <span className="stat-value">{stats.total}</span>
        </div>
      </div>
      <ul className="distribution">
        {stats.distribution.map((d) => (
          <li key={d.card}>
            <span className="dist-card" data-len={cardLen(d.card)}>
              {d.card}
            </span>
            <span className="dist-bar">
              <span style={{ width: `${(d.count / max) * 100}%` }} />
            </span>
            <span className="dist-count">
              {d.count} {d.count === 1 ? 'vote' : 'votes'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
