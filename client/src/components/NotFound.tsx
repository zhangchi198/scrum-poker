import { useEffect } from 'react';
import { navigate } from '../lib/router.ts';
import { setPageKind } from '../lib/vitals.ts';

/** Shown for unknown paths and for rooms that do not exist. */
export function NotFound({ title = 'Page not found', message, action = 'Back to Scrum Poker' }: { title?: string; message?: string; action?: string }) {
  useEffect(() => setPageKind('other'), []);
  return (
    <main className="center-page">
      <div className="panel">
        <h1 className="page-title">{title}</h1>
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
    </main>
  );
}
