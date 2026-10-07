import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { ContactService } from '../../services/contact.service';
import { Company, Contact, ContactLink, ContactNote } from '../../models/contact.model';

/** The editable form. Lists are edited as comma-separated text. */
interface ContactForm {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  emails: string;
  phones: string;
  tags: string;
}

const emptyForm = (): ContactForm => ({
  firstName: '', lastName: '', title: '', company: '', emails: '', phones: '', tags: '',
});

/** True for an absolute http or https URL — the only links the page will open. */
export function isWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The date a link sorts by: the item's own date, else when it was linked. */
const linkSortKey = (l: ContactLink): string =>
  l.date ?? (l.createdAt?.toDate ? l.createdAt.toDate().toISOString() : '');

const splitList = (s: string): string[] =>
  [...new Set(s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))];

type Selection =
  | { kind: 'contact'; id: string }
  | { kind: 'company'; id: string }
  | { kind: 'new' }
  | null;

@Component({
  selector: 'app-contacts',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './contacts.component.html',
  styleUrl: './contacts.component.scss',
})
export class ContactsComponent implements OnDestroy {
  private contactService = inject(ContactService);
  private sanitizer = inject(DomSanitizer);
  private subs = new Subscription();
  /** Notes and links of whichever contact or company is open. */
  private recordSub: Subscription | null = null;

  contacts = signal<Contact[]>([]);
  companies = signal<Company[]>([]);
  notes = signal<ContactNote[]>([]);
  links = signal<ContactLink[]>([]);
  search = signal('');
  selection = signal<Selection>(null);
  editing = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);

  form: ContactForm = emptyForm();
  companyForm = { name: '', website: '', tags: '' };
  newNote = '';
  linkForm = { type: 'url' as 'url' | 'meeting', title: '', url: '', date: '', note: '' };
  linkError = signal<string | null>(null);

  sortedLinks = computed(() =>
    [...this.links()].sort((a, b) => linkSortKey(b).localeCompare(linkSortKey(a))));

  private companyById = computed(() => new Map(this.companies().map((c) => [c.id!, c])));

  companyName(id: string | null): string {
    return id ? this.companyById().get(id)?.name ?? '' : '';
  }

  /** True when iCloud owns this contact's details (see Contact.appleContactId). */
  fromICloud(c: Contact | null): boolean {
    return !!c?.appleContactId;
  }

  /** The contact being edited comes from iCloud, so only its tags can change. */
  iCloudLocked = computed(() => this.editing() && this.fromICloud(this.selectedContact()));

  fullName(c: Contact): string {
    return `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '(no name)';
  }

  filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.contacts()
      .filter((c) => {
        if (!q) return true;
        const hay = [this.fullName(c), c.title ?? '', this.companyName(c.companyId),
          ...(c.emails ?? []), ...(c.phones ?? []), ...(c.tags ?? [])].join(' ').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => this.fullName(a).localeCompare(this.fullName(b)));
  });

  selectedContact = computed(() => {
    const s = this.selection();
    return s?.kind === 'contact' ? this.contacts().find((c) => c.id === s.id) ?? null : null;
  });

  selectedCompany = computed(() => {
    const s = this.selection();
    return s?.kind === 'company' ? this.companyById().get(s.id) ?? null : null;
  });

  companyPeople = computed(() => {
    const co = this.selectedCompany();
    return co ? this.contacts().filter((c) => c.companyId === co.id) : [];
  });

  constructor() {
    this.subs.add(this.contactService.getContacts().subscribe((c) => this.contacts.set(c)));
    this.subs.add(this.contactService.getCompanies().subscribe((c) => this.companies.set(c)));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.recordSub?.unsubscribe();
  }

  private watchRecord(field: 'contactId' | 'companyId', id: string): void {
    this.clearRecord();
    this.recordSub = new Subscription();
    this.recordSub.add(this.contactService.getNotes(field, id).subscribe((n) => this.notes.set(n)));
    this.recordSub.add(this.contactService.getLinks(field, id).subscribe((l) => this.links.set(l)));
  }

  private clearRecord(): void {
    this.recordSub?.unsubscribe();
    this.recordSub = null;
    this.notes.set([]);
    this.links.set([]);
    this.linkError.set(null);
  }

  selectContact(c: Contact): void {
    this.selection.set({ kind: 'contact', id: c.id! });
    this.editing.set(false);
    this.error.set(null);
    this.watchRecord('contactId', c.id!);
  }

  selectCompany(id: string | null): void {
    if (!id) return;
    const co = this.companyById().get(id);
    this.selection.set({ kind: 'company', id });
    this.companyForm = { name: co?.name ?? '', website: co?.website ?? '', tags: (co?.tags ?? []).join(', ') };
    this.editing.set(false);
    this.error.set(null);
    this.watchRecord('companyId', id);
  }

  startNew(): void {
    this.clearRecord();
    this.form = emptyForm();
    this.selection.set({ kind: 'new' });
    this.editing.set(true);
    this.error.set(null);
  }

  startEdit(): void {
    const c = this.selectedContact();
    if (!c) return;
    this.form = {
      firstName: c.firstName ?? '',
      lastName: c.lastName ?? '',
      title: c.title ?? '',
      company: this.companyName(c.companyId),
      emails: (c.emails ?? []).join(', '),
      phones: (c.phones ?? []).join(', '),
      tags: (c.tags ?? []).join(', '),
    };
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.error.set(null);
    if (this.selection()?.kind === 'new') this.selection.set(null);
  }

  async saveContact(): Promise<void> {
    const f = this.form;
    if (this.iCloudLocked()) {
      const c = this.selectedContact()!;
      this.saving.set(true);
      try {
        await this.contactService.updateContact(c.id!, { tags: splitList(f.tags) });
        this.editing.set(false);
      } finally {
        this.saving.set(false);
      }
      return;
    }
    if (!f.firstName.trim() && !f.lastName.trim()) {
      this.error.set('Enter at least a first or last name.');
      return;
    }
    // Lower-case before removing repeats, as the server does, so
    // "Brad@IHRDC.com, brad@ihrdc.com" is stored once.
    const emails = splitList(f.emails.toLowerCase());
    const sel = this.selection();
    const editingId = sel?.kind === 'contact' ? sel.id : null;

    // Same rule the server enforces: one person per email address.
    const clash = this.contacts().find((c) =>
      c.id !== editingId && (c.emails ?? []).some((e) => emails.includes(e)));
    if (clash) {
      this.error.set(`${this.fullName(clash)} already has that email address.`);
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    try {
      const fields: Omit<Contact, 'id'> = {
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        title: f.title.trim() || null,
        companyId: await this.contactService.resolveCompany(f.company, this.companies()),
        emails,
        phones: splitList(f.phones),
        tags: splitList(f.tags),
      };
      if (editingId) {
        await this.contactService.updateContact(editingId, fields);
        this.editing.set(false);
      } else {
        const id = await this.contactService.addContact(fields);
        this.editing.set(false);
        this.selection.set({ kind: 'contact', id });
        this.watchRecord('contactId', id);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  async saveCompany(): Promise<void> {
    const co = this.selectedCompany();
    if (!co?.id || !this.companyForm.name.trim()) return;
    this.saving.set(true);
    try {
      await this.contactService.updateCompany(co.id, {
        name: this.companyForm.name.trim(),
        website: this.companyForm.website.trim() || null,
        tags: splitList(this.companyForm.tags),
      });
      this.editing.set(false);
    } finally {
      this.saving.set(false);
    }
  }

  async deleteContact(): Promise<void> {
    const c = this.selectedContact();
    // The next morning's import would bring it back; it is deleted in iCloud instead.
    if (!c?.id || this.fromICloud(c)) return;
    if (!confirm(`Delete ${this.fullName(c)} and all of their notes? This cannot be undone.`)) return;
    await this.contactService.deleteContact(c.id);
    this.selection.set(null);
  }

  async addNote(): Promise<void> {
    const body = this.newNote.trim();
    const sel = this.selection();
    if (!body || !sel || sel.kind === 'new') return;
    await this.contactService.addNote(
      sel.kind === 'contact' ? { contactId: sel.id } : { companyId: sel.id },
      body,
    );
    this.newNote = '';
  }

  async deleteNote(note: ContactNote): Promise<void> {
    if (!note.id || !confirm('Delete this note?')) return;
    await this.contactService.deleteNote(note.id);
  }

  noteDate(note: ContactNote): Date | null {
    return note.createdAt?.toDate ? note.createdAt.toDate() : null;
  }

  /** Adds a web page or meeting by hand. Emails need a Message-ID, so MAISIE adds those. */
  async addLink(): Promise<void> {
    const sel = this.selection();
    if (!sel || sel.kind === 'new') return;
    const f = this.linkForm;
    const title = f.title.trim();
    const url = f.url.trim() || null;
    const date = f.date.trim() || null;

    if (!title) return this.linkError.set('Enter a title.');
    if (url && !isWebUrl(url)) return this.linkError.set('The link must start with http:// or https://.');
    if (f.type === 'url' && !url) return this.linkError.set('Enter the web address.');
    if (f.type === 'meeting' && !date) return this.linkError.set('Enter the meeting date.');
    // Same rule as the server's linkKey: one link per page, one per meeting per day.
    const clash = this.links().find((l) => f.type === 'url'
      ? l.type === 'url' && l.url === url
      : l.type === 'meeting' && l.title.toLowerCase() === title.toLowerCase() && (l.date ?? '').slice(0, 10) === date);
    if (clash) return this.linkError.set(`"${clash.title}" is already linked.`);

    this.linkError.set(null);
    await this.contactService.addLink({
      contactId: sel.kind === 'contact' ? sel.id : null,
      companyId: sel.kind === 'company' ? sel.id : null,
      type: f.type,
      title,
      sourceId: null,
      url,
      date,
      detail: null,
      note: f.note.trim() || null,
    });
    this.linkForm = { type: f.type, title: '', url: '', date: '', note: '' };
  }

  async deleteLink(link: ContactLink): Promise<void> {
    const again = link.origin === 'auto' ? ' It will not be linked automatically again.' : '';
    if (!link.id || !confirm(`Remove the link to "${link.title}"? The item itself is not affected.${again}`)) return;
    await this.contactService.deleteLink({ ...link, id: link.id });
  }

  /**
   * Where a link opens. Emails open in Apple Mail through its message:// scheme,
   * which Angular's sanitizer would otherwise block; the id is URL-encoded, so
   * nothing in it can change the scheme. Anything else opens only if it is http(s).
   */
  linkHref(link: ContactLink): SafeUrl | string | null {
    if (link.type === 'email' && link.sourceId) {
      return this.sanitizer.bypassSecurityTrustUrl(`message://%3C${encodeURIComponent(link.sourceId)}%3E`);
    }
    return link.url && isWebUrl(link.url) ? link.url : null;
  }

  /** A YYYY-MM-DD date is a calendar day, so it must not be shifted by time zone. */
  linkDate(link: ContactLink): Date | null {
    if (!link.date) return null;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(link.date);
    return new Date(day ? `${link.date}T12:00:00` : link.date);
  }
}
