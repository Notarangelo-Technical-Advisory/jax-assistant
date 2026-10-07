import { Injectable, inject } from '@angular/core';
import {
  collection, doc,
  addDoc, updateDoc, deleteDoc, query, orderBy, where,
  serverTimestamp, getDocs, writeBatch
} from 'firebase/firestore';
import { collectionData } from 'rxfire/firestore';
import { Observable } from 'rxjs';
import { Company, Contact, ContactLink, ContactNote } from '../models/contact.model';
import { FIRESTORE } from '../firebase';

/**
 * The CRM / address book. Mirrors functions/src/tools/contacts.ts, which is
 * what MAISIE and the MCP server use — keep the document shapes in step.
 */
@Injectable({ providedIn: 'root' })
export class ContactService {
  private firestore = inject(FIRESTORE);
  private contactsRef = collection(this.firestore, 'contacts');
  private companiesRef = collection(this.firestore, 'companies');
  private notesRef = collection(this.firestore, 'contactNotes');
  private linksRef = collection(this.firestore, 'contactLinks');

  getContacts(): Observable<Contact[]> {
    return collectionData(this.contactsRef, { idField: 'id' }) as Observable<Contact[]>;
  }

  getCompanies(): Observable<Company[]> {
    return collectionData(this.companiesRef, { idField: 'id' }) as Observable<Company[]>;
  }

  getNotes(field: 'contactId' | 'companyId', id: string): Observable<ContactNote[]> {
    const q = query(this.notesRef, where(field, '==', id), orderBy('createdAt', 'desc'));
    return collectionData(q, { idField: 'id' }) as Observable<ContactNote[]>;
  }

  /** Unordered: the page sorts by each item's own date, which may be missing. */
  getLinks(field: 'contactId' | 'companyId', id: string): Observable<ContactLink[]> {
    return collectionData(query(this.linksRef, where(field, '==', id)), { idField: 'id' }) as Observable<ContactLink[]>;
  }

  /**
   * Find a company by name (case-insensitive) or create it. Same rule as the
   * server's resolveCompany, so the web page and MAISIE never fork a company.
   */
  async resolveCompany(name: string, known: Company[]): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const match = known.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (match?.id) return match.id;
    const ref = await addDoc(this.companiesRef, {
      name: trimmed,
      website: null,
      tags: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  }

  async addContact(contact: Omit<Contact, 'id'>): Promise<string> {
    const ref = await addDoc(this.contactsRef, {
      ...contact,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  }

  async updateContact(id: string, fields: Partial<Contact>): Promise<void> {
    await updateDoc(doc(this.firestore, 'contacts', id), { ...fields, updatedAt: serverTimestamp() });
  }

  async updateCompany(id: string, fields: Partial<Company>): Promise<void> {
    await updateDoc(doc(this.firestore, 'companies', id), { ...fields, updatedAt: serverTimestamp() });
  }

  /** Deletes the contact with its notes and links, so nothing is left orphaned. */
  async deleteContact(id: string): Promise<void> {
    const [notes, links] = await Promise.all([
      getDocs(query(this.notesRef, where('contactId', '==', id))),
      getDocs(query(this.linksRef, where('contactId', '==', id))),
    ]);
    const batch = writeBatch(this.firestore);
    [...notes.docs, ...links.docs].forEach((d) => batch.delete(d.ref));
    batch.delete(doc(this.firestore, 'contacts', id));
    await batch.commit();
  }

  async addNote(target: { contactId?: string; companyId?: string }, body: string): Promise<void> {
    await addDoc(this.notesRef, {
      contactId: target.contactId ?? null,
      companyId: target.companyId ?? null,
      body: body.trim(),
      createdAt: serverTimestamp(),
    });
  }

  async deleteNote(id: string): Promise<void> {
    await deleteDoc(doc(this.firestore, 'contactNotes', id));
  }

  async addLink(link: Omit<ContactLink, 'id' | 'createdAt'>): Promise<void> {
    await addDoc(this.linksRef, { ...link, createdAt: serverTimestamp() });
  }

  /**
   * Removes a link. An automatic one is also recorded in contactLinkDismissals,
   * under the same id, so automatic linking does not put it back.
   */
  async deleteLink(link: ContactLink & { id: string }): Promise<void> {
    const ref = doc(this.firestore, 'contactLinks', link.id);
    if (link.origin !== 'auto') return deleteDoc(ref);
    const batch = writeBatch(this.firestore);
    batch.delete(ref);
    batch.set(doc(this.firestore, 'contactLinkDismissals', link.id), {
      contactId: link.contactId,
      title: link.title,
      removedAt: serverTimestamp(),
    });
    await batch.commit();
  }
}
