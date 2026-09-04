import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Resets a user's AI credit balance back to their subscription tier's
 * monthly cap via grant_tier_credits(..., 'period_reset') -- the exact same
 * RPC a real Stripe billing-cycle webhook uses (see
 * src/lib/billing/webhook-handlers.ts). Needed as a manual staff action for
 * cases like heavy internal QA burning through a trial's low credit cap
 * mid-cycle -- not a self-service endpoint, since grant_tier_credits sets
 * (not adds to) the balance and calling it repeatedly would otherwise be an
 * unlimited-free-credits loophole.
 */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const supabase = await createClient();
  const { user, response } = await requireStaff(supabase);
  if (!user) return response;

  const { userId } = await params;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("grant_tier_credits", { p_user_id: userId, p_kind: "period_reset" });
    if (error) throw error;

    return NextResponse.json({ ok: true, balanceUsdMicros: data });
  } catch (error) {
    console.error("Steward account credit reset failed", error);
    return NextResponse.json({ error: "Unable to reset AI credits." }, { status: 500 });
  }
}
