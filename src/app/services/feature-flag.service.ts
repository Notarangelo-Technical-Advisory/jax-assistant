import { Injectable, inject, signal } from '@angular/core';
import { RemoteConfig, fetchAndActivate, getValue } from '@angular/fire/remote-config';
import { environment } from '../../environments/environment';

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
  readonly enableVoiceInput = signal(FLAG_DEFAULTS.enable_voice_input);
  readonly enableTts = signal(FLAG_DEFAULTS.enable_tts);
  readonly enableBillingTab = signal(FLAG_DEFAULTS.enable_billing_tab);
  readonly enableCalendarSync = signal(FLAG_DEFAULTS.enable_calendar_sync);

  constructor() {
    this.remoteConfig.defaultConfig = FLAG_DEFAULTS;
    // In development, always fetch fresh values so flag changes take effect immediately.
    // In production, cache for 1 hour to avoid excessive Firebase requests.
    this.remoteConfig.settings.minimumFetchIntervalMillis = environment.production ? 3600000 : 0;
    this.init();
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
