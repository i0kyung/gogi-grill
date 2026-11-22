import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Server-authoritative ranking for 지글지글 한 판.
// The client never sends a score it computed; it sends what happened (serve events)
// and the server recomputes the score with caps, timing checks and a once-only claim.
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const GAME_SEC = 180, MIN_REAL = 170, MAX_REAL = 30 * 60, MAX_EVENTS = 24;
const NEED: Record<string, number> = { sam: 3, mok: 2, cha: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Monthly season, reset on the 1st at 00:00 KST
function seasonInfo(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600e3);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth();
  const key = `${y}-${String(m + 1).padStart(2, "0")}`;
  const endsAt = new Date(Date.UTC(y, m + 1, 1) - 9 * 3600e3).toISOString();
  return { key, endsAt };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
function cleanName(s: unknown) {
  const v = String(s ?? "").replace(/[\u0000-\u001f\u007f<>&"']/g, "").trim().slice(0, 10);
  return v || "고기 손님";
}

type Ev = { t: number; k: string; g?: number; p?: number; pat: number };
function scoreEvents(events: unknown) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return { err: "too_many_events" };
  let last = -10, total = 0, combo = 0, maxCombo = 0, served = 0, perfect = 0;
  for (const raw of events as Ev[]) {
    const t = Number(raw?.t);
    if (!Number.isFinite(t) || t < 0 || t > GAME_SEC + 2) return { err: "bad_time" };
    if (t < last) return { err: "unordered" };
    if (t - last < 1) return { err: "too_fast" };
    last = t;
    const pat = Math.max(0, Math.min(1, Number(raw.pat) || 0));
    let bonus: number, isPerfect: boolean;
    if (raw.k === "rice") {
      const p = Math.max(0, Math.min(100, Math.round(Number(raw.p) || 0)));
      if (p < 50) return { err: "bad_rice" };
      bonus = p; isPerfect = p >= 90;
    } else if (raw.k in NEED) {
      const n = NEED[raw.k];
      const g = Math.max(0, Math.min(n, Math.floor(Number(raw.g) || 0)));
      bonus = g * 20; isPerfect = g === n;
    } else return { err: "bad_kind" };
    if (isPerfect) { combo++; maxCombo = Math.max(maxCombo, combo); } else combo = 0;
    const mult = isPerfect && combo > 1 ? 1 + 0.2 * Math.min(combo - 1, 5) : 1;
    total += Math.round((100 + bonus + Math.round(pat * 50)) * mult);
    served++; if (isPerfect) perfect++;
  }
  // customers arrive at most once every 9 s after the first one
  const maxCustomers = 2 + Math.floor((GAME_SEC - 2) / 9);
  if (served > maxCustomers) return { err: "too_many_serves" };
  return { total, served, perfect, maxCombo };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const S = seasonInfo();
  const nowIso = () => new Date().toISOString();

  if (body.action === "board") {
    const { data, error } = await sb.from("scores").select("player,name,score,served,updated_at").eq("season", S.key)
      .order("score", { ascending: false }).order("updated_at", { ascending: true }).limit(50);
    if (error) return json({ error: "db" }, 500);
    return json({ season: S.key, endsAt: S.endsAt, serverTime: nowIso(), rows: data });
  }

  const player = String(body.player || "");
  if (!UUID.test(player)) return json({ error: "bad_player" }, 400);

  if (body.action === "start") {
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const { count } = await sb.from("runs").select("id", { count: "exact", head: true }).eq("player", player).gte("started_at", hourAgo);
    if ((count ?? 0) >= 40) return json({ error: "rate_limited" }, 429);
    // only one live game per player: a new start closes any older one
    await sb.from("runs").update({ status: "abandoned", finished_at: nowIso(), reason: "new_game" }).eq("player", player).eq("status", "active");
    const { data, error } = await sb.from("runs").insert({ player, season: S.key }).select("id").single();
    if (error) return json({ error: "db" }, 500);
    return json({ runId: data.id, season: S.key, endsAt: S.endsAt, serverTime: nowIso(), duration: GAME_SEC });
  }

  const runId = String(body.runId || "");
  if (!UUID.test(runId)) return json({ error: "bad_run" }, 400);

  if (body.action === "abandon") {
    await sb.from("runs").update({ status: "abandoned", finished_at: nowIso(), reason: "left" }).eq("id", runId).eq("player", player).eq("status", "active");
    return json({ ok: true });
  }

  if (body.action === "submit") {
    const now = new Date();
    // claim the run exactly once: only an 'active' run can move to 'submitted'
    const { data: run, error } = await sb.from("runs").update({ status: "submitted", finished_at: now.toISOString() })
      .eq("id", runId).eq("player", player).eq("status", "active").select("id,season,started_at").maybeSingle();
    if (error) return json({ error: "db" }, 500);
    if (!run) {
      const { data: prev } = await sb.from("runs").select("status,score,reason").eq("id", runId).eq("player", player).maybeSingle();
      if (prev?.status === "submitted" && prev.score != null) return json({ duplicate: true, score: prev.score, season: S.key });
      return json({ error: "run_closed", reason: prev?.reason || prev?.status || "unknown" }, 409);
    }
    const reject = async (reason: string) => {
      await sb.from("runs").update({ status: "rejected", reason }).eq("id", runId);
      return json({ error: "rejected", reason }, 422);
    };
    if (run.season !== S.key) return reject("season_ended");
    const real = (now.getTime() - new Date(run.started_at).getTime()) / 1000;
    if (real < MIN_REAL) return reject("too_short");
    if (real > MAX_REAL) return reject("expired");
    const r = scoreEvents(body.events);
    if ("err" in r) return reject(r.err as string);
    const name = cleanName(body.name);
    await sb.from("runs").update({ score: r.total, served: r.served }).eq("id", runId);
    const { data: best } = await sb.from("scores").select("score").eq("season", S.key).eq("player", player).maybeSingle();
    let improved = false;
    if (!best || r.total > best.score) {
      const { error: e2 } = await sb.from("scores").upsert({ season: S.key, player, name, score: r.total, served: r.served, run_id: runId, updated_at: now.toISOString() });
      if (e2) return json({ error: "db" }, 500);
      improved = true;
    }
    const myBest = improved ? r.total : best!.score;
    const { count: above } = await sb.from("scores").select("player", { count: "exact", head: true }).eq("season", S.key).gt("score", myBest);
    return json({ score: r.total, served: r.served, perfect: r.perfect, maxCombo: r.maxCombo, best: myBest, improved, rank: (above ?? 0) + 1, season: S.key, endsAt: S.endsAt });
  }
  return json({ error: "unknown_action" }, 400);
});
