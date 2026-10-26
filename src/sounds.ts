// Gather's sound engine. Every built-in pack is synthesized with Web Audio from
// the note tables below, so there are no audio assets, licenses or downloads.
// The packs are original takes on the feel of classic messengers, not copies.

export const soundEvents = [
  "message",
  "sent",
  "ring",
  "join",
  "leave",
  "selfJoin",
  "selfLeave",
] as const;
export type SoundEvent = (typeof soundEvents)[number];

export const soundEventLabels: Record<SoundEvent, string> = {
  message: "New message",
  sent: "Message sent",
  ring: "Incoming call ring",
  join: "Someone joins the call",
  leave: "Someone leaves the call",
  selfJoin: "You join the call",
  selfLeave: "You leave the call",
};

type Note = {
  /** Frequency in Hz. */
  f: number;
  /** Start offset in seconds. */
  t: number;
  /** Duration in seconds. */
  d: number;
  /** Peak gain, 0-1. */
  g?: number;
  wave?: OscillatorType | "bell";
  /** Frequency this note glides to by its end. */
  to?: number;
};
type Sound = { notes: Note[]; loop?: number };
export type SoundPack = {
  id: string;
  name: string;
  blurb: string;
  /** Low-pass cutoff in Hz; lower is softer. */
  tone: number;
  /** Per-event gain trims measured by the offline loudness audit. */
  trim: Record<SoundEvent, number>;
  sounds: Record<SoundEvent, Sound>;
};

const n = (f: number, t: number, d: number, g = 0.5, wave?: Note["wave"]) =>
  ({ f, t, d, g, wave }) as Note;
const b = (f: number, t: number, d: number, g = 0.5) => n(f, t, d, g, "bell");

// Equal-tempered note frequencies used by the packs.
const hz = (semitonesFromA4: number) => 440 * 2 ** (semitonesFromA4 / 12);
const [C5, D5, E5, G5, A5, C6, E6, G6] = [3, 5, 7, 10, 12, 15, 19, 22].map(hz);
const [G4, A4, C4, E4, G3] = [-2, 0, -9, -5, -14].map(hz);

export const soundPacks: SoundPack[] = [
  {
    id: "chime",
    tone: 6500,
    trim: {
      message: 0.359,
      sent: 0.359,
      ring: 0.543,
      join: 0.306,
      leave: 0.313,
      selfJoin: 0.282,
      selfLeave: 0.279,
    },
    name: "Bright chimes",
    blurb: "Glassy bells, a buddy-list-era classic feel.",
    sounds: {
      message: { notes: [b(E6, 0, 0.35, 0.4), b(G6, 0.09, 0.45, 0.35)] },
      sent: { notes: [b(C6, 0, 0.18, 0.25)] },
      ring: {
        notes: [
          b(G5, 0, 0.3, 0.45),
          b(C6, 0.22, 0.3, 0.45),
          b(E6, 0.44, 0.5, 0.45),
          b(G5, 0.9, 0.3, 0.45),
          b(C6, 1.12, 0.3, 0.45),
          b(E6, 1.34, 0.5, 0.45),
        ],
        loop: 3,
      },
      join: { notes: [b(C5, 0, 0.2, 0.4), b(G5, 0.12, 0.3, 0.4)] },
      leave: { notes: [b(G5, 0, 0.2, 0.35), b(C5, 0.12, 0.3, 0.35)] },
      selfJoin: {
        notes: [b(C5, 0, 0.2, 0.4), b(E5, 0.1, 0.2, 0.4), b(G5, 0.2, 0.4, 0.4)],
      },
      selfLeave: {
        notes: [
          b(G5, 0, 0.2, 0.35),
          b(E5, 0.1, 0.2, 0.35),
          b(C5, 0.2, 0.4, 0.35),
        ],
      },
    },
  },
  {
    id: "bubbles",
    tone: 5000,
    trim: {
      message: 0.785,
      sent: 0.861,
      ring: 0.861,
      join: 0.822,
      leave: 0.75,
      selfJoin: 0.49,
      selfLeave: 0.468,
    },
    name: "Soft bubbles",
    blurb: "Round, watery pops. Gentle enough to leave on all day.",
    sounds: {
      message: {
        notes: [
          { f: 520, to: 980, t: 0, d: 0.16, g: 0.5 },
          n(1175, 0.14, 0.2, 0.25),
        ],
      },
      sent: { notes: [{ f: 700, to: 1100, t: 0, d: 0.1, g: 0.3 }] },
      ring: {
        notes: [
          { f: 420, to: 840, t: 0, d: 0.18, g: 0.5 },
          { f: 520, to: 1040, t: 0.24, d: 0.18, g: 0.5 },
          { f: 640, to: 1280, t: 0.48, d: 0.3, g: 0.5 },
        ],
        loop: 1.6,
      },
      join: { notes: [{ f: 400, to: 900, t: 0, d: 0.2, g: 0.45 }] },
      leave: { notes: [{ f: 900, to: 380, t: 0, d: 0.22, g: 0.4 }] },
      selfJoin: {
        notes: [
          { f: 380, to: 760, t: 0, d: 0.15, g: 0.45 },
          { f: 570, to: 1140, t: 0.14, d: 0.22, g: 0.45 },
        ],
      },
      selfLeave: {
        notes: [
          { f: 1000, to: 560, t: 0, d: 0.15, g: 0.4 },
          { f: 700, to: 300, t: 0.14, d: 0.24, g: 0.4 },
        ],
      },
    },
  },
  {
    id: "retro",
    tone: 3200,
    trim: {
      message: 1.035,
      sent: 0.767,
      ring: 1.641,
      join: 0.61,
      leave: 0.544,
      selfJoin: 0.676,
      selfLeave: 0.589,
    },
    name: "Retro blips",
    blurb: "Squarewave dial-up-era beeps and door-knock tones.",
    sounds: {
      message: {
        notes: [
          n(A5, 0, 0.07, 0.2, "square"),
          n(E6, 0.09, 0.07, 0.2, "square"),
          n(A5, 0.18, 0.12, 0.2, "square"),
        ],
      },
      sent: {
        notes: [
          n(E6, 0, 0.06, 0.15, "square"),
          n(A5, 0.07, 0.08, 0.15, "square"),
        ],
      },
      ring: {
        notes: [
          n(A5, 0, 0.1, 0.22, "square"),
          n(E6, 0.12, 0.1, 0.22, "square"),
          n(A5, 0.24, 0.1, 0.22, "square"),
          n(E6, 0.36, 0.1, 0.22, "square"),
          n(A5, 0.6, 0.1, 0.22, "square"),
          n(E6, 0.72, 0.1, 0.22, "square"),
        ],
        loop: 2.2,
      },
      join: {
        notes: [
          n(G3, 0, 0.08, 0.35, "triangle"),
          n(C4, 0.1, 0.08, 0.35, "triangle"),
          n(G4, 0.2, 0.2, 0.35, "triangle"),
        ],
      },
      leave: {
        notes: [
          n(G4, 0, 0.08, 0.35, "triangle"),
          n(C4, 0.1, 0.08, 0.35, "triangle"),
          n(G3, 0.2, 0.2, 0.35, "triangle"),
        ],
      },
      selfJoin: {
        notes: [
          n(C4, 0, 0.08, 0.3, "triangle"),
          n(E4, 0.09, 0.08, 0.3, "triangle"),
          n(G4, 0.18, 0.08, 0.3, "triangle"),
          n(C5, 0.27, 0.25, 0.3, "triangle"),
        ],
      },
      selfLeave: {
        notes: [
          n(C5, 0, 0.08, 0.3, "triangle"),
          n(G4, 0.09, 0.08, 0.3, "triangle"),
          n(E4, 0.18, 0.08, 0.3, "triangle"),
          n(C4, 0.27, 0.25, 0.3, "triangle"),
        ],
      },
    },
  },
  {
    id: "minimal",
    tone: 5000,
    trim: {
      message: 2.785,
      sent: 2.917,
      ring: 1.202,
      join: 1.995,
      leave: 1.718,
      selfJoin: 1.024,
      selfLeave: 0.902,
    },
    name: "Minimal",
    blurb: "A single quiet tick for each event. Ringing stays audible.",
    sounds: {
      message: { notes: [n(A5, 0, 0.12, 0.25)] },
      sent: { notes: [n(A5, 0, 0.05, 0.12)] },
      ring: {
        notes: [n(A5, 0, 0.25, 0.4), n(E6, 0.35, 0.25, 0.4)],
        loop: 2,
      },
      join: { notes: [n(D5, 0, 0.15, 0.25)] },
      leave: { notes: [n(A4, 0, 0.15, 0.25)] },
      selfJoin: { notes: [n(D5, 0, 0.12, 0.25), n(A5, 0.1, 0.15, 0.25)] },
      selfLeave: { notes: [n(A5, 0, 0.12, 0.25), n(D5, 0.1, 0.15, 0.25)] },
    },
  },
];

export type SoundPreferences = {
  /** Master switch. Off silences everything, including the ring. */
  enabled: boolean;
  /** 0-1 master volume. */
  volume: number;
  pack: string;
  /** Events that have been switched off individually. */
  off: SoundEvent[];
  /** Events that play a user-supplied file stored on this device. */
  custom: SoundEvent[];
};
export const defaultSoundPreferences: SoundPreferences = {
  enabled: true,
  volume: 0.7,
  pack: "chime",
  off: [],
  custom: [],
};
const storageKey = "gather.sounds";

/** Coerces anything stored locally back into a valid preference object. */
export function parseSoundPreferences(raw: unknown): SoundPreferences {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const events = (list: unknown) =>
    Array.isArray(list)
      ? soundEvents.filter((event) => list.includes(event))
      : [];
  const volume = Number(value.volume);
  return {
    enabled: value.enabled !== false,
    volume: Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : defaultSoundPreferences.volume,
    pack: soundPacks.some((pack) => pack.id === value.pack)
      ? (value.pack as string)
      : defaultSoundPreferences.pack,
    off: events(value.off),
    custom: events(value.custom),
  };
}
export function readSoundPreferences(): SoundPreferences {
  try {
    return parseSoundPreferences(
      JSON.parse(localStorage.getItem(storageKey) ?? "null"),
    );
  } catch {
    return parseSoundPreferences(null);
  }
}
export function saveSoundPreferences(value: SoundPreferences) {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

// Custom files live in IndexedDB so they stay on this device.
export const customSoundLimit = { bytes: 512 * 1024, seconds: 10 };
let opening: Promise<IDBDatabase> | undefined;
function database() {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("gather-sounds", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("custom");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  }).catch((error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}
async function store<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const request = run(db.transaction("custom", mode).objectStore("custom"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let context: AudioContext | undefined;
const buffers = new Map<SoundEvent, AudioBuffer | null>();
function audioContext() {
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return undefined;
    context = new Ctor();
  }
  if (context.state === "suspended") void context.resume().catch(() => {});
  return context;
}
// Browsers only allow audio after a gesture, so prime the context on first use.
if (typeof window !== "undefined") {
  const unlock = () => {
    audioContext();
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

export async function saveCustomSound(event: SoundEvent, file: File) {
  if (file.size > customSoundLimit.bytes)
    throw new Error(
      `Choose a sound under ${customSoundLimit.bytes / 1024} KB. Short clips work best.`,
    );
  const bytes = await file.arrayBuffer();
  const ctx = audioContext();
  if (!ctx) throw new Error("This device can’t play sounds.");
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error(
      "That file isn’t a sound this device can play. Try an MP3, WAV or OGG file.",
    );
  }
  if (decoded.duration > customSoundLimit.seconds)
    throw new Error(
      `Choose a sound shorter than ${customSoundLimit.seconds} seconds.`,
    );
  await store("readwrite", (s) => s.put(bytes, event));
  buffers.set(event, decoded);
}
export async function removeCustomSound(event: SoundEvent) {
  buffers.delete(event);
  await store("readwrite", (s) => s.delete(event));
}
async function customBuffer(event: SoundEvent) {
  if (buffers.has(event)) return buffers.get(event) ?? undefined;
  buffers.set(event, null);
  try {
    const bytes = await store<ArrayBuffer | undefined>("readonly", (s) =>
      s.get(event),
    );
    const ctx = audioContext();
    if (bytes && ctx)
      buffers.set(event, await ctx.decodeAudioData(bytes.slice(0)));
  } catch {
    /* A missing or corrupt custom file falls back to the pack. */
  }
  return buffers.get(event) ?? undefined;
}

// Shared output chain: a gentle low-pass takes the edge off, a compressor
// keeps overlapping notes from clipping, and a faint echo adds some room.
function outputChain(ctx: BaseAudioContext, cutoff: number) {
  const input = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = cutoff;
  tone.Q.value = 0.4;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.12;
  const echo = ctx.createDelay(0.5);
  echo.delayTime.value = 0.11;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.28;
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  input.connect(tone);
  tone.connect(compressor);
  tone.connect(echo);
  echo.connect(feedback).connect(echo);
  echo.connect(wet).connect(compressor);
  compressor.connect(ctx.destination);
  return input;
}
// Bell partial ratios (inharmonic, like struck metal) and their levels.
const bellPartials: [number, number, number][] = [
  [1, 1, 1],
  [2.76, 0.3, 0.55],
  [5.4, 0.12, 0.3],
];

function synth(
  ctx: BaseAudioContext,
  sound: Sound,
  at: number,
  volume: number,
  cutoff: number,
  level: number,
) {
  const out = outputChain(ctx, cutoff);
  for (const note of sound.notes) {
    const start = at + note.t;
    const end = start + note.d;
    const peak = Math.max(0.0001, (note.g ?? 0.5) * volume * level);
    // Each partial is [frequency ratio, relative level, relative length].
    const partials: [number, number, number][] =
      note.wave === "bell"
        ? bellPartials
        : note.wave && note.wave !== "sine"
          ? [[1, 1, 1]]
          : [
              [1, 1, 1],
              [2, 0.18, 0.7],
            ];
    for (const [ratio, rel, length] of partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type =
        note.wave && note.wave !== "bell" && note.wave !== "sine"
          ? note.wave
          : "sine";
      osc.frequency.setValueAtTime(note.f * ratio, start);
      if (note.to)
        osc.frequency.exponentialRampToValueAtTime(note.to * ratio, end);
      const bell = note.wave === "bell";
      const tail = bell ? 0.35 : 0.06;
      const stop = start + (note.d + tail) * length;
      // A 6 ms attack and exponential tail keep every note click-free.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak * rel, start + 0.006);
      gain.gain.setTargetAtTime(
        0,
        start + 0.006,
        ((note.d + tail) * length) / 4,
      );
      gain.gain.setValueAtTime(0, stop);
      osc.connect(gain).connect(out);
      osc.start(start);
      osc.stop(stop + 0.02);
    }
  }
  // Notes, then the echo tail.
  return Math.max(...sound.notes.map((note) => note.t + note.d)) + 0.9;
}
/** Renders one event into any audio context. Used by the offline audit. */
export function renderSound(
  ctx: BaseAudioContext,
  packId: string,
  event: SoundEvent,
  volume = 1,
) {
  const pack = soundPacks.find((p) => p.id === packId) ?? soundPacks[0];
  return synth(ctx, pack.sounds[event], 0, volume, pack.tone, pack.trim[event]);
}

async function play(
  event: SoundEvent,
  prefs: SoundPreferences,
  volume = prefs.volume,
) {
  const ctx = audioContext();
  if (!ctx) return 0;
  if (prefs.custom.includes(event)) {
    const buffer = await customBuffer(event);
    if (buffer) {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.buffer = buffer;
      source.connect(gain).connect(ctx.destination);
      source.start();
      return buffer.duration;
    }
  }
  const pack = soundPacks.find((p) => p.id === prefs.pack) ?? soundPacks[0];
  return synth(
    ctx,
    pack.sounds[event],
    ctx.currentTime,
    volume,
    pack.tone,
    pack.trim[event],
  );
}

// Do Not Disturb: incoming alerts stay quiet, your own actions still sound.
let silenced = false;
const quietWhenSilenced: SoundEvent[] = ["message", "ring", "join", "leave"];
export function setSoundsSilenced(value: boolean) {
  silenced = value;
}
const lastPlayed = new Map<SoundEvent, number>();
/** Plays one event's sound if sounds are enabled for it. Never throws. */
export function playSound(event: SoundEvent) {
  try {
    if (silenced && quietWhenSilenced.includes(event)) return;
    const prefs = readSoundPreferences();
    if (!prefs.enabled || prefs.off.includes(event) || prefs.volume === 0)
      return;
    // A burst of messages or roster updates should not stack into noise.
    const now = Date.now();
    if (now - (lastPlayed.get(event) ?? 0) < 250) return;
    lastPlayed.set(event, now);
    void play(event, prefs).catch(() => {});
  } catch {
    /* Sound is never allowed to break chat or calls. */
  }
}
/** Plays an event even if it is switched off, for the settings preview. */
export function previewSound(
  event: SoundEvent,
  packId?: string,
  withCustom = true,
) {
  try {
    const prefs = readSoundPreferences();
    void play(
      event,
      {
        ...prefs,
        pack: packId ?? prefs.pack,
        custom: withCustom ? prefs.custom : [],
      },
      prefs.volume || defaultSoundPreferences.volume,
    ).catch(() => {});
  } catch {
    /* ignore */
  }
}
/**
 * Starts the incoming-call ring and repeats it until the returned function is
 * called. The ring stops by itself after a minute so a forgotten call is quiet.
 */
export function playRing() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prefs = readSoundPreferences();
  if (
    silenced ||
    !prefs.enabled ||
    prefs.off.includes("ring") ||
    prefs.volume === 0
  )
    return () => {};
  const pack = soundPacks.find((p) => p.id === prefs.pack) ?? soundPacks[0];
  const gap = (pack.sounds.ring.loop ?? 2) * 1000;
  const cycle = () => {
    if (stopped) return;
    void play("ring", prefs).catch(() => {});
    timer = setTimeout(cycle, gap);
  };
  cycle();
  const limit = setTimeout(() => stop(), 60_000);
  function stop() {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(limit);
  }
  return stop;
}
