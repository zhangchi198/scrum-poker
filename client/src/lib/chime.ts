const KEY = 'poker.chime';
const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const;

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const browserStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null; // blocked storage (private mode, etc.)
  }
};

/** The per-user chime preference: on unless the user switched it off. */
export function chimeEnabled(store: Store | null = browserStore()): boolean {
  try {
    return store?.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setChimeEnabled(on: boolean, store: Store | null = browserStore()) {
  try {
    store?.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* the preference just won't stick */
  }
}

/** A soft two-note "ding-dong" (E5, then A5). */
export const CHIME_NOTES: readonly { freq: number; at: number }[] = [
  { freq: 659.25, at: 0 },
  { freq: 880, at: 0.18 },
];

let ctx: AudioContext | null = null;

/**
 * Browsers only allow sound after a gesture. The first click, key or touch creates and unlocks the audio
 * context, so a timer that ends later can play without one. Until then `playChime` stays silent.
 */
export function watchInteraction(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
  const stop = () => GESTURES.forEach((e) => target.removeEventListener(e, unlock));
  const unlock = () => {
    stop();
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
    } catch {
      /* no WebAudio here */
    }
  };
  GESTURES.forEach((e) => target.addEventListener(e, unlock, { passive: true }));
  return stop;
}

/** Plays the chime if the user wants it and the browser allows it. Never throws. Returns whether it started a sound. */
export function playChime(): boolean {
  try {
    if (!chimeEnabled() || !ctx || ctx.state === 'closed') return false;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    for (const n of CHIME_NOTES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      const start = t0 + n.at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1);
    }
    return true;
  } catch {
    return false;
  }
}
