// The collections agent: gathers objective facts (contract + live PayPal invoice state),
// asks the LLM for a situation analysis and an escalation plan, and executes actions
// only after the user approves them (human-in-the-loop).
import { chatJSON } from "./ai";
import { createInvoice, getInvoice, invoicePayUrl, remindInvoice, sendInvoice } from "./paypal";
import type { ContractAnalysis, Milestone } from "./contract";
import { logActivity, updateContract } from "./store";
import type { StoredContract } from "./store";

export interface PlannedAction {
  id: string;
  type: "send_payment_reminder" | "apply_late_fee" | "compile_dispute_pack" | "escalate" | "no_action";
  milestone_id?: string;
  severity: "info" | "firm" | "final";
  amount?: number; // for late fees
  rationale: string; // must cite contract clauses
  email_draft?: { subject: string; body: string };
}

export interface AgentPlan {
  situation_summary: string;
  overdue_milestones: Array<{
    milestone_id: string;
    days_overdue: number;
    amount: number;
    clause_refs: string[];
  }>;
  actions: PlannedAction[];
}

export interface MilestoneFact {
  milestone_id: string;
  name: string;
  amount: number;
  currency: string;
  due_date: string | null;
  due_rule: string | null;
  clause_ref: string | null;
  invoice_status: string;
  hostedUrl: string | null;
  days_overdue: number | null;
}

/** Objective facts computed server-side; the LLM never invents these. */
export async function buildFacts(contract: StoredContract): Promise<MilestoneFact[]> {
  const today = Date.now();
  const facts: MilestoneFact[] = [];
  for (const m of contract.analysis.milestones) {
    const inv = contract.invoices[m.id];
    let paypalStatus = inv?.status ?? "no_invoice_yet";
    if (inv?.invoiceId) {
      try {
        paypalStatus = (await getInvoice(inv.invoiceId)).status ?? paypalStatus;
      } catch {
        // sandbox hiccup: keep last known status
      }
    }
    let daysOverdue: number | null = null;
    const isPaid = paypalStatus === "PAID" || paypalStatus === "MARKED_AS_PAID";
    if (m.due_date && !isPaid) {
      const due = new Date(`${m.due_date}T23:59:59Z`).getTime();
      if (due < today) daysOverdue = Math.floor((today - due) / 86_400_000);
    }
    facts.push({
      milestone_id: m.id,
      name: m.name,
      amount: m.amount,
      currency: m.currency ?? contract.analysis.currency,
      due_date: m.due_date ?? null,
      due_rule: m.due_rule ?? null,
      clause_ref: m.clause_ref ?? null,
      invoice_status: paypalStatus,
      hostedUrl: inv?.hostedUrl ?? null,
      days_overdue: daysOverdue,
    });
  }
  return facts;
}

const PLAN_SYSTEM = `You are the collections agent of Contract2Pay. You receive JSON facts:
contract clauses + live PayPal invoice status per milestone, with days_overdue computed
server-side (never recompute or invent them). Produce a situation analysis and an
escalation plan for the human owner to approve.

Escalation ladder by days_overdue (skip milestones already paid or without an invoice):
- 1-14 days: ONE "send_payment_reminder", severity "info", friendly professional email.
- 15-45 days: "send_payment_reminder" severity "firm" + "apply_late_fee" (amount from
  late_payment_clause.interest_or_fee applied to the overdue principal for elapsed
  months; show the math in rationale; omit if the contract has no late-fee clause).
- 46+ days: "send_payment_reminder" severity "final" + "compile_dispute_pack" preparing
  for the contract's dispute-resolution clause.

Rules:
- rationale must cite clause refs from the contract clauses given to you.
- Reminder emails reference the PayPal hostedUrl payment link when present, keep a
  courteous tone even at severity "final", and never threaten anything not in the
  contract (only cite its actual dispute/termination clauses).
- Also list overdue milestones (id, days_overdue, amount, clause_refs) in
  overdue_milestones. Actions need stable ids a1, a2, ...

Return EXACTLY this JSON shape — same keys, no extras:
{
  "situation_summary": "2-4 sentences",
  "overdue_milestones": [{"milestone_id": "m1-deposit", "days_overdue": 30, "amount": 2000, "clause_refs": ["2.1"]}],
  "actions": [{"id": "a1", "type": "send_payment_reminder", "milestone_id": "m1-deposit", "severity": "firm", "amount": null, "rationale": "cites clauses", "email_draft": {"subject": "…", "body": "…"}}]
}`;

export async function proposePlan(
  analysis: ContractAnalysis,
  facts: MilestoneFact[],
): Promise<AgentPlan> {
  const context = JSON.stringify(
    {
      contract_title: analysis.contract_title,
      currency: analysis.currency,
      late_payment_clause: analysis.late_payment_clause ?? null,
      dispute_resolution_clause: analysis.dispute_resolution_clause ?? null,
      termination_clause: analysis.termination_clause ?? null,
      milestones: facts,
    },
    null,
    1,
  );
  return chatJSON<AgentPlan>(PLAN_SYSTEM, `Facts:\n${context}`);
}

function clientParty(analysis: ContractAnalysis) {
  const p =
    analysis.parties.find((x) => /client|customer|buyer|company/i.test(x.role)) ??
    analysis.parties[1] ??
    analysis.parties[0];
  return { name: p.name, email: p.email ?? "client@example.com" };
}

function milestone(contract: StoredContract, id?: string): Milestone {
  const m = contract.analysis.milestones.find((x) => x.id === id);
  if (!m) throw new Error(`milestone ${id} not found`);
  return m;
}

export async function executeAction(
  contract: StoredContract,
  action: PlannedAction,
): Promise<{ ok: boolean; summary: string; detail?: unknown }> {
  const client = clientParty(contract.analysis);
  const currency = contract.analysis.currency;

  switch (action.type) {
    case "send_payment_reminder": {
      const m = milestone(contract, action.milestone_id);
      if (!action.email_draft) throw new Error("reminder action missing email_draft");
      // Real PayPal "remind" call + the AI-drafted email recorded to the outbox.
      const inv = contract.invoices[m.id];
      let paypalReminded = false;
      if (inv?.invoiceId) {
        try {
          await remindInvoice(inv.invoiceId, action.email_draft.subject);
          paypalReminded = true;
        } catch {
          // PayPal remind is best-effort; the AI email is the primary channel.
        }
      }
      await logActivity({
        kind: "reminder.sent",
        contractId: contract.id,
        milestoneId: m.id,
        summary: `Reminder (${action.severity})${paypalReminded ? " + PayPal remind API" : ""} → ${client.name} re: ${m.name}`,
        detail: action.email_draft,
      });
      return {
        ok: true,
        summary: `Reminder (${action.severity}) sent to ${client.name}${paypalReminded ? " via PayPal remind + email draft" : ""}`,
        detail: action.email_draft,
      };
    }

    case "apply_late_fee": {
      const m = milestone(contract, action.milestone_id);
      const amount = action.amount ?? 0;
      if (amount <= 0) throw new Error("late fee amount missing");
      const created = await createInvoice({
        reference: `${contract.id}-${m.id}-latefee`,
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
        currency,
        recipientName: client.name,
        recipientEmail: client.email,
        items: [
          {
            name: `Late fee — ${m.name}`,
            quantity: "1",
            unit_amount: { currency_code: currency, value: amount.toFixed(2) },
            description: `Per ${contract.analysis.late_payment_clause?.clause_ref ?? "late-payment clause"} of ${contract.analysis.contract_title}`,
          },
        ],
        note: `Late fee on overdue milestone "${m.name}" (${m.due_date}) per contract clause ${contract.analysis.late_payment_clause?.clause_ref ?? "-"}. Rationale: ${action.rationale}`,
      });
      const invoiceId = String(created.id);
      await sendInvoice(invoiceId);
      const full = await getInvoice(invoiceId);
      const hostedUrl = invoicePayUrl(invoiceId);
      await updateContract(contract.id, (c) => {
        c.invoices[`${m.id}-latefee`] = { invoiceId, status: full.status ?? "UNPAID", hostedUrl, sentAt: new Date().toISOString(), note: "Late-fee invoice" };
      });
      await logActivity({
        kind: "late_fee",
        contractId: contract.id,
        milestoneId: m.id,
        summary: `Late-fee invoice ${invoiceId} for ${currency} ${amount.toFixed(2)} sent to ${client.name}`,
        detail: { hostedUrl },
      });
      return { ok: true, summary: `Late-fee invoice sent (${currency} ${amount.toFixed(2)})`, detail: { hostedUrl } };
    }

    case "compile_dispute_pack": {
      const m = milestone(contract, action.milestone_id);
      const pack = {
        title: `Dispute evidence pack — ${contract.analysis.contract_title} / ${m.name}`,
        generated_at: new Date().toISOString(),
        parties: contract.analysis.parties,
        claim: {
          milestone: m.name,
          amount: m.amount,
          currency,
          due_date: m.due_date ?? m.due_rule,
          clause_ref: m.clause_ref,
        },
        late_payment_clause: contract.analysis.late_payment_clause ?? null,
        dispute_resolution_clause: contract.analysis.dispute_resolution_clause ?? null,
        agent_rationale: action.rationale,
        next_step: contract.analysis.dispute_resolution_clause?.summary ?? "Good-faith negotiation, then remedies per contract.",
      };
      await logActivity({
        kind: "dispute_pack",
        contractId: contract.id,
        milestoneId: m.id,
        summary: `Dispute evidence pack compiled for ${m.name}`,
        detail: pack,
      });
      return { ok: true, summary: `Dispute pack compiled for ${m.name}`, detail: pack };
    }

    case "escalate":
    case "no_action":
    default:
      await logActivity({
        kind: "agent.executed",
        contractId: contract.id,
        milestoneId: action.milestone_id,
        summary: `Action ${action.type} recorded: ${action.rationale}`,
      });
      return { ok: true, summary: `Recorded: ${action.type}` };
  }
}
