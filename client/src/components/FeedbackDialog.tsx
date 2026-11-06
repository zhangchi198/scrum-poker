import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FEEDBACK_LIMITS, FEEDBACK_TYPES, type FeedbackPage, type FeedbackType } from '../../../shared/feedback.ts';
import '../feedback.css';

const TYPE_LABEL: Record<FeedbackType, string> = { bug: 'Bug', idea: 'Idea', other: 'Other' };
const COUNTER_FROM = 1800;

/**
 * Feedback form in a native <dialog> (same pattern as SettingsDialog). Only the page kind ("home" or "room")
 * is sent as context, never the room id or URL, because room links are secrets.
 */
export function FeedbackDialog({ page, onClose }: { page: FeedbackPage; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const downOnBackdrop = useRef(false);
  const errorId = useId();
  const [type, setType] = useState<FeedbackType>('idea');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    messageRef.current?.focus();
  }, []);

  useEffect(() => {
    if (state === 'done') closeRef.current?.focus();
  }, [state]);

  const tooShort = message.trim().length < FEEDBACK_LIMITS.messageMin;

  async function send(e: FormEvent) {
    e.preventDefault();
    if (state === 'sending') return;
    if (tooShort) {
      setError(`Please write at least ${FEEDBACK_LIMITS.messageMin} characters.`);
      messageRef.current?.focus();
      return;
    }
    setError(null);
    setState('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          message: message.trim(),
          contact: contact.trim() || undefined,
          page,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) {
        let msg = 'Could not send your feedback. Please try again.';
        if (res.status === 429) msg = 'Too many messages just now. Please try again later.';
        else if (res.status === 400) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (body.error) msg = body.error;
        }
        throw new Error(msg);
      }
      setState('done');
    } catch (err) {
      setError(err instanceof TypeError ? 'Could not reach the server. Check your connection and try again.' : (err as Error).message);
      setState('idle');
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog feedback-dialog"
      aria-labelledby="feedback-title"
      onClose={onClose}
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current && state !== 'sending') dialogRef.current?.close();
      }}
    >
      {state === 'done' ? (
        <div className="modal-body" role="status">
          <h2 id="feedback-title">Feedback sent</h2>
          <p>Thanks! The developer reads every message.</p>
          <div className="dialog-actions">
            <button ref={closeRef} type="button" className="btn primary" onClick={() => dialogRef.current?.close()}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="modal-body" onSubmit={send} noValidate>
          <h2 id="feedback-title">Send feedback</h2>

          <div className="field" role="radiogroup" aria-label="Type of feedback">
            <span aria-hidden>Type</span>
            <div className="seg">
              {FEEDBACK_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={type === t}
                  className={type === t ? 'on' : ''}
                  onClick={() => setType(t)}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="fb-message">
              <span>Message</span>
            </label>
            <textarea
              id="fb-message"
              ref={messageRef}
              rows={5}
              value={message}
              maxLength={FEEDBACK_LIMITS.messageMax}
              placeholder={type === 'bug' ? 'What happened, and what did you expect?' : 'What should we know?'}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setMessage(e.target.value)}
            />
            {message.length >= COUNTER_FROM && (
              <small className={`counter ${message.length >= FEEDBACK_LIMITS.messageMax ? 'full' : ''}`} aria-live="polite">
                {message.length} / {FEEDBACK_LIMITS.messageMax}
              </small>
            )}
          </div>

          <label className="field">
            <span>Email or name, if you’d like a reply (optional)</span>
            <input value={contact} maxLength={FEEDBACK_LIMITS.contactMax} autoComplete="off" onChange={(e) => setContact(e.target.value)} />
          </label>

          {error && (
            <p id={errorId} className="form-error" role="alert">
              {error}
            </p>
          )}
          <p className="muted small">Your room link is never included.</p>

          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={state === 'sending'}>
              {state === 'sending' ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
