import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/steward/accounts/[userId]/reset-credits/route";

const { mockCreateClient, mockCreateAdminClient, requireStaffMock } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockCreateAdminClient: vi.fn(),
  requireStaffMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockCreateAdminClient }));
vi.mock("@/lib/supabase/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/auth")>()),
  requireStaff: requireStaffMock,
}));

function req() {
  return new Request("http://localhost", { method: "POST" });
}
function params(userId: string) {
  return { params: Promise.resolve({ userId }) };
}

describe("steward account reset-credits route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateClient.mockResolvedValue({});
  });

  it("rejects a non-staff caller", async () => {
    requireStaffMock.mockResolvedValue({ user: null, response: new Response(null, { status: 403 }) });
    const response = await POST(req(), params("user-1"));
    expect(response.status).toBe(403);
  });

  it("resets the user's credit balance to their tier cap via grant_tier_credits(period_reset)", async () => {
    requireStaffMock.mockResolvedValue({ user: { id: "steward-1" }, response: null });
    const rpcMock = vi.fn().mockResolvedValue({ data: 3_600_000, error: null });
    mockCreateAdminClient.mockReturnValue({ rpc: rpcMock });

    const response = await POST(req(), params("user-1"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("grant_tier_credits", { p_user_id: "user-1", p_kind: "period_reset" });
    expect(payload).toEqual({ ok: true, balanceUsdMicros: 3_600_000 });
  });

  it("returns 500 when the RPC errors", async () => {
    requireStaffMock.mockResolvedValue({ user: { id: "steward-1" }, response: null });
    mockCreateAdminClient.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: new Error("boom") }) });

    const response = await POST(req(), params("user-1"));
    expect(response.status).toBe(500);
  });
});
