import * as admin from "firebase-admin";

// Secondary app is initialized lazily after the default app is ready,
// so that admin.credential.applicationDefault() resolves to the correct
// Firebase Admin SDK service account rather than the raw compute SA.
let _ftaFirestore: FirebaseFirestore.Firestore | null = null;

export function getFtaFirestore(): FirebaseFirestore.Firestore {
  if (!_ftaFirestore) {
    const ftaApp = admin.initializeApp(
      {
        projectId: "fta-invoice-tracking",
        credential: admin.credential.applicationDefault(),
      },
      "fta-invoice-tracking"
    );
    _ftaFirestore = admin.firestore(ftaApp);
  }
  return _ftaFirestore;
}

export interface TimeEntry {
  id: string;
  userId: string;
  customerId: string;
  projectId: string;
  date: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  description?: string;
  invoiceId?: string;
  status: "unbilled" | "billed" | "paid";
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  timeEntryIds: string[];
  subtotal: number;
  total: number;
  status: "draft" | "sent" | "paid" | "overdue" | "cancelled";
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface Customer {
  id: string;
  customerId: string;
  companyName: string;
  hourlyRate?: number;
  isActive: boolean;
}

/** Get unbilled time entries for a given customer */
export async function getUnbilledEntries(
  customerId?: string
): Promise<TimeEntry[]> {
  let query: FirebaseFirestore.Query = getFtaFirestore()
    .collection("timeEntries")
    .where("status", "==", "unbilled");

  if (customerId) {
    query = query.where("customerId", "==", customerId);
  }

  const snapshot = await query.orderBy("date", "desc").get();
  return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()} as TimeEntry));
}

/** Get the most recent invoice for a customer */
export async function getLastInvoice(
  customerId?: string
): Promise<Invoice | null> {
  let query: FirebaseFirestore.Query = getFtaFirestore()
    .collection("invoices")
    .orderBy("issueDate", "desc")
    .limit(1);

  if (customerId) {
    query = query.where("customerId", "==", customerId);
  }

  const snapshot = await query.get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return {id: doc.id, ...doc.data()} as Invoice;
}

/** Get all active customers */
export async function getCustomers(): Promise<Customer[]> {
  const snapshot = await getFtaFirestore()
    .collection("customers")
    .where("isActive", "==", true)
    .get();
  return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()} as Customer));
}

/** Get invoices with optional filters */
export async function getInvoices(options?: {
  customerId?: string;
  status?: "draft" | "sent" | "paid" | "overdue" | "cancelled" | "unpaid";
  limit?: number;
}): Promise<Invoice[]> {
  let query: FirebaseFirestore.Query = getFtaFirestore()
    .collection("invoices")
    .orderBy("issueDate", "desc");

  if (options?.customerId) {
    query = query.where("customerId", "==", options.customerId);
  }

  // "unpaid" is synthetic (sent + overdue) — filter client-side to avoid compound index
  if (options?.status && options.status !== "unpaid") {
    query = query.where("status", "==", options.status);
  }

  const snapshot = await query.limit(options?.limit ?? 20).get();
  let results = snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()} as Invoice));

  if (options?.status === "unpaid") {
    results = results.filter((inv) => inv.status === "sent" || inv.status === "overdue");
  }

  return results;
}

/** Get time entries for a date range */
export async function getTimeEntriesForRange(
  startDate: string,
  endDate: string,
  customerId?: string
): Promise<TimeEntry[]> {
  let query: FirebaseFirestore.Query = getFtaFirestore()
    .collection("timeEntries")
    .where("date", ">=", startDate)
    .where("date", "<=", endDate);

  if (customerId) {
    query = query.where("customerId", "==", customerId);
  }

  const snapshot = await query.orderBy("date", "desc").get();
  return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()} as TimeEntry));
}
