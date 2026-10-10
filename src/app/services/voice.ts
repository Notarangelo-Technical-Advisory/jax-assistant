/** The voice Maisie speaks with when no other voice has been chosen. */
export const DEFAULT_VOICE = 'female-british';

/**
 * The voice to speak with. A saved choice counts only while the voice
 * dropdown is shown; otherwise a voice picked earlier could never be changed.
 */
export function voiceToUse(saved: string | null, choiceEnabled: boolean): string {
  return (choiceEnabled && saved) || DEFAULT_VOICE;
}
