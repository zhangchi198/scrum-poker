import { navigate } from '../lib/router.ts';

/** Shown for unknown paths and for rooms that do not exist. */
export function NotFound({ title = 'Page not found', message, action = 'Back to Scrum Poker' }: { title?: string; message?: string; action?: string }) {
  return (
    <div className="center-page">
      <div className="panel">
        <h2>{title}</h2>
        <p className="muted">{message ?? 'There is nothing at this address.'}</p>
        <a
          className="btn primary"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          {action}
        </a>
      </div>
    </div>
  );
}
