import { chatJSON } from "./ai";

export interface Milestone {
  id: string;
  name: string;
  deliverables: string;
  amount: number;
  currency?: string;
  due_date?: string; // YYYY-MM-DD when the contract gives an absolute date
  due_rule?: string; // e.g. "NET-14 after delivery sign-off" when relative
  clause_ref?: string; // e.g. "3.2"
}

export interface ContractAnalysis {
  contract_title: string;
  currency: string;
  parties: Array<{ role: string; name: string; email?: string }>;
  milestones: Milestone[];
  late_payment_clause?: {
    exists: boolean;
    summary: string;
    clause_ref?: string;
    interest_or_fee?: string; // e.g. "1.5% per month"
  };
  dispute_resolution_clause?: { summary: string; clause_ref?: string };
  termination_clause?: { summary: string; clause_ref?: string };
  risk_notes: string[];
}

const SCHEMA = `{
  "contract_title": "short title",
  "currency": "USD",
  "parties": [{"role": "Provider|Client|…", "name": "legal/party name", "email": "email or null"}],
  "milestones": [{"id": "m1-deposit", "name": "short name", "deliverables": "what this milestone covers", "amount": 2000, "due_date": "YYYY-MM-DD or null", "due_rule": "rule string or null", "clause_ref": "2.1"}],
  "late_payment_clause": {"exists": true, "summary": "one sentence", "clause_ref": "3.1", "interest_or_fee": "1.5% per month"},
  "dispute_resolution_clause": {"summary": "one sentence", "clause_ref": "5.1"},
  "termination_clause": {"summary": "one sentence", "clause_ref": "4.1"},
  "risk_notes": ["short notes"]
}`;

const SYSTEM = `You are the contract-analysis engine of Contract2Pay, a product that turns signed
service contracts into automated billing. Extract the billing structure from contracts.
Rules:
- Today's date is {TODAY}.
- Never invent amounts, dates, or clause numbers that are not in the text.
- milestone.id: short stable slug (e.g. "m1-deposit").
- due_date in YYYY-MM-DD only when the contract states an absolute date; otherwise put the
  rule in due_rule and set due_date to null.
- Quote clause references exactly as written (e.g. "3.2", "Article 4.1").

Return EXACTLY this JSON shape — same keys, same nesting, no extra top-level keys:
${SCHEMA}`;

export async function analyzeContract(text: string): Promise<ContractAnalysis> {
  const system = SYSTEM.replace("{TODAY}", new Date().toISOString().slice(0, 10));
  const raw = await chatJSON<Record<string, unknown>>(
    system,
    `Contract text:\n\n${text}`,
  );
  return normalizeAnalysis(raw);
}

/** Tolerant mapping: LLMs occasionally rename keys or nest objects even with a
 *  fixed schema (observed with deepseek-chat). Keep the demo robust. */
function normalizeAnalysis(raw: Record<string, unknown>): ContractAnalysis {
  const root = (raw.milestones ? raw : ((raw.contract as Record<string, unknown>) ?? raw)) as Record<string, unknown>;

  const partiesRaw =
    (root.parties as Array<Record<string, unknown>>) ??
    [root.provider as Record<string, unknown>, root.client as Record<string, unknown>].filter(Boolean);
  const parties = (partiesRaw as Array<Record<string, unknown>>).map((p) => ({
    role: String(p.role ?? ""),
    name: String(p.name ?? ""),
    email: (p.email as string) || undefined,
  }));

  const milestones = ((root.milestones as Array<Record<string, unknown>>) ?? []).map((m, i) => ({
    id: String(m.id ?? `m${i + 1}`),
    name: String(m.name ?? m.description ?? `Milestone ${i + 1}`).slice(0, 80),
    deliverables: String(m.deliverables ?? m.description ?? ""),
    amount: Number(m.amount ?? 0),
    due_date: (m.due_date as string) || undefined,
    due_rule: (m.due_rule as string) || undefined,
    clause_ref: String(m.clause_ref ?? m.clause ?? "") || undefined,
  }));

  const lp = (root.late_payment_clause ?? root.late_payment) as Record<string, unknown> | undefined;
  const dr = (root.dispute_resolution_clause ?? root.dispute_resolution) as Record<string, unknown> | undefined;
  const tm = (root.termination_clause ?? root.termination) as Record<string, unknown> | undefined;

  return {
    contract_title: String(root.contract_title ?? root.title ?? (raw as { contract_title?: string }).contract_title ?? "Untitled contract"),
    currency: String(root.currency ?? "USD"),
    parties,
    milestones,
    late_payment_clause: lp
      ? {
          exists: lp.exists !== false,
          summary: String(lp.summary ?? lp.late_fee_basis ?? ""),
          clause_ref: String(lp.clause_ref ?? lp.clause ?? "") || undefined,
          interest_or_fee:
            (lp.interest_or_fee as string) ??
            (lp.late_fee_rate_percent != null ? `${lp.late_fee_rate_percent}% per ${lp.frequency ?? "month"}` : undefined) ??
            undefined,
        }
      : undefined,
    dispute_resolution_clause: dr
      ? {
          summary: String(dr.summary ?? dr.arbitration ?? ""),
          clause_ref: String(dr.clause_ref ?? dr.clause ?? "") || undefined,
        }
      : undefined,
    termination_clause: tm
      ? { summary: String(tm.summary ?? ""), clause_ref: String(tm.clause_ref ?? tm.clause ?? "") || undefined }
      : undefined,
    risk_notes: ((root.risk_notes as string[]) ?? []).slice(0, 5),
  };
}
