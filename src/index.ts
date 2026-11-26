import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

const BASE = "https://intervals.icu/api/v1";
const DAY = 86400000;

type Json = Record<string, any>;
type Secrets = { INTERVALS_API_KEY: string; INTERVALS_ATHLETE_ID: string; MCP_PASSWORD: string };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => isoDate(new Date(Date.now() + n * DAY));
const round = (n: unknown, digits = 1) =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : undefined;
const minutes = (s: unknown) => (typeof s === "number" ? Math.round(s / 60) : undefined);
const km = (m: unknown) => (typeof m === "number" ? round(m / 1000, 2) : undefined);
const pace = (mps: unknown) => {
  if (typeof mps !== "number" || mps <= 0) return undefined;
  const sec = Math.round(1000 / mps);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}/km`;
};
/** Drop undefined/null so compact payloads stay small. */
const clean = (o: Json) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** ISO week start (Monday) for a YYYY-MM-DD string. */
const weekStart = (date: string) => {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return isoDate(new Date(d.getTime() - dow * DAY));
};

const compactEvent = (e: Json, withDescription = false) =>
  clean({
    id: e.id,
    date: e.start_date_local?.slice(0, 10),
    category: e.category,
    type: e.type,
    name: e.name,
    min: minutes(e.moving_time),
    km: km(e.distance),
    load: e.icu_training_load,
    done: e.paired_activity_id ? true : undefined,
    description: withDescription ? e.description : undefined,
  });

const compactActivity = (a: Json) =>
  clean({
    id: a.id,
    date: a.start_date_local?.slice(0, 16),
    type: a.type,
    name: a.name,
    min: minutes(a.moving_time),
    km: km(a.distance),
    dplus: round(a.total_elevation_gain, 0),
    pace: a.type?.includes("Run") ? pace(a.average_speed) : undefined,
    hr: round(a.average_heartrate, 0),
    hrMax: a.max_heartrate,
    // intervals.icu stores run cadence per leg; double it to steps/min like Garmin shows.
    cadence: round(a.type?.includes("Run") && a.average_cadence ? a.average_cadence * 2 : a.average_cadence, 0),
    load: a.icu_training_load,
    rpe: a.icu_rpe ?? a.perceived_exertion,
    feel: a.feel,
    decoupling: round(a.decoupling, 1),
  });

const compactWellness = (w: Json) =>
  clean({
    date: w.id,
    hrv: w.hrv,
    restingHR: w.restingHR,
    sleepH: round(typeof w.sleepSecs === "number" ? w.sleepSecs / 3600 : undefined, 1),
    sleepScore: w.sleepScore,
    weight: w.weight,
    ctl: round(w.ctl, 1),
    atl: round(w.atl, 1),
    form: typeof w.ctl === "number" && typeof w.atl === "number" ? round(w.ctl - w.atl, 1) : undefined,
    steps: w.steps,
    vo2max: w.vo2max,
  });

const range = {
  oldest: z.string().optional().describe("YYYY-MM-DD, inclusive"),
  newest: z.string().optional().describe("YYYY-MM-DD, inclusive"),
};

export class MyMCP extends McpAgent<Env & Secrets> {
  server = new McpServer({ name: "Intervals.icu", version: "2.1.0" });

  private authHeader() {
    return `Basic ${btoa(`API_KEY:${this.env.INTERVALS_API_KEY}`)}`;
  }

  private async icu(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`intervals.icu ${res.status}: ${await res.text()}`);
    const body = await res.text();
    if (!body) return { ok: true };
    try {
      return JSON.parse(body);
    } catch {
      return { ok: true, raw: body };
    }
  }

  private updateBody(u: { date?: string; name?: string; type?: string; description?: string }) {
    const body: Json = {};
    if (u.date) body.start_date_local = `${u.date}T00:00:00`;
    if (u.name) body.name = u.name;
    if (u.type) body.type = u.type;
    if (u.description) body.description = u.description;
    return body;
  }

  async init() {
    const athlete = this.env.INTERVALS_ATHLETE_ID;

    // ---------- Activities (done) ----------

    this.server.tool(
      "getRecentActivities",
      "Completed activities. Compact summary by default (km, pace, HR, D+, load, RPE); set full=true for raw intervals.icu objects.",
      {
        days: z.number().optional().describe("Days back, default 14 (ignored if oldest is set)"),
        ...range,
        full: z.boolean().optional().describe("Return raw objects instead of the compact summary"),
      },
      async ({ days = 14, oldest, newest, full }) => {
        const from = oldest ?? daysFromNow(-days);
        const q = `oldest=${from}${newest ? `&newest=${newest}` : ""}`;
        const data: Json[] = await this.icu(`/athlete/${athlete}/activities?${q}`);
        return text(full ? data : data.map(compactActivity));
      },
    );

    this.server.tool(
      "getActivity",
      "Details of one completed activity, with its laps/intervals (pace, HR, duration per interval).",
      { activityId: z.string().describe("Activity id from getRecentActivities, e.g. i123456") },
      async ({ activityId }) => {
        const [a, iv] = await Promise.all([
          this.icu(`/activity/${activityId}`),
          this.icu(`/activity/${activityId}/intervals`).catch(() => null),
        ]);
        const intervals = (iv?.icu_intervals ?? iv ?? []) as Json[];
        return text({
          ...compactActivity(a),
          description: a.description,
          intervals: Array.isArray(intervals)
            ? intervals.map((i) =>
                clean({
                  type: i.type,
                  label: i.label,
                  min: round(typeof i.moving_time === "number" ? i.moving_time / 60 : undefined, 1),
                  km: km(i.distance),
                  pace: pace(i.average_speed),
                  hr: round(i.average_heartrate, 0),
                  hrMax: i.max_heartrate,
                  dplus: round(i.total_elevation_gain, 0),
                }),
              )
            : undefined,
        });
      },
    );

    // ---------- Wellness ----------

    this.server.tool(
      "getWellness",
      "Daily recovery: HRV, resting HR, sleep hours/score, weight, fitness (ctl), fatigue (atl), form. Compact by default.",
      {
        days: z.number().optional().describe("Days back, default 7 (ignored if oldest is set)"),
        ...range,
        full: z.boolean().optional().describe("Return raw objects instead of the compact summary"),
      },
      async ({ days = 7, oldest, newest, full }) => {
        const from = oldest ?? daysFromNow(-days);
        const q = `oldest=${from}${newest ? `&newest=${newest}` : ""}`;
        const data: Json[] = await this.icu(`/athlete/${athlete}/wellness?${q}`);
        return text(full ? data : data.map(compactWellness));
      },
    );

    this.server.tool(
      "logWeight",
      "Record body weight (kg) for a day. Shows up in getWellness.",
      {
        weight: z.number().describe("Kilograms, e.g. 103.7"),
        date: z.string().optional().describe("YYYY-MM-DD, default today"),
      },
      async ({ weight, date }) => {
        const day = date ?? isoDate(new Date());
        const data = await this.icu(`/athlete/${athlete}/wellness/${day}`, {
          method: "PUT",
          body: JSON.stringify({ id: day, weight }),
        });
        return text(compactWellness(data));
      },
    );

    // ---------- Calendar (planned) ----------

    this.server.tool(
      "listUpcomingEvents",
      "Planned calendar. Compact by default (id, date, type, name, minutes, km, load). Use getEvent for one session's full description.",
      {
        days: z.number().optional().describe("Days ahead, default 14 (ignored if newest is set)"),
        ...range,
        category: z.string().optional().describe("Filter, e.g. WORKOUT, RACE_A, NOTE"),
        withDescription: z.boolean().optional().describe("Include each description (larger)"),
        full: z.boolean().optional().describe("Return raw objects"),
      },
      async ({ days = 14, oldest, newest, category, withDescription, full }) => {
        const from = oldest ?? isoDate(new Date());
        const to = newest ?? daysFromNow(days);
        let data: Json[] = await this.icu(`/athlete/${athlete}/events?oldest=${from}&newest=${to}`);
        if (category) data = data.filter((e) => e.category === category);
        return text(full ? data : data.map((e) => compactEvent(e, withDescription)));
      },
    );

    this.server.tool(
      "getEvent",
      "Full details of one planned event (description and structured steps).",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const e = await this.icu(`/athlete/${athlete}/events/${eventId}`);
        return text({ ...compactEvent(e, true), steps: e.workout_doc?.steps });
      },
    );

    this.server.tool(
      "weeklySummary",
      "Totals per ISO week (Mon-Sun): planned sessions from the calendar and/or completed activities. Run km/hours, other cardio hours, strength sessions, D+, load.",
      {
        ...range,
        source: z.enum(["planned", "done", "both"]).optional().describe("Default both"),
      },
      async ({ oldest, newest, source = "both" }) => {
        const from = oldest ?? daysFromNow(-28);
        const to = newest ?? daysFromNow(28);
        const weeks = new Map<string, Json>();
        const bucket = (date: string, kind: "planned" | "done") => {
          const w = weekStart(date);
          if (!weeks.has(w)) weeks.set(w, { week: w });
          const row = weeks.get(w)!;
          row[kind] ??= { runKm: 0, runH: 0, otherH: 0, strength: 0, mobility: 0, dplus: 0, load: 0, sessions: 0 };
          return row[kind];
        };
        const add = (b: Json, x: Json) => {
          const h = (x.moving_time ?? 0) / 3600;
          b.sessions += 1;
          b.load += x.icu_training_load ?? 0;
          if (x.type === "WeightTraining") {
            // Short WeightTraining entries are mobility/foot-care, not real strength sessions.
            if ((x.moving_time ?? 0) >= 15 * 60) b.strength += 1;
            else b.mobility += 1;
          }
          else if (String(x.type).includes("Run")) {
            b.runKm += (x.distance ?? 0) / 1000;
            b.runH += h;
          } else b.otherH += h;
          b.dplus += x.total_elevation_gain ?? 0;
        };
        if (source !== "done") {
          const ev: Json[] = await this.icu(`/athlete/${athlete}/events?oldest=${from}&newest=${to}`);
          ev.filter((e) => e.category === "WORKOUT").forEach((e) => add(bucket(e.start_date_local, "planned"), e));
        }
        if (source !== "planned") {
          const act: Json[] = await this.icu(`/athlete/${athlete}/activities?oldest=${from}&newest=${to}`);
          act.forEach((a) => add(bucket(a.start_date_local, "done"), a));
        }
        const fmt = (b?: Json) =>
          b && {
            ...b,
            runKm: round(b.runKm, 1),
            runH: round(b.runH, 1),
            otherH: round(b.otherH, 1),
            dplus: Math.round(b.dplus) || undefined,
            load: Math.round(b.load),
            mobility: b.mobility || undefined,
          };
        const rows = [...weeks.values()]
          .sort((a, b) => a.week.localeCompare(b.week))
          .map((r) => clean({ week: r.week, planned: fmt(r.planned), done: fmt(r.done) }));
        return text(rows);
      },
    );

    this.server.tool(
      "dailyBrief",
      "One-call coaching check-in: today's recovery vs 7-day baseline (HRV, resting HR, sleep), fitness/fatigue/form, last 7 days done, and the next 3 days planned.",
      {},
      async () => {
        const today = isoDate(new Date());
        const [well, acts, evs]: Json[][] = await Promise.all([
          this.icu(`/athlete/${athlete}/wellness?oldest=${daysFromNow(-7)}&newest=${today}`),
          this.icu(`/athlete/${athlete}/activities?oldest=${daysFromNow(-7)}`),
          this.icu(`/athlete/${athlete}/events?oldest=${today}&newest=${daysFromNow(3)}`),
        ]);
        const w = well.map(compactWellness);
        const last = w[w.length - 1] ?? {};
        const prior = w.slice(0, -1);
        const avg = (k: string) => {
          const v = prior.map((x) => x[k]).filter((n) => typeof n === "number");
          return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 1) : undefined;
        };
        const baseline = clean({ hrv: avg("hrv"), restingHR: avg("restingHR"), sleepH: avg("sleepH") });
        const flags: string[] = [];
        if (last.hrv && baseline.hrv && last.hrv < baseline.hrv * 0.9) flags.push("HRV >10% below 7-day average");
        if (last.restingHR && baseline.restingHR && last.restingHR > baseline.restingHR + 4)
          flags.push("Resting HR >4 bpm above average");
        if (last.sleepH !== undefined && last.sleepH < 6.5) flags.push("Short sleep (<6.5 h)");
        if (typeof last.form === "number" && last.form < -20) flags.push("Form below -20 (high fatigue)");
        const runs = acts.filter((a) => String(a.type).includes("Run"));
        return text({
          today: last,
          baseline7d: baseline,
          flags,
          last7days: {
            sessions: acts.length,
            runKm: round(runs.reduce((t, a) => t + (a.distance ?? 0), 0) / 1000, 1),
            runH: round(runs.reduce((t, a) => t + (a.moving_time ?? 0), 0) / 3600, 1),
            dplus: Math.round(runs.reduce((t, a) => t + (a.total_elevation_gain ?? 0), 0)),
            load: Math.round(acts.reduce((t, a) => t + (a.icu_training_load ?? 0), 0)),
            activities: acts.map(compactActivity),
          },
          next3days: evs.map((e) => compactEvent(e)),
        });
      },
    );

    this.server.tool(
      "getAthleteSettings",
      "Athlete profile and zones: weight, max/threshold HR, threshold pace, HR and pace zones per sport.",
      { full: z.boolean().optional().describe("Return the raw athlete object") },
      async ({ full }) => {
        const a = await this.icu(`/athlete/${athlete}`);
        if (full) return text(a);
        const sports = ((a.sportSettings ?? []) as Json[]).map((s) =>
          clean({
            types: s.types,
            maxHR: s.max_hr,
            lthr: s.lthr,
            restingHR: s.resting_hr ?? a.icu_resting_hr,
            thresholdPace: pace(s.threshold_pace),
            hrZones: s.hr_zones,
            hrZoneNames: s.hr_zone_names,
            paceZones: s.pace_zones,
            paceZoneNames: s.pace_zone_names,
            ftp: s.ftp,
          }),
        );
        return text(clean({ name: a.name, weight: a.icu_weight ?? a.weight, sex: a.sex, sports }));
      },
    );

    // ---------- Writes ----------

    this.server.tool(
      "createWorkout",
      "Add a planned workout to the calendar. intervals.icu parses the description into structured steps and syncs it to Garmin.",
      {
        date: z.string().describe("YYYY-MM-DD"),
        name: z.string(),
        type: z.string().describe("Run, Ride, Swim, Walk, WeightTraining, etc."),
        description: z.string().describe("Structured steps, e.g. '- 10m Z2\\n- 6x800m Z4, 400m Z1 jog\\n- 10m Z2'"),
      },
      async ({ date, name, type, description }) => {
        const data = await this.icu(`/athlete/${athlete}/events`, {
          method: "POST",
          body: JSON.stringify({ start_date_local: `${date}T00:00:00`, category: "WORKOUT", type, name, description }),
        });
        return text(compactEvent(data));
      },
    );

    this.server.tool(
      "updateWorkout",
      "Change one planned workout. Only the fields given are modified.",
      {
        eventId: z.number().describe("Event ID from listUpcomingEvents"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ eventId, ...u }) => {
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
          method: "PUT",
          body: JSON.stringify(this.updateBody(u)),
        });
        return text(compactEvent(data));
      },
    );

    this.server.tool(
      "bulkUpdateWorkouts",
      "Update several planned workouts in one call. Each item may change date, name, type and/or description. Returns per-item status.",
      {
        updates: z
          .array(
            z.object({
              eventId: z.number(),
              date: z.string().optional().describe("YYYY-MM-DD"),
              name: z.string().optional(),
              type: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .min(1)
          .max(50),
      },
      async ({ updates }) => {
        const results: Json[] = [];
        // Sequential on purpose: gentle on the intervals.icu rate limit.
        for (const { eventId, ...u } of updates) {
          try {
            const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
              method: "PUT",
              body: JSON.stringify(this.updateBody(u)),
            });
            results.push({ ok: true, ...compactEvent(data) });
          } catch (err) {
            results.push({ ok: false, id: eventId, error: String(err) });
          }
        }
        return text(results);
      },
    );

    this.server.tool(
      "logWellness",
      "Record how the athlete feels for a day (any subset). Scales 1-4 where 1 = best (none/low) and 4 = worst, except mood/motivation where 1 = great. Also weight, sleep quality, kcal eaten, free-text comment.",
      {
        date: z.string().optional().describe("YYYY-MM-DD, default today"),
        weight: z.number().optional(),
        soreness: z.number().int().min(1).max(4).optional(),
        fatigue: z.number().int().min(1).max(4).optional(),
        stress: z.number().int().min(1).max(4).optional(),
        mood: z.number().int().min(1).max(4).optional(),
        motivation: z.number().int().min(1).max(4).optional(),
        injury: z.number().int().min(1).max(4).optional(),
        sleepQuality: z.number().int().min(1).max(4).optional(),
        kcalConsumed: z.number().optional(),
        comments: z.string().optional(),
      },
      async ({ date, ...fields }) => {
        const day = date ?? isoDate(new Date());
        const data = await this.icu(`/athlete/${athlete}/wellness/${day}`, {
          method: "PUT",
          body: JSON.stringify(clean({ id: day, ...fields })),
        });
        return text(
          clean({
            ...compactWellness(data),
            soreness: data.soreness,
            fatigue: data.fatigue,
            stress: data.stress,
            mood: data.mood,
            motivation: data.motivation,
            injury: data.injury,
            comments: data.comments,
          }),
        );
      },
    );

    this.server.tool(
      "updateActivity",
      "Annotate a completed activity: rename, add notes, set RPE (1-10) and feel (1 = strong ... 5 = weak).",
      {
        activityId: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        rpe: z.number().int().min(1).max(10).optional(),
        feel: z.number().int().min(1).max(5).optional(),
      },
      async ({ activityId, name, description, rpe, feel }) => {
        const data = await this.icu(`/activity/${activityId}`, {
          method: "PUT",
          body: JSON.stringify(clean({ name, description, icu_rpe: rpe, feel })),
        });
        return text(compactActivity(data));
      },
    );

    this.server.tool(
      "createEvents",
      "Create several calendar events in one call: workouts, races (RACE_A/B/C) or notes. Returns per-item status.",
      {
        events: z
          .array(
            z.object({
              date: z.string().describe("YYYY-MM-DD"),
              category: z.enum(["WORKOUT", "RACE_A", "RACE_B", "RACE_C", "NOTE"]).optional().describe("Default WORKOUT"),
              name: z.string(),
              type: z.string().optional().describe("Run, Ride, WeightTraining... (needed for WORKOUT/RACE)"),
              description: z.string().optional(),
              minutes: z.number().optional().describe("Planned duration, for races or notes without steps"),
              km: z.number().optional().describe("Planned distance"),
            }),
          )
          .min(1)
          .max(50),
      },
      async ({ events }) => {
        const results: Json[] = [];
        for (const e of events) {
          try {
            const data = await this.icu(`/athlete/${athlete}/events`, {
              method: "POST",
              body: JSON.stringify(
                clean({
                  start_date_local: `${e.date}T00:00:00`,
                  category: e.category ?? "WORKOUT",
                  type: e.type,
                  name: e.name,
                  description: e.description,
                  moving_time: e.minutes ? Math.round(e.minutes * 60) : undefined,
                  distance: e.km ? Math.round(e.km * 1000) : undefined,
                }),
              ),
            });
            results.push({ ok: true, ...compactEvent(data) });
          } catch (err) {
            results.push({ ok: false, name: e.name, date: e.date, error: String(err) });
          }
        }
        return text(results);
      },
    );

    this.server.tool(
      "deleteEvents",
      "Delete several calendar events in one call. Returns per-item status.",
      { eventIds: z.array(z.number()).min(1).max(50) },
      async ({ eventIds }) => {
        const results: Json[] = [];
        for (const id of eventIds) {
          try {
            await this.icu(`/athlete/${athlete}/events/${id}`, { method: "DELETE" });
            results.push({ ok: true, id });
          } catch (err) {
            results.push({ ok: false, id, error: String(err) });
          }
        }
        return text(results);
      },
    );

    this.server.tool(
      "deleteEvent",
      "Delete one calendar event (workout, note or race).",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, { method: "DELETE" });
        return text(data);
      },
    );
  }
}

function loginPage(state: string, error: string) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intervals.icu MCP</title>
  <body style="font-family:system-ui;max-width:20rem;margin:4rem auto">
  <h2>Intervals.icu MCP</h2>
  <p style="color:#c00">${error}</p>
  <form method="post">
    <input type="hidden" name="state" value="${state}">
    <input type="password" name="password" placeholder="Password" autofocus
           style="width:100%;padding:.5rem;margin-bottom:.5rem">
    <button style="width:100%;padding:.5rem">Authorize</button>
  </form></body>`;
}

const defaultHandler = {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const html = { "content-type": "text/html;charset=utf-8" };

    if (request.method === "GET") {
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return new Response(loginPage(btoa(JSON.stringify(info)), ""), { headers: html });
    }

    const body = await request.formData();
    const state = String(body.get("state") ?? "");
    if (String(body.get("password")) !== env.MCP_PASSWORD) {
      return new Response(loginPage(state, "Wrong password"), { status: 401, headers: html });
    }

    const info = JSON.parse(atob(state));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: "owner",
      metadata: {},
      scope: info.scope ?? [],
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
