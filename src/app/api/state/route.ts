import { NextResponse } from "next/server";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const { contracts, activity } = await getState();
  return NextResponse.json({ contracts, activity });
}
