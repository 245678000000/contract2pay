// Tiny JSON-file persistence. Enough for a demo; swap for a real DB later.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ContractAnalysis } from "./contract";

export interface MilestoneInvoice {
  invoiceId?: string;
  status: string; // none | UNPAID | PAID | MARKED_AS_PAID | ...
  hostedUrl?: string;
  sentAt?: string;
  note?: string;
}

export interface StoredContract {
  id: string;
  createdAt: string;
  rawText: string;
  analysis: ContractAnalysis;
  invoices: Record<string, MilestoneInvoice>; // milestoneId -> invoice state
}

export interface ActivityEntry {
  id: string;
  at: string;
  kind: string; // analyze | invoice.created | invoice.sent | reminder.sent | late_fee | dispute_pack | payment.received | webhook | agent.plan | agent.executed
  contractId?: string;
  milestoneId?: string;
  summary: string;
  detail?: unknown;
}

interface State {
  contracts: StoredContract[];
  activity: ActivityEntry[];
}

const FILE = path.join(process.cwd(), ".data", "state.json");

async function load(): Promise<State> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as State;
  } catch {
    return { contracts: [], activity: [] };
  }
}

async function save(state: State) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(state, null, 2));
}

export async function getContracts() {
  return (await load()).contracts;
}

export async function getContract(id: string) {
  return (await load()).contracts.find((c) => c.id === id);
}

export async function addContract(rawText: string, analysis: ContractAnalysis): Promise<StoredContract> {
  const state = await load();
  const contract: StoredContract = {
    id: `c${Date.now()}`,
    createdAt: new Date().toISOString(),
    rawText,
    analysis,
    invoices: {},
  };
  state.contracts.push(contract);
  await save(state);
  return contract;
}

export async function updateContract(id: string, patch: (c: StoredContract) => void): Promise<StoredContract> {
  const state = await load();
  const c = state.contracts.find((x) => x.id === id);
  if (!c) throw new Error(`contract ${id} not found`);
  patch(c);
  await save(state);
  return c;
}

export async function logActivity(entry: Omit<ActivityEntry, "id" | "at">) {
  const state = await load();
  state.activity.unshift({
    ...entry,
    id: `a${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
    at: new Date().toISOString(),
  });
  state.activity = state.activity.slice(0, 200);
  await save(state);
}

export async function getState(): Promise<State> {
  return load();
}

export async function findByInvoiceId(invoiceId: string) {
  const { contracts } = await load();
  for (const c of contracts) {
    const milestoneId = Object.keys(c.invoices).find((m) => c.invoices[m].invoiceId === invoiceId);
    if (milestoneId) return { contract: c, milestoneId };
  }
  return null;
}
