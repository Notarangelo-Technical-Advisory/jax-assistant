import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ContactService } from '../../services/contact.service';
import { Company, Contact, ContactNote } from '../../models/contact.model';

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
  private subs = new Subscription();
  private notesSub: Subscription | null = null;

  contacts = signal<Contact[]>([]);
  companies = signal<Company[]>([]);
  notes = signal<ContactNote[]>([]);
  search = signal('');
  selection = signal<Selection>(null);
  editing = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);

  form: ContactForm = emptyForm();
  companyForm = { name: '', website: '', tags: '' };
  newNote = '';

  private companyById = computed(() => new Map(this.companies().map((c) => [c.id!, c])));

  companyName(id: string | null): string {
    return id ? this.companyById().get(id)?.name ?? '' : '';
  }

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
    this.notesSub?.unsubscribe();
  }

  private watchNotes(field: 'contactId' | 'companyId', id: string): void {
    this.notesSub?.unsubscribe();
    this.notes.set([]);
    this.notesSub = this.contactService.getNotes(field, id).subscribe((n) => this.notes.set(n));
  }

  selectContact(c: Contact): void {
    this.selection.set({ kind: 'contact', id: c.id! });
    this.editing.set(false);
    this.error.set(null);
    this.watchNotes('contactId', c.id!);
  }

  selectCompany(id: string | null): void {
    if (!id) return;
    const co = this.companyById().get(id);
    this.selection.set({ kind: 'company', id });
    this.companyForm = { name: co?.name ?? '', website: co?.website ?? '', tags: (co?.tags ?? []).join(', ') };
    this.editing.set(false);
    this.error.set(null);
    this.watchNotes('companyId', id);
  }

  startNew(): void {
    this.notesSub?.unsubscribe();
    this.notes.set([]);
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
    if (!f.firstName.trim() && !f.lastName.trim()) {
      this.error.set('Enter at least a first or last name.');
      return;
    }
    const emails = splitList(f.emails).map((e) => e.toLowerCase());
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
        this.watchNotes('contactId', id);
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
    if (!c?.id) return;
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
}
