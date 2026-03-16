import * as admin from "firebase-admin";

// Initialize a secondary Firebase Admin app for cross-project reads
// to fta-invoice-tracking Firestore. The jax-assistant service account
// must have roles/datastore.viewer on the fta-invoice-tracking project.
const ftaApp = admin.initializeApp(
  {projectId: "fta-invoice-tracking"},
  "fta-invoice-tracking"
);

export const ftaFirestore = admin.firestore(ftaApp);

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

/** Get unbilled time entries for a given customer */
export async function getUnbilledEntries(
  customerId?: string
): Promise<TimeEntry[]> {
  let query: FirebaseFirestore.Query = ftaFirestore
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
  let query: FirebaseFirestore.Query = ftaFirestore
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

/** Get time entries for a date range */
export async function getTimeEntriesForRange(
  startDate: string,
  endDate: string,
  customerId?: string
): Promise<TimeEntry[]> {
  let query: FirebaseFirestore.Query = ftaFirestore
    .collection("timeEntries")
    .where("date", ">=", startDate)
    .where("date", "<=", endDate);

  if (customerId) {
    query = query.where("customerId", "==", customerId);
  }

  const snapshot = await query.orderBy("date", "desc").get();
  return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()} as TimeEntry));
}
