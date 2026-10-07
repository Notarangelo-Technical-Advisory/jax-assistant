import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { appConfig } from './app.config';
import { AUTH, FIREBASE_APP, FIRESTORE, REMOTE_CONFIG } from './firebase';
import { environment } from '../environments/environment';
import { AlertService } from './services/alert.service';
import { AuthService } from './services/auth.service';
import { BriefingService } from './services/briefing.service';
import { CalendarService } from './services/calendar.service';
import { ChatService } from './services/chat.service';
import { ChatSessionService } from './services/chat-session.service';
import { ContactService } from './services/contact.service';
import { LinkedInService } from './services/linkedin.service';
import { TaskCategoryService } from './services/task-category.service';
import { TaskService } from './services/task.service';

// The app's real providers, as main.ts starts them. Nothing here reads or
// writes data: creating the SDK objects does not contact Firebase.

describe('provideFirebase', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: appConfig.providers }));

  it('connects Auth, Firestore and Remote Config to the one live project', () => {
    const app = TestBed.inject(FIREBASE_APP);
    expect(app.options.projectId).toBe(environment.firebase.projectId);
    expect(TestBed.inject(AUTH).app).toBe(app);
    expect(TestBed.inject(FIRESTORE).app).toBe(app);
    expect(TestBed.inject(REMOTE_CONFIG).app).toBe(app);
  });

  it('gives every service the Firebase objects it needs', () => {
    const services: Type<unknown>[] = [
      AlertService, AuthService, BriefingService, CalendarService, ChatService, ChatSessionService,
      ContactService, LinkedInService, TaskCategoryService, TaskService,
    ];
    for (const service of services) {
      expect(() => TestBed.inject(service)).withContext(service.name).not.toThrow();
    }
  });
});
