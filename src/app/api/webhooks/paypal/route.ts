import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/paypal";
import { findByInvoiceId, getState, logActivity, updateContract } from "@/lib/store";

export const dynamic = "force-dynamic";

/** PayPal webhook receiver. In sandbox you can also fire events manually from
 *  Developer Dashboard → Webhooks → simulator, or configure this URL once deployed. */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (process.env.PAYPAL_WEBHOOK_ID) {
    try {
      const v = await verifyWebhookSignature(req.headers, raw);
      if (v.verification_status !== "SUCCESS") {
        return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
      }
    } catch (e) {
      return NextResponse.json({ error: `verify failed: ${String(e)}` }, { status: 401 });
    }
  }

  const type = event.event_type ?? "UNKNOWN";
  const resource = (event.resource ?? {}) as Record<string, unknown>;

  // PayPal has shipped several resource shapes for invoicing events over the years
  // (resource.id may be an internal id rather than the INV2 number). Fallback: if
  // the raw payload mentions one of our stored invoice numbers in ANY field, match it.
  const resolveInvoice = async () => {
    // Observed real payload shapes (2026-10 sandbox):
    //   v1: { resource: { id: "INV2-…", … } }
    //   v2: { resource: { invoice: { id: "INV2-…", … } } }
    const invoiceObj =
      typeof resource.invoice === "object" && resource.invoice !== null
        ? (resource.invoice as Record<string, unknown>)
        : resource;
    const candidate =
      typeof invoiceObj.id === "string" && type.startsWith("INVOICING.")
        ? invoiceObj.id
        : typeof resource.invoice_id === "string"
          ? (resource.invoice_id as string)
          : undefined;
    if (candidate) {
      const direct = await findByInvoiceId(candidate).catch(() => null);
      if (direct) return direct;
    }
    const rawStr = JSON.stringify(event);
    const { contracts } = await getState();
    for (const c of contracts) {
      const m = Object.keys(c.invoices).find((k) => c.invoices[k].invoiceId && rawStr.includes(c.invoices[k].invoiceId!));
      if (m) return { contract: c, milestoneId: m };
    }
    return null;
  };

  const hit = await resolveInvoice();
  let matched = false;
  if (hit) {
    const matchedId = hit.contract.invoices[hit.milestoneId].invoiceId!;
    const status =
      type === "INVOICING.INVOICE.PAID" ? "PAID"
      : type === "INVOICING.INVOICE.CANCELLED" ? "CANCELLED"
      : type === "INVOICING.INVOICE.REFUNDED" ? "REFUNDED"
      : null;
    if (status) {
      matched = true;
      await updateContract(hit.contract.id, (c) => {
        const inv = c.invoices[hit.milestoneId];
        if (inv && inv.invoiceId === matchedId) inv.status = status;
      });
      await logActivity({
        kind: status === "PAID" ? "payment.received" : "webhook",
        contractId: hit.contract.id,
        milestoneId: hit.milestoneId,
        summary: `PayPal webhook ${type} → invoice ${matchedId} is ${status}`,
      });
    }
  }

  if (!matched) {
    await logActivity({
      kind: "webhook",
      summary: `PayPal webhook received: ${type}`,
      detail: { resource, event_id: event.id ?? null }, // raw shape kept for diagnosis
    });
  }

  return NextResponse.json({ received: true });
}
