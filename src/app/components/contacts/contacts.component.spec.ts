import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Firestore } from '@angular/fire/firestore';
import { ContactsComponent } from './contacts.component';
import { ContactService } from '../../services/contact.service';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, listDocuments, signInAsJack, waitFor
} from '../../../testing/emulator-testing';

// The contacts page against the Firestore emulator, signed in as Jack, with the
// real security rules. Writes go through ContactService exactly as in the app.

describe('ContactsComponent', () => {
  let emulator: EmulatorApp;
  let page: ContactsComponent;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    await TestBed.configureTestingModule({
      imports: [ContactsComponent],
      providers: [provideRouter([]), { provide: Firestore, useValue: emulator.firestore }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ContactsComponent);
    fixture.detectChanges();
    page = fixture.componentInstance;
  });

  afterEach(() => emulator.dispose());

  /** Fills in the new-contact form and saves it, as Jack would. */
  async function addContact(fields: Partial<ContactsComponent['form']>): Promise<void> {
    page.startNew();
    page.form = { ...page.form, ...fields };
    await page.saveContact();
  }

  it('adds a contact and its company, and opens the new contact', async () => {
    await addContact({ firstName: 'Brad', lastName: 'Donohue', company: 'IHRDC', emails: 'Brad@IHRDC.com; brad@ihrdc.com', tags: 'client, ihrdc' });
    await waitFor(() => page.selectedContact() !== null);

    const brad = page.selectedContact()!;
    expect(page.error()).toBeNull();
    expect(page.editing()).toBeFalse();
    expect(brad.emails).toEqual(['brad@ihrdc.com']);
    expect(brad.tags).toEqual(['client', 'ihrdc']);
    await waitFor(() => page.companyName(brad.companyId) === 'IHRDC');
  });

  it('reuses an existing company whatever its capitals', async () => {
    await addContact({ firstName: 'Brad', company: 'IHRDC' });
    await waitFor(() => page.companies().length === 1);
    await addContact({ firstName: 'Amy', company: 'ihrdc' });
    await waitFor(() => page.contacts().length === 2);

    expect((await listDocuments('companies')).length).toBe(1);
    expect(new Set(page.contacts().map((c) => c.companyId)).size).toBe(1);
  });

  it('refuses a second contact with the same email, and says who has it', async () => {
    await addContact({ firstName: 'Brad', lastName: 'Donohue', emails: 'brad@ihrdc.com' });
    await waitFor(() => page.contacts().length === 1);

    await addContact({ firstName: 'Bradley', emails: 'BRAD@ihrdc.com' });

    expect(page.error()).toContain('Brad Donohue');
    expect(page.editing()).toBeTrue();
    expect((await listDocuments('contacts')).length).toBe(1);
  });

  it('refuses a contact with no name', async () => {
    await addContact({ emails: 'someone@example.com' });
    expect(page.error()).toContain('name');
    expect((await listDocuments('contacts')).length).toBe(0);
  });

  it('searches by name, company and email', async () => {
    await addContact({ firstName: 'Brad', lastName: 'Donohue', company: 'IHRDC' });
    await addContact({ firstName: 'Tom', lastName: 'Ruth', emails: 'pastor@gracepres.org' });
    await waitFor(() => page.contacts().length === 2 && page.companies().length === 1);

    page.search.set('ihrdc');
    expect(page.filtered().map((c) => c.firstName)).toEqual(['Brad']);
    page.search.set('GRACEPRES');
    expect(page.filtered().map((c) => c.firstName)).toEqual(['Tom']);
    page.search.set('');
    expect(page.filtered().map((c) => c.firstName)).toEqual(['Brad', 'Tom']);
  });

  it('keeps notes on a contact, newest first, and deletes them with the contact', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    await addContact({ firstName: 'Brad', lastName: 'Donohue' });
    await waitFor(() => page.selectedContact() !== null);

    page.newNote = 'Prefers Teams to email.';
    await page.addNote();
    await waitFor(() => page.notes().length === 1 && page.noteDate(page.notes()[0]) !== null);
    page.newNote = 'Lunch on Friday.';
    await page.addNote();
    await waitFor(() => page.notes().length === 2 && page.notes().every((n) => page.noteDate(n) !== null));

    expect(page.newNote).toBe('');
    expect(page.notes().map((n) => n.body)).toEqual(['Lunch on Friday.', 'Prefers Teams to email.']);

    await page.deleteContact();

    expect(page.selection()).toBeNull();
    expect((await listDocuments('contacts')).length).toBe(0);
    expect((await listDocuments('contactNotes')).length).toBe(0);
  });

  it('opens a company with its people and edits its website', async () => {
    await addContact({ firstName: 'Brad', company: 'IHRDC' });
    await waitFor(() => page.companies().length === 1 && page.contacts().length === 1);

    page.selectCompany(page.companies()[0].id!);
    expect(page.companyPeople().map((c) => c.firstName)).toEqual(['Brad']);

    page.companyForm.website = 'ihrdc.com';
    await page.saveCompany();
    await waitFor(() => page.selectedCompany()?.website === 'ihrdc.com');
  });
});

describe('ContactService security', () => {
  it('a visitor who is not signed in cannot read contacts', async () => {
    await clearEmulators();
    const visitor = createEmulatorApp();
    TestBed.configureTestingModule({ providers: [{ provide: Firestore, useValue: visitor.firestore }] });
    const service = TestBed.inject(ContactService);

    const error = await new Promise<{ code?: string }>((resolve) =>
      service.getContacts().subscribe({ next: () => resolve({}), error: resolve }));

    expect(error.code).toBe('permission-denied');
    await visitor.dispose();
  });
});
