export interface AudioVoiceClock {
  startedAt: number;
  pausedAt?: number | null;
  pausedTicks?: number;
  offset?: number;
  offsetAt?: number;
  playbackRate?: number;
}
export function audioPlayedTicks(voice: AudioVoiceClock, tick: number): number {
  return (voice.pausedAt ?? tick) - voice.startedAt - (voice.pausedTicks ?? 0);
}
/** Source seconds; independent of the voice's maximum elapsed play duration. */
export function audioVoicePosition(voice: AudioVoiceClock, tick: number, fixedDt: number | null): number {
  return (voice.offset ?? 0) + (audioPlayedTicks(voice, tick) - (voice.offsetAt ?? 0)) * (fixedDt ?? 0) * (voice.playbackRate ?? 1);
}
