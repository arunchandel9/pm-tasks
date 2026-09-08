/**
 * Pulp client. Pulp is MangoEyes' own Trello-like board tool.
 * The endpoint shapes below are a Trello-style guess and are confirmed against the real
 * API at hour 4. Every function is isolated here so that change touches one file.
 */

export interface PulpCard {
  id: string;
  boardId: string;
  listId: string;
  title: string;
  url?: string;
}

function base(): string | null {
  return process.env.PULP_BASE_URL || null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const b = base();
  if (!b) throw new Error("PULP_NOT_CONFIGURED");
  const res = await fetch(`${b}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.PULP_TOKEN ?? ""}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`pulp ${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const pulp = {
  configured: () => !!base(),

  async listsOnBoard(boardId: string): Promise<Array<{ id: string; name: string }>> {
    return call("GET", `/boards/${boardId}/lists`);
  },

  async findListId(boardId: string, listName: string): Promise<string | null> {
    const lists = await this.listsOnBoard(boardId);
    return lists.find((l) => l.name.toLowerCase() === listName.toLowerCase())?.id ?? null;
  },

  async createCard(p: { boardId: string; listId: string; title: string; description: string; labels: string[]; assignee?: string | null; dueAt?: Date | null }): Promise<PulpCard> {
    return call("POST", `/cards`, {
      boardId: p.boardId, listId: p.listId, title: p.title, description: p.description,
      labels: p.labels, assignee: p.assignee ?? undefined, due: p.dueAt?.toISOString(),
    });
  },

  async moveCard(cardId: string, listId: string): Promise<void> {
    await call("PATCH", `/cards/${cardId}`, { listId });
  },

  async addComment(cardId: string, text: string): Promise<void> {
    await call("POST", `/cards/${cardId}/comments`, { text });
  },

  async getCard(cardId: string): Promise<PulpCard & { attachments?: Array<{ url: string; name?: string }> }> {
    return call("GET", `/cards/${cardId}`);
  },

  /** Used by the minute poll until Pulp's own "card moved" webhook exists. */
  async cardsUpdatedSince(since: Date): Promise<Array<PulpCard & { updatedAt: string }>> {
    return call("GET", `/cards?updatedSince=${encodeURIComponent(since.toISOString())}`);
  },
};
