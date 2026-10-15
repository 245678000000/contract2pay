import { NextRequest, NextResponse } from "next/server";
import { executeAction, type PlannedAction } from "@/lib/agent";
import { getContract, logActivity } from "@/lib/store";

export const dynamic = "force-dynamic";

/** POST { contractId, action } — runs one user-approved agent action. */
export async function POST(req: NextRequest) {
  try {
    const { contractId, action } = (await req.json()) as { contractId: string; action: PlannedAction };
    const contract = await getContract(contractId);
    if (!contract) return NextResponse.json({ error: "contract not found" }, { status: 404 });

    const result = await executeAction(contract, action);
    await logActivity({
      kind: "agent.executed",
      contractId,
      milestoneId: action.milestone_id,
      summary: `User approved → ${action.type}: ${result.summary}`,
    });
    return NextResponse.json({ result, contract: await getContract(contractId) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
