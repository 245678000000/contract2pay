"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActivityEntry, StoredContract } from "@/lib/store";
import type { AgentPlan, MilestoneFact, PlannedAction } from "@/lib/agent";

const SAMPLE_CONTRACT = `FREELANCE DESIGN SERVICES AGREEMENT

This Agreement is made on 2026-08-10 between Alex Chen Design ("Provider", freelancer, alex@alexchendesign.com) and Brightpath Marketing Ltd. ("Client", a UK company, accounts@brightpath.co.uk).

1. Scope. Provider will deliver a brand refresh: logo suite, UI design system, and marketing site visuals ("Deliverables").

2. Fees. Total fee USD 8,000, payable in milestones:
2.1 Deposit: USD 2,000, due 2026-09-15. Covers project setup and kickoff.
2.2 UI design phase: USD 3,500, due 2026-09-30. Covers the full design system and component library.
2.3 Final deliverables: USD 2,500, due 2026-11-30. Covers final files, brand book, and handover session.

3. Late payments. Overdue amounts accrue a late fee of 1.5% of the overdue principal per month, compounded monthly (clause 3.1). Client shall cure within 10 days of written notice before Provider may exercise clause 4 (clause 3.2).

4. Termination for non-payment. If any milestone remains unpaid more than 45 days after its due date, Provider may suspend work or terminate this Agreement upon 7 days' written notice (clause 4.1).

5. Dispute resolution. Parties shall first attempt good-faith negotiation for 15 days; unresolved disputes go to binding arbitration in Singapore under SIAC rules (clause 5.1).

6. Governing law: Singapore.`;

interface Health {
  env: { paypal: boolean; ai: boolean; model: string };
  paypalOk: boolean;
  paypalErr: string | null;
}

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [text, setText] = useState("");
  const [contract, setContract] = useState<StoredContract | null>(null);
  const [contractId, setContractId] = useState<string | null>(null);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [facts, setFacts] = useState<MilestoneFact[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state");
    const data = await res.json();
    setActivity(data.activity ?? []);
    if (contractId) {
      setContract(data.contracts?.find((c: StoredContract) => c.id === contractId) ?? null);
    }
  }, [contractId]);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  async function analyze() {
    setBusy("analyze"); setError(null); setPlan(null);
    try {
      const res = await fetch("/api/contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setContract(data.contract);
      setContractId(data.contract.id);
      const s = await fetch("/api/state").then((r) => r.json());
      setActivity(s.activity ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function syncInvoices(milestoneId?: string) {
    if (!contractId) return;
    setBusy(milestoneId ?? "sync"); setError(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractId, milestoneId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setContract(data.contract);
      const s = await fetch("/api/state").then((r) => r.json());
      setActivity(s.activity ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function propose() {
    if (!contractId) return;
    setBusy("agent"); setError(null);
    try {
      const res = await fetch("/api/agent/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPlan(data.plan);
      setFacts(data.facts);
      const s = await fetch("/api/state").then((r) => r.json());
      setActivity(s.activity ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function execute(action: PlannedAction) {
    if (!contractId) return;
    setBusy(`exec-${action.id}`); setError(null);
    try {
      const res = await fetch("/api/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const m = contract?.analysis;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 space-y-8 bg-slate-950 min-h-screen text-slate-100">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Contract2Pay</h1>
          <p className="text-sm text-slate-400">
            Sign the contract. The agent handles invoicing, reminders and disputes — via PayPal.
          </p>
        </div>
        <div className="text-xs text-right space-y-1">
          <div>
            {health?.paypalOk ? "🟢 PayPal sandbox" : health?.env.paypal ? "🔴 PayPal auth failed" : "🟡 PayPal keys not set"}
          </div>
          <div>{health?.env.ai ? `🟢 AI: ${health.env.model}` : "🟡 AI env not set"}</div>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-200">{error}</div>
      )}

      {/* Step 1 — contract in */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
        <h2 className="font-semibold">1 · Analyze contract</h2>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder="Paste a service contract (or load the sample)…"
          className="w-full rounded-lg bg-slate-950 border border-slate-800 p-3 text-sm font-mono"
        />
        <div className="flex gap-3">
          <button
            onClick={analyze}
            disabled={busy !== null || text.trim().length < 30}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            {busy === "analyze" ? "Analyzing…" : "Extract milestones with AI"}
          </button>
          <button
            onClick={() => setText(SAMPLE_CONTRACT)}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm"
          >
            Load sample (overdue design fee)
          </button>
        </div>
      </section>

      {/* Step 2 — contract + PayPal invoices */}
      {m && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">2 · Contract → PayPal invoices</h2>
            <button
              onClick={() => syncInvoices()}
              disabled={busy !== null}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              {busy === "sync" ? "Creating…" : "Sync milestones to PayPal"}
            </button>
          </div>
          <p className="text-sm text-slate-400">
            {m.contract_title} · {m.currency} · {m.parties.map((p) => `${p.name} (${p.role})`).join(" vs ")}
          </p>
          {m.late_payment_clause?.exists && (
            <p className="text-xs text-amber-300/80">
              Late fee clause {m.late_payment_clause.clause_ref}: {m.late_payment_clause.interest_or_fee} — {m.late_payment_clause.summary}
            </p>
          )}
          <table className="w-full text-sm">
            <thead className="text-slate-400 text-xs uppercase">
              <tr>
                <th className="text-left py-1">Milestone</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Due</th>
                <th className="text-right">Invoice</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {m.milestones.map((ms) => {
                const inv = contract?.invoices[ms.id];
                const overdue = ms.due_date && new Date(ms.due_date) < new Date() && inv?.status !== "PAID";
                return (
                  <tr key={ms.id} className="border-t border-slate-800">
                    <td className="py-2">
                      <span className="font-medium">{ms.name}</span>
                      <span className="ml-2 text-xs text-slate-500">§{ms.clause_ref}</span>
                    </td>
                    <td className="text-right tabular-nums">{m.currency} {ms.amount.toLocaleString()}</td>
                    <td className={"text-right tabular-nums " + (overdue ? "text-red-400" : "")}>
                      {ms.due_date ?? ms.due_rule} {overdue ? "· overdue" : ""}
                    </td>
                    <td className="text-right">
                      {inv?.invoiceId ? (
                        <span className={inv.status === "PAID" ? "text-emerald-400" : "text-amber-400"}>
                          {inv.status}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="pl-3 text-right">
                      {inv?.hostedUrl ? (
                        <a href={inv.hostedUrl} target="_blank" className="text-blue-400 text-xs underline">
                          pay link ↗
                        </a>
                      ) : (
                        <button
                          onClick={() => syncInvoices(ms.id)}
                          disabled={busy !== null}
                          className="text-xs text-blue-400 underline disabled:opacity-40"
                        >
                          {busy === ms.id ? "creating…" : "create invoice"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* Step 3 — agent */}
      {contract && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">3 · Collections agent</h2>
            <button
              onClick={propose}
              disabled={busy !== null}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              {busy === "agent" ? "Thinking…" : "Analyze situation & propose plan"}
            </button>
          </div>

          {plan && (
            <div className="space-y-4">
              <p className="text-sm rounded-lg bg-slate-950 border border-slate-800 p-3">{plan.situation_summary}</p>
              {facts.some((f) => f.days_overdue !== null) && (
                <div className="text-xs text-red-300">
                  Overdue detected:{" "}
                  {facts
                    .filter((f) => f.days_overdue !== null)
                    .map((f) => `${f.name} (${f.days_overdue}d, §${f.clause_ref})`)
                    .join(" · ")}
                </div>
              )}
              <div className="space-y-3">
                {plan.actions.map((a) => (
                  <div key={a.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className={"text-xs uppercase px-2 py-0.5 rounded " + severityClass(a.severity)}>
                          {a.severity}
                        </span>
                        <span className="text-sm font-medium">{a.type.replace(/_/g, " ")}</span>
                        {a.amount ? (
                          <span className="text-xs text-slate-400">{m?.currency} {a.amount.toFixed(2)}</span>
                        ) : null}
                      </div>
                      <button
                        onClick={() => execute(a)}
                        disabled={busy !== null || a.type === "no_action"}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                      >
                        {busy === `exec-${a.id}` ? "Running…" : "Approve & run"}
                      </button>
                    </div>
                    <p className="text-xs text-slate-400">{a.rationale}</p>
                    {a.email_draft && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-blue-400">Email draft</summary>
                        <div className="mt-2 border-l-2 border-slate-700 pl-3 space-y-1">
                          <p className="font-medium">{a.email_draft.subject}</p>
                          <pre className="whitespace-pre-wrap font-sans text-slate-300">{a.email_draft.body}</pre>
                        </div>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Activity */}
      {activity.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold mb-3">Activity</h2>
          <ul className="space-y-2 text-sm">
            {activity.slice(0, 12).map((a) => (
              <li key={a.id} className="flex gap-3">
                <span className="text-xs text-slate-500 tabular-nums shrink-0">
                  {new Date(a.at).toLocaleString()}
                </span>
                <span>
                  <span className="text-xs font-mono text-slate-500 mr-2">{a.kind}</span>
                  {a.summary}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function severityClass(s: string) {
  return s === "final"
    ? "bg-red-900/60 text-red-200"
    : s === "firm"
      ? "bg-amber-900/60 text-amber-200"
      : "bg-slate-800 text-slate-300";
}
