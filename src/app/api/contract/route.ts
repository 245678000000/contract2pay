import { NextRequest, NextResponse } from "next/server";
import { analyzeContract } from "@/lib/contract";
import { addContract, getContracts, logActivity } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ contracts: await getContracts() });
}

export async function POST(req: NextRequest) {
  try {
    const { text } = (await req.json()) as { text?: string };
    if (!text || text.trim().length < 30) {
      return NextResponse.json({ error: "contract text too short" }, { status: 400 });
    }
    const analysis = await analyzeContract(text);
    const contract = await addContract(text, analysis);
    await logActivity({
      kind: "analyze",
      contractId: contract.id,
      summary: `Contract analyzed: ${analysis.contract_title} — ${analysis.milestones.length} milestone(s), ${analysis.currency}`,
      detail: analysis,
    });
    return NextResponse.json({ contract });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
