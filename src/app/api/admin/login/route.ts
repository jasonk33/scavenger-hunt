import { checkPin } from "@/lib/settings";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { pin } = await req.json().catch(() => ({ pin: "" }));
  if (!checkPin(String(pin ?? ""))) return fail("Wrong PIN.", 401);

  const res = json({ ok: true });
  res.headers.append(
    "set-cookie",
    // Long-lived on purpose: the judge should never be logged out mid-event.
    `organizer=${encodeURIComponent(String(pin ?? ""))}; Path=/; Max-Age=2592000; SameSite=Lax`
  );
  return res;
}

export async function DELETE() {
  const res = json({ ok: true });
  res.headers.append("set-cookie", "organizer=; Path=/; Max-Age=0; SameSite=Lax");
  return res;
}
