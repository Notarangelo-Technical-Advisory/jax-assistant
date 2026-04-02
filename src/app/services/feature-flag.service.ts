import { Injectable, inject, signal } from '@angular/core';
import { RemoteConfig, fetchAndActivate, getValue } from '@angular/fire/remote-config';

/**
 * Feature flags with their default values (used when Remote Config is unavailable).
 * To add a flag: add it here, then create a matching parameter in the Firebase console.
 */
const FLAG_DEFAULTS = {
  enable_voice_input: true,
  enable_tts: true,
  enable_billing_tab: true,
  enable_calendar_sync: true,
} as const;

type FlagKey = keyof typeof FLAG_DEFAULTS;

@Injectable({ providedIn: 'root' })
export class FeatureFlagService {
  private remoteConfig = inject(RemoteConfig);

  // Signals start at defaults and update once Remote Config fetch completes
  readonly enableVoiceInput = signal<boolean>(FLAG_DEFAULTS.enable_voice_input);
  readonly enableTts = signal<boolean>(FLAG_DEFAULTS.enable_tts);
  readonly enableBillingTab = signal<boolean>(FLAG_DEFAULTS.enable_billing_tab);
  readonly enableCalendarSync = signal<boolean>(FLAG_DEFAULTS.enable_calendar_sync);

  constructor() {
    this.remoteConfig.defaultConfig = FLAG_DEFAULTS;
    this.remoteConfig.settings.minimumFetchIntervalMillis = 0;
    this.init();
    setInterval(() => this.init(), 10000);
  }

  private async init(): Promise<void> {
    try {
      await fetchAndActivate(this.remoteConfig);
      this.enableVoiceInput.set(getValue(this.remoteConfig, 'enable_voice_input').asBoolean());
      this.enableTts.set(getValue(this.remoteConfig, 'enable_tts').asBoolean());
      this.enableBillingTab.set(getValue(this.remoteConfig, 'enable_billing_tab').asBoolean());
      this.enableCalendarSync.set(getValue(this.remoteConfig, 'enable_calendar_sync').asBoolean());
    } catch {
      // Falls back to defaults if fetch fails
    }
  }

  isEnabled(flag: FlagKey): boolean {
    return getValue(this.remoteConfig, flag).asBoolean();
  }
}
