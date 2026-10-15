// Minimal PayPal REST client (no SDK): OAuth + Invoicing v2 + Orders v2 + webhook verify.
// Docs: https://developer.paypal.com/api/rest/

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const { PAYPAL_CLIENT_ID: ID = "", PAYPAL_CLIENT_SECRET: SECRET = "" } = process.env;

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`PayPal ${path} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T; // e.g. remind/send succeed with no body
  const text = await res.text();
  return (text ? JSON.parse(text) : (undefined as T)) as T;
}

// ---------- Invoicing v2 ----------

export interface InvoiceItem {
  name: string;
  quantity: string;
  unit_amount: { currency_code: string; value: string };
  description?: string;
}

export interface CreateInvoiceInput {
  reference: string; // e.g. contract id + milestone id
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  currency: string;
  recipientName: string;
  recipientEmail: string;
  items: InvoiceItem[];
  note?: string; // e.g. "Payable per clause 3.2 of contract dated ..."
}

export async function createInvoice(input: CreateInvoiceInput) {
  // NOTE: the create response has no "id" field — PayPal returns {rel, href, method};
  // the invoice id is the last path segment of the href.
  const res = await api<{ rel?: string; href?: string }>("/v2/invoicing/invoices", {
    method: "POST",
    body: JSON.stringify({
      detail: {
        reference: input.reference,
        invoice_date: input.invoiceDate,
        currency_code: input.currency,
        payment_term: { due_date: input.dueDate },
      },
      // NOTE: no "invoicer" block — sandbox requires a registered merchant email there,
      // so we let PayPal default to the REST app's owning account.
      primary_recipients: [
        {
          billing_info: {
            name: { given_name: "", surname: input.recipientName },
            email_address: input.recipientEmail,
          },
        },
      ],
      items: input.items,
      note: input.note,
    }),
  });
  const id = res.href?.split("/").pop();
  if (!id) throw new Error(`PayPal createInvoice returned no href: ${JSON.stringify(res)}`);
  return { id, href: res.href };
}

// Must be called before an invoice is payable; status becomes SENT/UNPAID.
export async function sendInvoice(invoiceId: string) {
  return api<Record<string, unknown>>(`/v2/invoicing/invoices/${invoiceId}/send`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// The payer-facing hosted invoice page (not exposed as a link rel by the API).
export function invoicePayUrl(invoiceId: string) {
  return process.env.PAYPAL_ENV === "live"
    ? `https://www.paypal.com/invoice/p/${invoiceId}`
    : `https://www.sandbox.paypal.com/invoice/p/${invoiceId}`;
}

// PayPal's own "remind the recipient" action — the agent layers AI-drafted email on top.
export async function remindInvoice(invoiceId: string, note?: string) {
  return api<Record<string, unknown>>(`/v2/invoicing/invoices/${invoiceId}/remind`, {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
}

export async function getInvoice(invoiceId: string) {
  return api<{ id: string; status: string; detail?: { total_amount?: { value: string; currency_code: string } } }>(
    `/v2/invoicing/invoices/${invoiceId}`,
  );
}

export async function listInvoices(pageSize = 20) {
  return api<{ items?: Array<{ id: string; status: string; detail?: { reference?: string } }> }>(
    `/v2/invoicing/invoices?page_size=${pageSize}&total_required=true`,
  );
}

// ---------- Orders v2 (direct checkout, e.g. milestone deposit) ----------

export async function createOrder(value: string, currency = "USD") {
  return api<{ id: string; links: Array<{ rel: string; href: string }> }>("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: currency, value } }],
    }),
  });
}

export async function captureOrder(orderId: string) {
  return api<Record<string, unknown>>(`/v2/checkout/orders/${orderId}/capture`, { method: "POST" });
}

// ---------- Refunds ----------

export async function refundCapture(captureId: string, value: string, currency = "USD") {
  return api<Record<string, unknown>>(`/v2/payments/captures/${captureId}/refund`, {
    method: "POST",
    body: JSON.stringify({ amount: { value, currency_code: currency } }),
  });
}

// ---------- Webhooks ----------

export async function verifyWebhookSignature(headers: Headers, rawBody: string) {
  return api<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(rawBody),
    }),
  });
}
