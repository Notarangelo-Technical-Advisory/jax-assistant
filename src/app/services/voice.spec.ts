import { FLAG_DEFAULTS } from './feature-flag.service';
import { DEFAULT_VOICE, voiceToUse } from './voice';

describe('voiceToUse', () => {
  it('speaks with the default voice while the voice dropdown is hidden, even if another voice was saved earlier', () => {
    expect(voiceToUse('male-american', false)).toBe(DEFAULT_VOICE);
  });

  it('speaks with the saved voice once the voice dropdown is shown', () => {
    expect(voiceToUse('male-american', true)).toBe('male-american');
  });

  it('speaks with the default voice when no voice has been saved', () => {
    expect(voiceToUse(null, true)).toBe(DEFAULT_VOICE);
    expect(voiceToUse('', true)).toBe(DEFAULT_VOICE);
  });
});

describe('voice dropdown flag', () => {
  it('hides the voice dropdown unless Remote Config turns it on', () => {
    expect(FLAG_DEFAULTS.enable_voice_select).toBeFalse();
  });
});
