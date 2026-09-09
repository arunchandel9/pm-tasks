/**
 * Pulp client (MangoEyes' own board tool), written against the Pulp API v1 brief:
 *   base   https://pulp.mangoeyes.io/api/v1   (derived from boards.yaml base_url unless PULP_BASE_URL is set)
 *   auth   Authorization: Bearer pulp_sk_…      (PULP_TOKEN; the key acts as one Pulp user, member of every board)
 *   shape  { data: … } on success, { error: "…" } on failure; UUID ids; soft deletes (closed=true)
 *
 * Boards and lists are resolved by name or id prefix at run time and cached for ten minutes,
 * re-resolved on 404, because names and ids are live data in the app.
 */
import { boards as boardsConfig } from "./config";

export interface PulpCard { id: string; boardId: string; listId: string; title: string; updatedAt?: string }
export interface PulpList { id: string; name: string; position: number }
export interface PulpBoard { id: string; name: string }
interface Member { user_id?: string; id?: string; email?: string; full_name?: string; name?: string; display_name?: string; profile?: { email?: string; full_name?: string; name?: string } }

const token = () => process.env.PULP_TOKEN?.trim() || null;
const base = () => (process.env.PULP_BASE_URL?.trim() || `${boardsConfig().base_url.replace(/\/$/, "")}/api/v1`).replace(/\/$/, "");

class PulpError extends Error { constructor(public status: number, message: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = token();
  if (!key) throw new Error("PULP_NOT_CONFIGURED");
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: { data?: T; error?: string } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  if (!res.ok) throw new PulpError(res.status, `pulp ${method} ${path} → ${res.status} ${json.error ?? text.slice(0, 200)}`);
  return json.data as T;
}

// ---- caches (per warm instance; 10 minutes) ----
const TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>, force = false): Promise<T> {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
export const normList = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** A list that means the work is finished: "Done", "Done (Final Delivery)", "Completed". Not "Ready to Use / Go Live" or "QA Testing Done". */
export const isDoneList = (name: string) => /^(done|completed?|closed)\b/i.test(name.trim());
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const pulp = {
  configured: () => !!token(),
  baseUrl: base,

  async me(): Promise<Record<string, unknown>> { return call("GET", "/me"); },

  async boards(force = false): Promise<PulpBoard[]> {
    return cached("boards", async () => {
      const rows = await call<Array<{ id: string; name: string }>>("GET", "/boards");
      return rows.map((b) => ({ id: b.id, name: b.name }));
    }, force);
  },

  /** boards.yaml may hold a full UUID, the 8-character prefix seen in board URLs, or the board's name. */
  async resolveBoardId(ref: string | null | undefined): Promise<string | null> {
    if (!ref) return null;
    const r = ref.trim();
    if (isUuid(r)) return r;
    // Sprint boards are renamed every week ("01-Graphics Design Sprint #52 - Week 37"), so a name in config matches
    // by containment, preferring an exact match and the most recently created board when several contain it.
    const lc = r.toLowerCase();
    const find = (list: PulpBoard[]) =>
      list.find((b) => b.id.toLowerCase().startsWith(lc))?.id
      ?? list.find((b) => b.name.trim().toLowerCase() === lc)?.id
      ?? list.filter((b) => b.name.toLowerCase().includes(lc) && !/imported/i.test(b.name)).at(-1)?.id
      ?? list.find((b) => b.name.toLowerCase().includes(lc))?.id
      ?? null;
    return find(await this.boards()) ?? find(await this.boards(true));
  },

  async listsOnBoard(boardId: string, force = false): Promise<PulpList[]> {
    return cached(`lists:${boardId}`, async () => {
      const rows = await call<Array<{ id: string; name: string; position: number }>>("GET", `/boards/${boardId}/lists`);
      return rows.map((l) => ({ id: l.id, name: l.name, position: Number(l.position ?? 0) }));
    }, force);
  },

  /** List names are matched ignoring case, spaces and punctuation: "To Do" = "To-Do" = "To-do" = "TODO". */
  async findListId(boardId: string, listName: string): Promise<string | null> {
    const want = normList(listName);
    const pick = (ls: PulpList[]) => ls.find((l) => normList(l.name) === want)?.id ?? null;
    return pick(await this.listsOnBoard(boardId)) ?? pick(await this.listsOnBoard(boardId, true));
  },

  /** Find the list by name, creating it (at the end of the board) if it does not exist. */
  async ensureList(boardId: string, listName: string): Promise<string> {
    const id = await this.findListId(boardId, listName);
    if (id) return id;
    const created = await call<{ id: string }>("POST", `/boards/${boardId}/lists`, { name: listName });
    cache.delete(`lists:${boardId}`);
    return created.id;
  },

  async labelsOnBoard(boardId: string, force = false): Promise<Array<{ id: string; name: string; color: string }>> {
    return cached(`labels:${boardId}`, async () => {
      const rows = await call<Array<{ id: string; name?: string | null; color: string }>>("GET", `/boards/${boardId}/labels`);
      return rows.map((l) => ({ id: l.id, name: (l.name ?? "").trim(), color: l.color }));
    }, force);
  },

  async membersOnBoard(boardId: string): Promise<Array<{ userId: string; email: string; name: string }>> {
    return cached(`members:${boardId}`, async () => {
      const rows = await call<Member[]>("GET", `/boards/${boardId}/members`);
      return rows.map((m) => ({
        userId: String(m.user_id ?? m.id ?? ""),
        email: String(m.email ?? m.profile?.email ?? "").toLowerCase(),
        name: String(m.full_name ?? m.name ?? m.display_name ?? m.profile?.full_name ?? m.profile?.name ?? ""),
      })).filter((m) => m.userId);
    });
  },

  /**
   * Create a card in a list, then set description, due date, labels and assignee. Only the create is fatal;
   * the rest is best-effort so a missing label or member never blocks a task.
   */
  async createCard(p: { boardId: string; listId: string; title: string; description: string; labels: string[]; assignee?: string | null; dueAt?: Date | null }): Promise<PulpCard> {
    const c = await call<{ id: string; list_id: string; board_id: string; name: string }>("POST", `/boards/${p.boardId}/cards`, { list_id: p.listId, name: p.title.slice(0, 200) });
    const warnings: string[] = [];
    try {
      await call("PATCH", `/cards/${c.id}`, { description: p.description, due_date: p.dueAt ? p.dueAt.toISOString() : null });
    } catch (e) { warnings.push(`describe: ${(e as Error).message}`); }
    for (const name of p.labels) {
      try {
        const labels = await this.labelsOnBoard(p.boardId);
        let label = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
        if (!label) {
          const created = await call<{ id: string }>("POST", `/boards/${p.boardId}/labels`, { name, color: LABEL_COLOURS[name.toUpperCase()] ?? "sky" });
          cache.delete(`labels:${p.boardId}`);
          label = { id: created.id, name, color: "" };
        }
        await call("POST", `/cards/${c.id}/labels`, { label_id: label.id });
      } catch (e) { warnings.push(`label ${name}: ${(e as Error).message}`); }
    }
    if (p.assignee) {
      try {
        const userId = await this.findMember(p.boardId, p.assignee);
        if (userId) await call("POST", `/cards/${c.id}/members`, { user_id: userId });
        else warnings.push(`assignee ${p.assignee}: not a member of the board`);
      } catch (e) { warnings.push(`assignee: ${(e as Error).message}`); }
    }
    if (warnings.length) console.warn("pulp createCard partial:", warnings.join(" | "));
    return { id: c.id, boardId: c.board_id ?? p.boardId, listId: c.list_id ?? p.listId, title: c.name ?? p.title };
  },

  /** Email or name (case-insensitive, first-name match as a last resort) → Pulp user id on that board. */
  async findMember(boardId: string, who: string): Promise<string | null> {
    const w = who.trim().toLowerCase();
    if (!w) return null;
    const members = await this.membersOnBoard(boardId);
    return members.find((m) => m.email === w)?.userId
      ?? members.find((m) => m.name.toLowerCase() === w)?.userId
      ?? members.find((m) => m.name.toLowerCase().split(/\s+/)[0] === w.split(/\s+/)[0])?.userId
      ?? null;
  },

  async moveCard(cardId: string, listId: string): Promise<void> {
    await call("POST", `/cards/${cardId}/move`, { list_id: listId });
  },

  async addComment(cardId: string, text: string): Promise<void> {
    await call("POST", `/cards/${cardId}/comments`, { content: text });
  },

  async getCard(cardId: string): Promise<PulpCard & { listName?: string; description?: string; attachments?: Array<{ url: string; name?: string }> }> {
    const c = await call<{ id: string; board_id: string; list_id: string; name: string; list_name?: string; description?: string; updated_at?: string; attachments?: Array<{ url: string; name?: string }> }>("GET", `/cards/${cardId}`);
    return { id: c.id, boardId: c.board_id, listId: c.list_id, title: c.name, listName: c.list_name, description: c.description, updatedAt: c.updated_at, attachments: c.attachments };
  },

  /** All open cards on a board. The minute poll diffs these against the tasks table (Pulp has no webhook yet). */
  async openCards(boardId: string): Promise<PulpCard[]> {
    const rows = await call<Array<{ id: string; board_id: string; list_id: string; name: string; updated_at?: string }>>("GET", `/boards/${boardId}/cards`);
    return rows.map((c) => ({ id: c.id, boardId: c.board_id ?? boardId, listId: c.list_id, title: c.name, updatedAt: c.updated_at }));
  },

  /** Link a PM can click. Template lives in boards.yaml (card_url) so it is one line to change once confirmed. */
  cardUrl(boardId: string, cardId: string): string {
    const cfg = boardsConfig();
    const tpl = cfg.card_url || "{base}/board/{board}/card/{card}";
    return tpl.replace("{base}", cfg.base_url.replace(/\/$/, "")).replace("{board}", boardId).replace("{card}", cardId);
  },
};

const LABEL_COLOURS: Record<string, string> = { P1: "red", P2: "orange", P3: "green", "NEEDS SCOPE": "purple", "CLIENT WAITING": "yellow" };
