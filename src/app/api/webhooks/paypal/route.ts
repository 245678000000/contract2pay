import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/paypal";
import { findByInvoiceId, logActivity, updateContract } from "@/lib/store";

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

  const invoiceId =
    typeof resource.id === "string" && type.startsWith("INVOICING.")
      ? resource.id
      : typeof resource.invoice_id === "string"
        ? resource.invoice_id
        : undefined;

  let matched = false;
  if (invoiceId) {
    const hit = await findByInvoiceId(invoiceId).catch(() => null);
    if (hit) {
      const status =
        type === "INVOICING.INVOICE.PAID" ? "PAID"
        : type === "INVOICING.INVOICE.CANCELLED" ? "CANCELLED"
        : type === "INVOICING.INVOICE.REFUNDED" ? "REFUNDED"
        : type === "INVOICING.INVOICE.PAYMENT_FAILED" ? "PAYMENT_FAILED"
        : null;
      if (status) {
        matched = true;
        await updateContract(hit.contract.id, (c) => {
          const inv = c.invoices[hit.milestoneId];
          if (inv && inv.invoiceId === invoiceId) inv.status = status;
        });
        await logActivity({
          kind: status === "PAID" ? "payment.received" : "webhook",
          contractId: hit.contract.id,
          milestoneId: hit.milestoneId,
          summary: `PayPal webhook ${type} → invoice ${invoiceId} is ${status}`,
        });
      }
    }
  }

  if (!matched) {
    await logActivity({ kind: "webhook", summary: `PayPal webhook received: ${type}` });
  }

  return NextResponse.json({ received: true });
}
