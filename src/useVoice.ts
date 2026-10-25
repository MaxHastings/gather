import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { api } from "./api";
import { audioError, captureMicrophone } from "./audio";
import { createAudioActivity, type AudioActivity } from "./audioActivity";
import type { RealtimeClient } from "./realtime";
import type { CallPerson, Group, Session } from "./types";
import { joinVoice } from "./voiceProtocol";
import { playSound } from "./sounds";
import { iceLifetimeSeconds, iceRenewalDelayMs } from "./icePolicy";
type IceConfig = {
  iceServers: RTCIceServer[];
  relayAvailable: boolean;
  expiresIn?: number;
};

type PeerInfo = {
  connectionId: string;
  userId: string;
  name: string;
  muted: boolean;
};
type VoiceState = { groupId: string; peers: PeerInfo[] };
type Peer = {
  pc: RTCPeerConnection;
  info: PeerInfo;
  audio: HTMLAudioElement;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  queue: Promise<void>;
  recovery?: ReturnType<typeof setTimeout>;
  offerer: boolean;
};
type ActiveCall = {
  group: Group;
  stream: MediaStream;
  config: RTCConfiguration;
  peers: Map<string, Peer>;
  roster: PeerInfo[];
  rosterSeen?: boolean;
  activity?: AudioActivity;
  relayAvailable: boolean;
  iceRenewAt: number;
  iceExpiresAt: number;
  iceTimer?: ReturnType<typeof setTimeout>;
  refreshingIce?: Promise<void>;
};
export function useVoice(
  session: Session,
  socket: RefObject<RealtimeClient | null>,
  onError: (error: string) => void,
) {
  const realtime = socket.current;
  const active = useRef<ActiveCall | null>(null);
  const generation = useRef(0);
  const joining = useRef(false);
  const joiningGroup = useRef("");
  const deviceChange = useRef(0);
  const deviceQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const muteRef = useRef(false);
  const deafRef = useRef(false);
  const previousMute = useRef(false);
  const volumes = useRef(new Map<string, number>());
  const [group, setGroup] = useState<Group | null>(null);
  const [state, setState] = useState("idle");
  const [people, setPeople] = useState<CallPerson[]>([]);
  const [speaking, setSpeaking] = useState(new Set<string>());
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [relay, setRelay] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [input, setInput] = useState(
    localStorage.getItem("gather.microphone") || "default",
  );
  const [output, setOutput] = useState(
    localStorage.getItem("gather.speaker") || "default",
  );
  const [shortcut, setShortcut] = useState(false);
  const deviceRef = useRef({ input, output });
  deviceRef.current = { input, output };
  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      onError("Audio devices are unavailable. Check microphone permissions.");
    }
  }, [onError]);
  function scheduleIce(call: ActiveCall, expiresIn?: number) {
    clearTimeout(call.iceTimer);
    if (!call.relayAvailable) {
      call.iceRenewAt = call.iceExpiresAt = Infinity;
      return;
    }
    const lifetime = iceLifetimeSeconds(expiresIn);
    call.iceExpiresAt = performance.now() + lifetime * 1000;
    call.iceRenewAt = performance.now() + iceRenewalDelayMs(lifetime);
    call.iceTimer = setTimeout(
      () => void refreshIce(call).catch(() => {}),
      iceRenewalDelayMs(lifetime),
    );
  }
  function refreshIce(call: ActiveCall): Promise<void> {
    if (active.current !== call || performance.now() < call.iceRenewAt)
      return Promise.resolve();
    if (call.refreshingIce) return call.refreshingIce;
    const task = (async () => {
      try {
        const config = await api<IceConfig>(
          session,
          `/api/groups/${call.group.id}/ice`,
          { method: "POST" },
        );
        if (active.current !== call) return;
        if (config.relayAvailable) iceLifetimeSeconds(config.expiresIn);
        const next = { ...call.config, iceServers: config.iceServers };
        for (const peer of call.peers.values())
          if (peer.pc.signalingState !== "closed")
            peer.pc.setConfiguration(next);
        call.config = next;
        call.relayAvailable = config.relayAvailable;
        setRelay(config.relayAvailable);
        scheduleIce(call, config.expiresIn);
        for (const [id, peer] of call.peers) {
          if (peer.offerer) peer.pc.restartIce();
          else void signal(id, { restart: true });
        }
      } catch (error) {
        if (active.current !== call) return;
        clearTimeout(call.iceTimer);
        // Preserve working audio during a transient credential-service outage.
        // The old expiry is not extended; reconnection will require a refresh.
        call.iceTimer = setTimeout(
          () => void refreshIce(call).catch(() => {}),
          60000,
        );
        throw error;
      } finally {
        call.refreshingIce = undefined;
      }
    })();
    call.refreshingIce = task;
    return task;
  }
  function rememberInput(id: string) {
    deviceRef.current.input = id;
    setInput(id);
    localStorage.setItem("gather.microphone", id);
  }
  function watchMicrophone(call: ActiveCall) {
    try {
      call.activity?.watch(session.user.id, call.stream);
    } catch {}
    for (const track of call.stream.getAudioTracks())
      track.onended = () => {
        if (active.current !== call) return;
        setState("reconnecting");
        void changeDevice("audioinput", "default").then((recovered) => {
          if (active.current !== call) return;
          if (recovered) {
            updatePeople();
            onError("Microphone changed. Using your system default.");
          } else leave();
        });
      };
  }
  function disposePeer(peer: Peer) {
    active.current?.activity?.remove(peer.info.userId);
    clearTimeout(peer.recovery);
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
  }
  function updatePeople() {
    const call = active.current;
    if (!call) return;
    setPeople([
      {
        ...session.user,
        local: true,
        muted: muteRef.current,
        speaking: false,
        connection: "local",
      },
      ...call.roster
        .filter((p) => p.userId !== session.user.id)
        .map((p): CallPerson => ({
          id: p.userId,
          name: p.name,
          local: false,
          muted: p.muted,
          speaking: false,
          connection:
            call.peers.get(p.connectionId)?.pc.connectionState === "connected"
              ? "connected"
              : ["failed", "disconnected"].includes(
                    call.peers.get(p.connectionId)?.pc.connectionState ?? "",
                  )
                ? "reconnecting"
                : "connecting",
        })),
    ]);
    const peers = [...call.peers.values()];
    setState(
      !socket.current?.connected
        ? "reconnecting"
        : peers.length === 0
          ? "waiting"
          : peers.every((p) => p.pc.connectionState === "connected")
            ? "connected"
            : peers.some((p) => p.pc.connectionState === "connected")
              ? "partial"
              : peers.some(
                    (p) =>
                      p.pc.connectionState === "failed" ||
                      p.pc.connectionState === "disconnected",
                  )
                ? "reconnecting"
                : "connecting",
    );
  }
  const leave = useCallback(() => {
    generation.current++;
    deviceChange.current++;
    joining.current = false;
    const call = active.current;
    active.current = null;
    if (call) {
      clearTimeout(call.iceTimer);
      for (const peer of call.peers.values()) disposePeer(peer);
      call.stream.getTracks().forEach((track) => track.stop());
      call.activity?.stop();
    }
    if (call) playSound("selfLeave");
    socket.current?.emit("voice:leave");
    setGroup(null);
    setState("idle");
    setPeople([]);
    setSpeaking(new Set());
    muteRef.current = false;
    deafRef.current = false;
    setMuted(false);
    setDeafened(false);
    void window.desktop?.setInCall(false).catch(() => {});
  }, [socket]);
  useEffect(() => () => leave(), [leave]);
  const signal = (to: string, payload: unknown) => {
    const call = active.current;
    const peer = call?.peers.get(to);
    return socket.current
      ?.request("signal", { to, ...(payload as object) })
      .catch(() => {
        if (
          active.current === call &&
          call?.peers.get(to) === peer &&
          peer &&
          peer.pc.signalingState !== "closed"
        )
          updatePeople();
      });
  };
  function getPeer(info: PeerInfo) {
    const call = active.current!;
    if (call.peers.has(info.connectionId)) {
      const existing = call.peers.get(info.connectionId)!;
      existing.info = info;
      return existing;
    }
    const pc = new RTCPeerConnection(call.config);
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.muted = deafRef.current;
    audio.volume = volumes.current.get(info.userId) ?? 1;
    audio.dataset.gatherAudio = info.userId;
    document.body.append(audio);
    const peer: Peer = {
      pc,
      info,
      audio,
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      candidates: [],
      queue: Promise.resolve(),
      offerer: socket.current!.connectionId < info.connectionId,
    };
    call.peers.set(info.connectionId, peer);
    const recover = () => {
      clearTimeout(peer.recovery);
      if (
        active.current !== call ||
        call.peers.get(info.connectionId) !== peer ||
        pc.connectionState === "closed" ||
        pc.connectionState === "connected"
      )
        return;
      if (socket.current?.connected) {
        // ICE cannot fail until the first offer is answered. Resend an unanswered
        // offer as well as restarting ICE, so an incomplete negotiation is bounded.
        if (performance.now() >= call.iceExpiresAt) {
          void refreshIce(call)
            .then(recover)
            .catch(() => {});
        } else if (!peer.offerer)
          void signal(info.connectionId, { restart: true });
        else if (
          pc.signalingState === "have-local-offer" &&
          pc.localDescription
        )
          void signal(info.connectionId, { description: pc.localDescription });
        else pc.restartIce();
      }
      peer.recovery = setTimeout(recover, 5000);
    };
    peer.recovery = setTimeout(recover, 12_000);
    pc.onicecandidate = (event) => {
      if (event.candidate)
        void signal(info.connectionId, { candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      try {
        call.activity?.watch(info.userId, audio.srcObject as MediaStream);
      } catch {}
      const sink = audio as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (sink.setSinkId)
        void sink.setSinkId(deviceRef.current.output).catch(async () => {
          if (active.current !== call) return;
          try {
            await sink.setSinkId!("default");
            deviceRef.current.output = "default";
            setOutput("default");
            localStorage.setItem("gather.speaker", "default");
            onError(
              "Headphones unavailable. Using your system default output.",
            );
          } catch {
            onError("Couldn’t open your speakers. Check Audio settings.");
          }
        });
      void audio
        .play()
        .catch(() =>
          onError("Sound is paused. Click “Enable sound” in the call panel."),
        );
    };
    pc.onnegotiationneeded = async () => {
      // Each pair has one deterministic offerer, independently of other
      // participants. The other endpoint answers and requests ICE restarts.
      if (!peer.offerer) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        void signal(info.connectionId, { description: pc.localDescription });
      } catch {
        if (active.current === call && pc.signalingState !== "closed")
          setState("reconnecting");
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (active.current !== call) return;
      updatePeople();
      if (pc.connectionState === "connected") clearTimeout(peer.recovery);
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      ) {
        clearTimeout(peer.recovery);
        peer.recovery = setTimeout(
          recover,
          pc.connectionState === "failed" ? 500 : 3000,
        );
      }
    };
    for (const track of call.stream.getAudioTracks())
      pc.addTrack(track, call.stream);
    return peer;
  }
  function syncRoster(snapshot: VoiceState) {
    const call = active.current;
    if (!call || snapshot.groupId !== call.group.id) return;
    const known = new Set(call.roster.map((p) => p.connectionId));
    const present = new Set(snapshot.peers.map((p) => p.connectionId));
    const ours = (p: PeerInfo) => p.userId === session.user.id;
    // The first snapshot is who was already here, so only later changes chime.
    if (call.rosterSeen) {
      if (snapshot.peers.some((p) => !ours(p) && !known.has(p.connectionId)))
        playSound("join");
      if (call.roster.some((p) => !ours(p) && !present.has(p.connectionId)))
        playSound("leave");
    }
    call.rosterSeen = true;
    call.roster = snapshot.peers;
    const remote = snapshot.peers.filter((p) => p.userId !== session.user.id);
    for (const [id, peer] of call.peers)
      if (!remote.some((p) => p.connectionId === id)) {
        disposePeer(peer);
        call.peers.delete(id);
      }
    remote.forEach(getPeer);
    updatePeople();
  }
  useEffect(() => {
    const client = realtime;
    if (!client) return;
    let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
    let recovering = false;
    let disposed = false;
    let rejoinError = false;
    const receive = (data: {
      from: string;
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
      restart?: boolean;
    }) => {
      const call = active.current;
      const info = call?.roster.find((p) => p.connectionId === data.from);
      if (!call || !info) return;
      const peer = getPeer(info);
      // Serialize incoming descriptions and ICE candidates on each connection.
      peer.queue = peer.queue
        .then(async () => {
          const pc = peer.pc;
          if (pc.signalingState === "closed") return;
          if (data.restart) {
            if (peer.offerer) {
              if (
                pc.signalingState === "have-local-offer" &&
                pc.localDescription
              )
                void signal(data.from, { description: pc.localDescription });
              else pc.restartIce();
            }
            return;
          }
          const polite = client.connectionId > data.from;
          if (data.description) {
            if (
              data.description.type === "answer" &&
              pc.signalingState === "stable"
            )
              return;
            const ready =
              !peer.makingOffer &&
              (pc.signalingState === "stable" || peer.settingAnswer);
            const collision = data.description.type === "offer" && !ready;
            peer.ignoreOffer = !polite && collision;
            if (peer.ignoreOffer) return;
            peer.settingAnswer = data.description.type === "answer";
            try {
              await pc.setRemoteDescription(data.description);
            } finally {
              peer.settingAnswer = false;
            }
            if (data.description.type === "offer") {
              await pc.setLocalDescription();
              void signal(data.from, { description: pc.localDescription });
            }
            // A stale trickled candidate must not prevent answering the offer.
            for (const candidate of peer.candidates.splice(0))
              await pc.addIceCandidate(candidate).catch(() => {});
          } else if (data.candidate && !peer.ignoreOffer) {
            if (pc.remoteDescription)
              await pc.addIceCandidate(data.candidate).catch(() => {});
            else {
              if (peer.candidates.length >= 128) peer.candidates.shift();
              peer.candidates.push(data.candidate);
            }
          }
        })
        .catch(() => {
          if (active.current === call && peer.pc.signalingState !== "closed") {
            setState("reconnecting");
            peer.pc.restartIce();
          }
        });
    };
    const rejoin = async () => {
      const call = active.current;
      if (!call || recovering || disposed || !client.connected) return;
      clearTimeout(rejoinTimer);
      recovering = true;
      for (const peer of call.peers.values()) disposePeer(peer);
      call.peers.clear();
      setState("reconnecting");
      try {
        await refreshIce(call);
        if (active.current !== call || disposed) return;
        const snapshot = await joinVoice(
          client,
          call.group.id,
          muteRef.current,
        );
        if (active.current === call) {
          syncRoster(snapshot);
          if (rejoinError) onError("");
          rejoinError = false;
        }
      } catch (error) {
        if (active.current !== call) return;
        rejoinError = true;
        onError(
          error instanceof Error
            ? error.message
            : "Couldn’t recover your call.",
        );
        rejoinTimer = setTimeout(() => void rejoin(), 3000);
      } finally {
        recovering = false;
      }
    };
    const offline = () => {
      if (active.current) setState("reconnecting");
    };
    const replaced = () => {
      leave();
      onError("Your call moved to another connection.");
    };
    const removed = ({ groupId }: { groupId: string }) => {
      if (
        active.current?.group.id === groupId ||
        (joining.current && joiningGroup.current === groupId)
      )
        leave();
    };
    client
      .on("group-access", removed)
      .on("voice", syncRoster)
      .on("signal", receive)
      .on("connect", rejoin)
      .on("voice:replaced", replaced)
      .on("disconnect", offline);
    // Storage hydration can install the replacement client before React runs
    // this effect. Recover an existing call even if connect already fired.
    if (client.connected && active.current) void rejoin();
    const network = () => {
      const call = active.current;
      if (!call) return;
      void refreshIce(call).catch(() => {});
      for (const [id, peer] of call.peers) {
        if (peer.offerer) peer.pc.restartIce();
        else void signal(id, { restart: true });
      }
    };
    window.addEventListener("online", network);
    return () => {
      disposed = true;
      clearTimeout(rejoinTimer);
      client
        .off("group-access", removed)
        .off("voice", syncRoster)
        .off("signal", receive)
        .off("connect", rejoin)
        .off("voice:replaced", replaced)
        .off("disconnect", offline);
      window.removeEventListener("online", network);
    };
  }, [realtime, session.server, session.token, session.user.id, onError]);
  async function join(target: Group) {
    if (target.access && target.access !== "active") return;
    if (active.current || joining.current) return;
    joining.current = true;
    joiningGroup.current = target.id;
    onError("");
    const current = ++generation.current;
    setGroup(target);
    setState("joining");
    let stream: MediaStream | undefined;
    try {
      // Reserve the native call state before network/capture work, so updates
      // cannot start in the gap between showing Joining and opening the mic.
      const shortcut = Boolean(
        await window.desktop?.setInCall(true).catch(() => false),
      );
      if (current !== generation.current) return;
      setShortcut(shortcut);
      if (!socket.current?.connected)
        throw new Error(
          "Your chat connection is recovering. Try joining again in a moment.",
        );
      const config = await api<IceConfig>(
        session,
        `/api/groups/${target.id}/ice`,
        { method: "POST" },
      );
      if (current !== generation.current) return;
      const captured = await captureMicrophone(deviceRef.current.input);
      stream = captured.stream;
      if (current !== generation.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      rememberInput(captured.deviceId);
      const call: ActiveCall = {
        group: target,
        stream,
        config: {
          iceServers: config.iceServers,
          iceTransportPolicy:
            localStorage.getItem("gather.relayOnly") === "true"
              ? "relay"
              : "all",
        },
        peers: new Map(),
        roster: [],
        relayAvailable: config.relayAvailable,
        iceRenewAt: Infinity,
        iceExpiresAt: Infinity,
      };
      active.current = call;
      scheduleIce(call, config.expiresIn);
      try {
        call.activity = createAudioActivity((ids) => {
          if (active.current === call) setSpeaking(ids);
        });
      } catch {
        /* Audio indicators must never prevent a call. */
      }
      watchMicrophone(call);
      setRelay(config.relayAvailable);
      const snapshot = await joinVoice(socket.current, target.id, false);
      if (current !== generation.current) return;
      syncRoster(snapshot);
      playSound("selfJoin");
      await refreshDevices();
      if (current !== generation.current) return;
    } catch (error) {
      stream?.getTracks().forEach((t) => t.stop());
      if (current !== generation.current) return;
      leave();
      onError(audioError(error));
    } finally {
      if (current === generation.current) joining.current = false;
    }
  }
  function applyMute(value: boolean) {
    muteRef.current = value;
    setMuted(value);
    active.current?.stream.getAudioTracks().forEach((track) => {
      track.enabled = !value;
    });
    socket.current?.emit("voice:mute", { muted: value });
    updatePeople();
  }
  const toggleMute = useCallback(() => {
    if (active.current && !deafRef.current) applyMute(!muteRef.current);
  }, []);
  useEffect(() => window.desktop?.onToggleMute(toggleMute), [toggleMute]);
  function toggleDeafen() {
    if (!active.current) return;
    const value = !deafRef.current;
    if (value) previousMute.current = muteRef.current;
    deafRef.current = value;
    setDeafened(value);
    applyMute(value || previousMute.current);
    for (const peer of active.current.peers.values()) peer.audio.muted = value;
  }
  function changeDevice(
    kind: "audioinput" | "audiooutput",
    id: string,
  ): Promise<boolean> {
    const requestedCall = active.current;
    const epoch = generation.current;
    deviceQueue.current = deviceQueue.current.then(() =>
      generation.current === epoch && active.current === requestedCall
        ? performDeviceChange(kind, id)
        : false,
    );
    return deviceQueue.current;
  }
  async function performDeviceChange(
    kind: "audioinput" | "audiooutput",
    id: string,
  ) {
    const operation = ++deviceChange.current;
    let next: MediaStream | undefined;
    try {
      const call = active.current;
      if (call && kind === "audioinput") {
        const captured = await captureMicrophone(id);
        next = captured.stream;
        id = captured.deviceId;
        const track = next.getAudioTracks()[0];
        track.enabled = !muteRef.current;
        if (active.current !== call || operation !== deviceChange.current) {
          next.getTracks().forEach((t) => t.stop());
          return false;
        }
        const oldStream = call.stream;
        call.stream = next;
        watchMicrophone(call);
        const senders = [...call.peers.values()].flatMap((p) =>
          p.pc.getSenders().filter((s) => s.track?.kind === "audio"),
        );
        const results = await Promise.allSettled(
          senders.map((s) => s.replaceTrack(track)),
        );
        if (active.current !== call) {
          oldStream.getTracks().forEach((t) => t.stop());
          next.getTracks().forEach((t) => t.stop());
          return false;
        }
        if (results.some((result) => result.status === "rejected")) {
          call.stream = oldStream;
          watchMicrophone(call);
          const rollback = await Promise.allSettled(
            [...call.peers.values()]
              .flatMap((p) => p.pc.getSenders())
              .filter((s) => s.track?.kind === "audio")
              .map((s) => s.replaceTrack(oldStream.getAudioTracks()[0])),
          );
          if (rollback.some((result) => result.status === "rejected")) {
            socket.current?.reconnect();
            throw new Error(
              "Couldn’t switch your microphone. Reconnecting with your previous microphone.",
            );
          }
          throw new Error(
            "Couldn’t switch your microphone. Your previous selection is still in use.",
          );
        }
        oldStream.getTracks().forEach((t) => t.stop());
      }
      if (kind === "audiooutput" && call) {
        const previous = [...call.peers.values()].map((peer) => ({
          audio: peer.audio,
          sink: peer.audio.sinkId || "default",
        }));
        const results = await Promise.allSettled(
          previous.map(({ audio }) => audio.setSinkId?.(id)),
        );
        if (active.current !== call || operation !== deviceChange.current)
          return false;
        if (results.some((result) => result.status === "rejected")) {
          const rollback = await Promise.allSettled(
            previous.map(({ audio, sink }) => audio.setSinkId?.(sink)),
          );
          if (rollback.some((result) => result.status === "rejected"))
            socket.current?.reconnect();
          throw new Error(
            "Couldn’t switch your headphones. Your previous output is being restored.",
          );
        }
      }
      if (kind === "audioinput") {
        rememberInput(id);
      } else {
        deviceRef.current.output = id;
        setOutput(id);
        localStorage.setItem("gather.speaker", id);
      }
      return true;
    } catch (error) {
      next?.getTracks().forEach((t) => t.stop());
      if (operation === deviceChange.current) onError(audioError(error));
      return false;
    }
  }
  useEffect(() => {
    const changed = async () => {
      try {
        await refreshDevices();
        const list = await navigator.mediaDevices.enumerateDevices();
        for (const kind of ["audioinput", "audiooutput"] as const) {
          const id =
            kind === "audioinput"
              ? deviceRef.current.input
              : deviceRef.current.output;
          if (
            id !== "default" &&
            !list.some((d) => d.kind === kind && d.deviceId === id)
          ) {
            if (await changeDevice(kind, "default"))
              onError(
                "An audio device disconnected. Gather switched to your system default.",
              );
          }
        }
      } catch {
        onError("Couldn’t refresh audio devices. Check Audio settings.");
      }
    };
    navigator.mediaDevices?.addEventListener("devicechange", changed);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", changed);
  }, [refreshDevices]);
  function setVolume(id: string, value: number) {
    volumes.current.set(id, value);
    for (const peer of active.current?.peers.values() || [])
      if (peer.info.userId === id) peer.audio.volume = value;
  }
  function enableSound() {
    active.current?.activity?.resume();
    for (const peer of active.current?.peers.values() || [])
      void peer.audio
        .play()
        .catch(() =>
          onError(
            "Audio playback is still blocked. Check your system sound settings.",
          ),
        );
  }
  return {
    group,
    state,
    people: people.map((person) => ({
      ...person,
      speaking: !person.muted && speaking.has(person.id),
    })),
    muted,
    deafened,
    relay,
    devices,
    input,
    output,
    shortcut,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    changeDevice,
    refreshDevices,
    setVolume,
    enableSound,
  };
}
