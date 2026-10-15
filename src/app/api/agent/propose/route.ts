import { NextRequest, NextResponse } from "next/server";
import { buildFacts, proposePlan } from "@/lib/agent";
import { getContract, logActivity } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { contractId } = (await req.json()) as { contractId: string };
    const contract = await getContract(contractId);
    if (!contract) return NextResponse.json({ error: "contract not found" }, { status: 404 });

    const facts = await buildFacts(contract);
    const plan = await proposePlan(contract.analysis, facts);
    await logActivity({
      kind: "agent.plan",
      contractId,
      summary: `Agent proposed ${plan.actions.length} action(s): ${plan.actions.map((a) => a.type).join(", ")}`,
      detail: { situation_summary: plan.situation_summary },
    });
    return NextResponse.json({ facts, plan });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
