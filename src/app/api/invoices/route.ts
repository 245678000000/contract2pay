import { NextRequest, NextResponse } from "next/server";
import { createInvoice, getInvoice, invoicePayUrl, sendInvoice } from "@/lib/paypal";
import { getContract, logActivity, updateContract } from "@/lib/store";

export const dynamic = "force-dynamic";

/** POST { contractId, milestoneId? } — creates and sends PayPal invoices for
 *  the given milestone, or every milestone that has no invoice yet. */
export async function POST(req: NextRequest) {
  try {
    const { contractId, milestoneId } = (await req.json()) as { contractId: string; milestoneId?: string };
    const contract = await getContract(contractId);
    if (!contract) return NextResponse.json({ error: "contract not found" }, { status: 404 });

    const client =
      contract.analysis.parties.find((p) => /client|customer|buyer|company/i.test(p.role)) ??
      contract.analysis.parties[1] ?? { role: "client", name: "Client", email: "client@example.com" };
    const currency = contract.analysis.currency;
    const today = new Date().toISOString().slice(0, 10);

    const targets = contract.analysis.milestones.filter(
      (m) => (milestoneId ? m.id === milestoneId : !contract.invoices[m.id]?.invoiceId),
    );
    if (targets.length === 0) return NextResponse.json({ error: "no milestones to invoice" }, { status: 400 });

    const results = [];
    for (const m of targets) {
      const dueDate = m.due_date ?? new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
      const created = await createInvoice({
        reference: `${contract.id}-${m.id}`,
        invoiceDate: today,
        dueDate,
        currency,
        recipientName: client.name,
        recipientEmail: client.email ?? "client@example.com",
        items: [
          {
            name: m.name,
            quantity: "1",
            unit_amount: { currency_code: currency, value: m.amount.toFixed(2) },
            description: m.deliverables?.slice(0, 400) || undefined,
          },
        ],
        note: `Payable per ${m.clause_ref ?? "payment schedule"} of ${contract.analysis.contract_title}.`,
      });
      const invoiceId = String(created.id);
      await sendInvoice(invoiceId);
      const full = await getInvoice(invoiceId); // sandbox reports "SENT" after send
      const status = full.status ?? "UNPAID";
      const hostedUrl = invoicePayUrl(invoiceId);
      await updateContract(contractId, (c) => {
        c.invoices[m.id] = { invoiceId, status, hostedUrl, sentAt: new Date().toISOString() };
      });
      await logActivity({
        kind: "invoice.sent",
        contractId,
        milestoneId: m.id,
        summary: `Invoice ${invoiceId} for ${currency} ${m.amount.toFixed(2)} (${m.name}) sent to ${client.name}`,
        detail: { hostedUrl },
      });
      results.push({ milestoneId: m.id, invoiceId, hostedUrl, status });
    }

    const updated = await getContract(contractId);
    return NextResponse.json({ results, contract: updated });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
