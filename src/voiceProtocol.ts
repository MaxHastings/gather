import type { RealtimeClient } from "./realtime";

export type VoicePeer = {
  connectionId: string;
  userId: string;
  name: string;
  muted: boolean;
};
export type VoiceSnapshot = { groupId: string; peers: VoicePeer[] };

// Both adapters publish an authoritative roster before replying. Either is a
// valid acknowledgement, so a delayed/lost RPC reply must not end a working call.
export function joinVoice(
  client: RealtimeClient,
  groupId: string,
  muted: boolean,
): Promise<VoiceSnapshot> {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () =>
      client.off("voice", roster).off("disconnect", offline);
    const accept = (snapshot: VoiceSnapshot) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(snapshot);
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const roster = (snapshot: VoiceSnapshot) => {
      if (
        snapshot.groupId === groupId &&
        snapshot.peers.some((peer) => peer.connectionId === client.connectionId)
      )
        accept(snapshot);
    };
    const offline = () => fail(new Error("Connection interrupted."));
    client.on("voice", roster).on("disconnect", offline);
    void client
      .request<VoiceSnapshot>("voice:join", { groupId, muted })
      .then(accept, fail);
  });
}
