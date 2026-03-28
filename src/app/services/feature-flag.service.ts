import { Injectable, inject } from '@angular/core';
import { RemoteConfig, fetchAndActivate, getValue } from '@angular/fire/remote-config';

/**
 * Feature flags with their default values (used when Remote Config is unavailable).
 * To add a flag: add it here, then create a matching parameter in the Firebase console.
 */
const FLAG_DEFAULTS: Record<string, boolean> = {
  enable_voice_input: true,
  enable_tts: true,
  enable_billing_tab: true,
  enable_calendar_sync: true,
};

@Injectable({ providedIn: 'root' })
export class FeatureFlagService {
  private remoteConfig = inject(RemoteConfig);
  private initialized = false;

  constructor() {
    this.remoteConfig.defaultConfig = FLAG_DEFAULTS;
    // Fetch fresh values in the background; 1hr min fetch interval
    this.remoteConfig.settings.minimumFetchIntervalMillis = 3600000;
    this.init();
  }

  private async init(): Promise<void> {
    try {
      await fetchAndActivate(this.remoteConfig);
    } catch {
      // Falls back to defaultConfig if fetch fails
    }
    this.initialized = true;
  }

  isEnabled(flag: keyof typeof FLAG_DEFAULTS): boolean {
    return getValue(this.remoteConfig, flag).asBoolean();
  }
}
