export interface Contact {
  id?: string;
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  title: string | null;
  companyId: string | null;
  tags: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Company {
  id?: string;
  name: string;
  website: string | null;
  tags: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

/** A note on a contact OR a company — exactly one of the two IDs is set. */
export interface ContactNote {
  id?: string;
  contactId: string | null;
  companyId: string | null;
  body: string;
  createdAt?: { toDate(): Date } | null;
}
