import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withNavigationErrorHandler } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';

import { routes } from './app.routes';
import { provideFirebase } from './firebase';
import { reloadOnStaleChunk } from './stale-chunk';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withNavigationErrorHandler((e) => reloadOnStaleChunk(e))),
    provideHttpClient(withXhr()),
    provideFirebase(),
  ]
};
