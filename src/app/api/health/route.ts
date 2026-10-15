import { NextResponse } from "next/server";
import { getToken } from "@/lib/paypal";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = {
    paypal: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    ai: !!(process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL),
    model: process.env.AI_MODEL ?? "",
  };
  let paypalOk = false;
  let paypalErr: string | null = null;
  if (env.paypal) {
    try {
      await getToken();
      paypalOk = true;
    } catch (e) {
      paypalErr = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ env, paypalOk, paypalErr });
}
