export type AudioActivity = {
  watch: (id: string, stream: MediaStream) => void;
  remove: (id: string) => void;
  resume: () => void;
  stop: () => void;
};
export function rms(samples: Float32Array) {
  return Math.sqrt(
    samples.reduce((total, sample) => total + sample * sample, 0) /
      samples.length,
  );
}

// These analysers observe existing streams. They never open another microphone,
// record audio, send activity events to a server, or connect a mic to speakers.
export function createAudioActivity(
  changed: (speaking: Set<string>) => void,
  createContext: () => AudioContext = () => new AudioContext(),
): AudioActivity {
  const context = createContext();
  const sources = new Map<
    string,
    {
      source: MediaStreamAudioSourceNode;
      analyser: AnalyserNode;
      samples: Float32Array<ArrayBuffer>;
      lastVoice: number;
    }
  >();
  let previous = new Set<string>();
  const remove = (id: string) => {
    const entry = sources.get(id);
    entry?.source.disconnect();
    entry?.analyser.disconnect();
    sources.delete(id);
  };
  const timer = setInterval(() => {
    const next = new Set<string>();
    if (context.state === "running")
      for (const [id, entry] of sources) {
        entry.analyser.getFloatTimeDomainData(entry.samples);
        if (rms(entry.samples) > 0.025) entry.lastVoice = Date.now();
        if (Date.now() - entry.lastVoice < 300) next.add(id);
      }
    if (
      next.size !== previous.size ||
      [...next].some((id) => !previous.has(id))
    ) {
      previous = next;
      changed(next);
    }
  }, 125);
  const resume = () => {
    void context.resume().catch(() => {});
  };
  resume();
  return {
    watch(id, stream) {
      remove(id);
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      sources.set(id, {
        source,
        analyser,
        samples: new Float32Array(512),
        lastVoice: -Infinity,
      });
    },
    remove,
    resume,
    stop() {
      clearInterval(timer);
      for (const id of sources.keys()) remove(id);
      previous = new Set();
      changed(previous);
      void context.close().catch(() => {});
    },
  };
}
