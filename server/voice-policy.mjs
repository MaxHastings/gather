// The pilot needs 2–4 callers. Keep this bound explicit: an N-person mesh uses
// N*(N-1)/2 connections and N-1 outgoing audio streams per participant.
export const MAX_VOICE_PARTICIPANTS = 4;
export const VOICE_TOPOLOGY = "mesh";
