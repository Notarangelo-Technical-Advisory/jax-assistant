import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FIRESTORE } from '../../firebase';
import { ContactsComponent } from './contacts.component';
import { ContactService } from '../../services/contact.service';
import { Contact } from '../../models/contact.model';
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
      providers: [provideRouter([]), { provide: FIRESTORE, useValue: emulator.firestore }],
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

describe('ContactsComponent links', () => {
  let emulator: EmulatorApp;
  let page: ContactsComponent;
  let fixture: ComponentFixture<ContactsComponent>;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    await TestBed.configureTestingModule({
      imports: [ContactsComponent],
      providers: [provideRouter([]), { provide: FIRESTORE, useValue: emulator.firestore }],
    }).compileComponents();
    fixture = TestBed.createComponent(ContactsComponent);
    fixture.detectChanges();
    page = fixture.componentInstance;

    page.startNew();
    page.form = { ...page.form, firstName: 'Brad', lastName: 'Donohue' };
    await page.saveContact();
    await waitFor(() => page.selectedContact() !== null);
  });

  afterEach(() => emulator.dispose());

  /** Fills in the add-link form and submits it. */
  async function addLink(fields: Partial<ContactsComponent['linkForm']>): Promise<void> {
    page.linkForm = { ...page.linkForm, ...fields };
    await page.addLink();
  }

  it('adds a web page and a meeting, newest first, and clears the form', async () => {
    await addLink({ type: 'url', title: 'IHRDC website', url: 'https://ihrdc.com' });
    await addLink({ type: 'meeting', title: 'IHRDC AI demo', date: '2020-01-15', url: 'https://teams.microsoft.com/l/meetup-join/abc' });
    await waitFor(() => page.links().length === 2 && page.links().every((l) => l.createdAt));

    expect(page.linkError()).toBeNull();
    expect(page.linkForm.title).toBe('');
    // The meeting sorts by its own (past) date; the web page by when it was linked, today.
    expect(page.sortedLinks().map((l) => l.title)).toEqual(['IHRDC website', 'IHRDC AI demo']);
    expect(page.linkDate(page.sortedLinks()[1])!.getDate()).toBe(15);
  });

  it('refuses unsafe or incomplete links, and the same page twice', async () => {
    await addLink({ type: 'url', title: 'Click me', url: 'javascript:alert(1)' });
    expect(page.linkError()).toContain('http');
    await addLink({ type: 'url', title: 'Site', url: '' });
    expect(page.linkError()).toContain('web address');
    await addLink({ type: 'meeting', title: 'Lunch', url: '', date: '' });
    expect(page.linkError()).toContain('date');

    await addLink({ type: 'url', title: 'Site', url: 'https://ihrdc.com' });
    await waitFor(() => page.links().length === 1);
    await addLink({ type: 'url', title: 'Same site', url: 'https://ihrdc.com' });
    expect(page.linkError()).toContain('already linked');
    expect((await listDocuments('contactLinks')).length).toBe(1);
  });

  it('opens an email in Apple Mail, and never opens a stored unsafe url', () => {
    const base = { contactId: 'x', companyId: null, date: null, detail: null, note: null };
    const email = page.linkHref({ ...base, type: 'email', title: 'Agenda', sourceId: 'CAF7x9=abc@mail.ihrdc.com', url: null });
    expect(String((email as { changingThisBreaksApplicationSecurity: string }).changingThisBreaksApplicationSecurity))
      .toBe('message://%3CCAF7x9%3Dabc%40mail.ihrdc.com%3E');

    expect(page.linkHref({ ...base, type: 'url', title: 'Bad', sourceId: null, url: 'javascript:alert(1)' })).toBeNull();
    expect(page.linkHref({ ...base, type: 'url', title: 'Good', sourceId: null, url: 'https://ihrdc.com' })).toBe('https://ihrdc.com');
  });

  it('removes a link, and deleting the contact removes the rest', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    await addLink({ type: 'url', title: 'One', url: 'https://one.example.com' });
    await addLink({ type: 'url', title: 'Two', url: 'https://two.example.com' });
    await waitFor(() => page.links().length === 2);

    await page.deleteLink(page.links().find((l) => l.title === 'One')!);
    await waitFor(() => page.links().length === 1);

    await page.deleteContact();
    expect((await listDocuments('contactLinks')).length).toBe(0);
  });

  it('marks an automatic link, and removing it records that it should not come back', async () => {
    const confirm = spyOn(window, 'confirm').and.returnValue(true);
    // As the Mac job writes it (functions/src/tools/contact-autolink.ts).
    await TestBed.inject(ContactService).addLink({
      contactId: page.selectedContact()!.id!, companyId: null, type: 'email', title: 'Friday demo agenda',
      sourceId: 'abc@ihrdc.com', url: null, date: '2020-03-06T14:05:00.000Z', detail: 'Brad Donohue', note: null, origin: 'auto',
    });
    await waitFor(() => page.links().length === 1);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.link-meta').textContent).toContain('linked automatically');

    const link = page.links()[0];
    await page.deleteLink(link);
    await waitFor(() => page.links().length === 0);

    expect(confirm.calls.mostRecent().args[0]).toContain('will not be linked automatically again');
    expect((await listDocuments('contactLinkDismissals')).map((d) => d['id'])).toEqual([link.id]);
  });

  it('removing a link added by hand records nothing', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    await addLink({ type: 'url', title: 'Site', url: 'https://ihrdc.com' });
    await waitFor(() => page.links().length === 1);

    await page.deleteLink(page.links()[0]);
    await waitFor(() => page.links().length === 0);
    expect((await listDocuments('contactLinkDismissals')).length).toBe(0);
  });
});

describe('ContactsComponent with iCloud contacts', () => {
  let emulator: EmulatorApp;
  let page: ContactsComponent;
  let fixture: ComponentFixture<ContactsComponent>;
  let service: ContactService;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    await TestBed.configureTestingModule({
      imports: [ContactsComponent],
      providers: [provideRouter([]), { provide: FIRESTORE, useValue: emulator.firestore }],
    }).compileComponents();
    fixture = TestBed.createComponent(ContactsComponent);
    fixture.detectChanges();
    page = fixture.componentInstance;
    service = TestBed.inject(ContactService);
  });

  afterEach(() => emulator.dispose());

  /** Adds a contact as the import writes it, and opens it. */
  async function open(fields: Partial<Contact>): Promise<Contact> {
    const id = await service.addContact({
      firstName: 'Brad', lastName: 'Donohue', emails: ['brad@ihrdc.com'], phones: [], title: 'President & CEO',
      companyId: null, tags: [], ...fields,
    });
    await waitFor(() => page.contacts().some((c) => c.id === id));
    const c = page.contacts().find((x) => x.id === id)!;
    page.selectContact(c);
    fixture.detectChanges();
    return c;
  }

  const text = (): string => fixture.nativeElement.textContent;

  it('shows iCloud details read-only, saves only the tags, and sends deleting to iCloud', async () => {
    const brad = await open({ appleContactId: 'A-BRAD' });
    expect(text()).toContain('From iCloud');
    expect(text()).toContain('Delete it in iCloud');
    expect(fixture.nativeElement.querySelector('.btn-danger')).toBeNull();

    page.startEdit();
    // ngModel disables its input a tick later. Wait for that rather than for the
    // zone to settle: the open Firestore connection keeps it busy.
    await waitFor(() => {
      fixture.detectChanges();
      return fixture.nativeElement.querySelector('input:disabled') !== null;
    });
    expect(page.iCloudLocked()).toBeTrue();
    expect(text()).toContain('come from iCloud');

    page.form = { ...page.form, title: 'CEO', tags: 'client' };
    await page.saveContact();
    await waitFor(() => (page.selectedContact()?.tags ?? []).length === 1);
    expect(page.selectedContact()!.title).toBe('President & CEO');

    const confirm = spyOn(window, 'confirm').and.returnValue(true);
    await page.deleteContact();
    expect(confirm).not.toHaveBeenCalled();
    expect((await listDocuments('contacts')).map((d) => d['id'])).toEqual([brad.id]);
  });

  it('a contact no longer in iCloud says so, and can be edited and deleted here', async () => {
    // Stored as a Firestore timestamp, as the import writes it.
    await open({ appleContactId: null, leftICloudAt: new Date('2020-03-06') as never });
    expect(text()).toContain('No longer in iCloud');

    page.startEdit();
    expect(page.iCloudLocked()).toBeFalse();
    page.form = { ...page.form, title: 'Chair' };
    await page.saveContact();
    await waitFor(() => page.selectedContact()?.title === 'Chair');

    spyOn(window, 'confirm').and.returnValue(true);
    await page.deleteContact();
    expect((await listDocuments('contacts')).length).toBe(0);
  });
});

describe('ContactService security', () => {
  it('a visitor who is not signed in cannot read contacts', async () => {
    await clearEmulators();
    const visitor = createEmulatorApp();
    TestBed.configureTestingModule({ providers: [{ provide: FIRESTORE, useValue: visitor.firestore }] });
    const service = TestBed.inject(ContactService);

    const error = await new Promise<{ code?: string }>((resolve) =>
      service.getContacts().subscribe({ next: () => resolve({}), error: resolve }));

    expect(error.code).toBe('permission-denied');
    await visitor.dispose();
  });
});
