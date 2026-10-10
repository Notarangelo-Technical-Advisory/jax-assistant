import { TestBed } from '@angular/core/testing';
import { RemoteConfig } from 'firebase/remote-config';
import { REMOTE_CONFIG } from '../firebase';
import { FeatureFlagService } from './feature-flag.service';
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

describe('FeatureFlagService voice dropdown flag', () => {
  // A Remote Config that cannot fetch, as when the app is offline, so the
  // service falls back to its defaults without contacting Firebase.
  const offlineRemoteConfig = { settings: {} } as unknown as RemoteConfig;

  beforeEach(() => {
    jasmine.clock().install();
    TestBed.configureTestingModule({ providers: [{ provide: REMOTE_CONFIG, useValue: offlineRemoteConfig }] });
  });

  afterEach(() => jasmine.clock().uninstall());

  it('hides the voice dropdown unless Remote Config turns it on', async () => {
    const flags = TestBed.inject(FeatureFlagService);
    await Promise.resolve();
    expect(flags.enableVoiceSelect()).toBeFalse();
    expect(offlineRemoteConfig.defaultConfig).toEqual(jasmine.objectContaining({ enable_voice_select: false }));
  });
});
