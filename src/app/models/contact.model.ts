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

export type ContactLinkType = 'email' | 'meeting' | 'url';

/**
 * An email, meeting or web page tied to a contact OR a company. Self-contained:
 * it keeps its own title and date, because the calendar mirror drops past
 * events and Mail lives only on Jack's Mac. Same shape as the server's LinkDoc.
 */
export interface ContactLink {
  id?: string;
  contactId: string | null;
  companyId: string | null;
  type: ContactLinkType;
  title: string;
  /** Email: the Message-ID. Meeting: the Apple Calendar uid. */
  sourceId: string | null;
  /** http(s) only. */
  url: string | null;
  /** YYYY-MM-DD or an ISO timestamp. */
  date: string | null;
  /** Email: the sender. Meeting: the calendar name. */
  detail: string | null;
  note: string | null;
  createdAt?: { toDate(): Date } | null;
}
