import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, doc,
  addDoc, updateDoc, deleteDoc, query, orderBy, where,
  serverTimestamp, getDocs, writeBatch
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Company, Contact, ContactNote } from '../models/contact.model';

/**
 * The CRM / address book. Mirrors functions/src/tools/contacts.ts, which is
 * what MAISIE and the MCP server use — keep the document shapes in step.
 */
@Injectable({ providedIn: 'root' })
export class ContactService {
  private firestore = inject(Firestore);
  private contactsRef = collection(this.firestore, 'contacts');
  private companiesRef = collection(this.firestore, 'companies');
  private notesRef = collection(this.firestore, 'contactNotes');

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

  /** Deletes the contact and its notes together, so no orphaned notes remain. */
  async deleteContact(id: string): Promise<void> {
    const notes = await getDocs(query(this.notesRef, where('contactId', '==', id)));
    const batch = writeBatch(this.firestore);
    notes.docs.forEach((n) => batch.delete(n.ref));
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
}
