import { db, now } from "./db.js";
import { decrypt, encrypt, maskSecret } from "./crypto.js";

/**
 * Real, token-based third-party connectors.
 *
 * Each connector validates the user-supplied credential against the real
 * upstream API before storing it (AES-256-GCM encrypted, same as providers
 * and GitHub). Nothing is simulated: a connector only reports "connected"
 * after a successful upstream validation, and the agent tools call the live
 * APIs. Tokens are never returned to the browser (only a masked hint).
 */

export type ConnectorId =
  "notion" | "drive" | "gdocs" | "gmail" | "linear" | "cal";

export type ConnectorDefinition = {
  id: ConnectorId;
  label: string;
  tokenLabel: string;
  help: string;
  /** Validates the token against the real API; returns an account label. */
  validate: (token: string) => Promise<string>;
};

type ConnectorRow = {
  id: string;
  credential_enc: string;
  config_json: string;
  updated_at: number;
};

async function upstream(
  url: string,
  init: RequestInit,
  label: string,
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(
      `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!response.ok) {
    const detail =
      body?.message ??
      body?.error?.message ??
      body?.error_description ??
      body?.raw ??
      "";
    throw new Error(
      `${label} rejected the credential (${response.status})${detail ? `: ${String(detail).slice(0, 200)}` : ""}`,
    );
  }
  return body;
}

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export const connectorDefinitions: ConnectorDefinition[] = [
  {
    id: "notion",
    label: "Notion",
    tokenLabel: "Notion integration token (ntn_… / secret_…)",
    help: "Create an internal integration at notion.so/my-integrations, share pages/databases with it, and paste its token.",
    validate: async (token) => {
      const me = await upstream(
        "https://api.notion.com/v1/users/me",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2022-06-28",
          },
        },
        "Notion",
      );
      return (
        me?.bot?.workspace_name ??
        me?.name ??
        me?.bot?.owner?.workspace?.name ??
        "Notion workspace"
      );
    },
  },
  {
    id: "drive",
    label: "Google Drive",
    tokenLabel: "Google OAuth access token (ya29.…)",
    help: "Use a Google OAuth access token with the drive.readonly (or drive) scope. Access tokens expire (~1h); re-connect to refresh.",
    validate: async (token) => {
      const about = await upstream(
        "https://www.googleapis.com/drive/v3/about?fields=user",
        { headers: bearer(token) },
        "Google Drive",
      );
      return (
        about?.user?.emailAddress ?? about?.user?.displayName ?? "Google Drive"
      );
    },
  },
  {
    id: "gdocs",
    label: "Google Docs",
    tokenLabel: "Google OAuth access token (ya29.…)",
    help: "Use a Google OAuth access token with documents/drive scopes. Docs are discovered through Drive (mimeType = Google Doc).",
    validate: async (token) => {
      const about = await upstream(
        "https://www.googleapis.com/drive/v3/about?fields=user",
        { headers: bearer(token) },
        "Google Docs",
      );
      return (
        about?.user?.emailAddress ?? about?.user?.displayName ?? "Google Docs"
      );
    },
  },
  {
    id: "gmail",
    label: "Gmail",
    tokenLabel: "Google OAuth access token (ya29.…)",
    help: "Use a Google OAuth access token with the gmail.readonly scope. Only message metadata/snippets are listed by the agent tool.",
    validate: async (token) => {
      const profile = await upstream(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        { headers: bearer(token) },
        "Gmail",
      );
      return profile?.emailAddress ?? "Gmail";
    },
  },
  {
    id: "linear",
    label: "Linear",
    tokenLabel: "Linear API key (lin_api_…)",
    help: "Create a personal API key in Linear → Settings → API and paste it here.",
    validate: async (token) => {
      const data = await upstream(
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "{ viewer { id name email organization { name } } }",
          }),
        },
        "Linear",
      );
      if (data?.errors?.length)
        throw new Error(
          `Linear rejected the credential: ${String(data.errors[0]?.message ?? "unknown error").slice(0, 200)}`,
        );
      return (
        data?.data?.viewer?.organization?.name ??
        data?.data?.viewer?.name ??
        "Linear workspace"
      );
    },
  },
  {
    id: "cal",
    label: "Calendar",
    tokenLabel: "Google OAuth access token (ya29.…)",
    help: "Connect your Google Calendar. Use a Google OAuth access token with the calendar.readonly scope.",
    validate: async (token) => {
      const list = await upstream(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
        { headers: bearer(token) },
        "Google Calendar",
      );
      return list?.items?.[0]?.summary ?? "Google Calendar";
    },
  },
];

export function connectorDefinition(id: string): ConnectorDefinition {
  const def = connectorDefinitions.find((d) => d.id === id);
  if (!def) throw new Error(`Unknown connector: ${id}`);
  return def;
}

function row(id: string): ConnectorRow | undefined {
  return db.prepare("SELECT * FROM connectors WHERE id=?").get(id) as
    ConnectorRow | undefined;
}

export function connectorSecret(id: ConnectorId): string {
  const stored = row(id);
  if (!stored?.credential_enc) return "";
  try {
    return decrypt(stored.credential_enc);
  } catch {
    return "";
  }
}

export function listConnectors() {
  return connectorDefinitions.map((def) => {
    const stored = row(def.id);
    const secret = stored ? connectorSecret(def.id) : "";
    let account = "";
    let validatedAt: number | null = null;
    try {
      const cfg = JSON.parse(stored?.config_json ?? "{}") as {
        account?: string;
        validatedAt?: number;
      };
      account = cfg.account ?? "";
      validatedAt = cfg.validatedAt ?? null;
    } catch {}
    return {
      id: def.id,
      label: def.label,
      tokenLabel: def.tokenLabel,
      help: def.help,
      connected: Boolean(secret),
      account,
      validatedAt,
      credentialMasked: secret ? maskSecret(secret) : "",
    };
  });
}

export async function connectConnector(id: string, token: string) {
  const def = connectorDefinition(id);
  const clean = token.trim();
  if (clean.length < 10)
    throw new Error(`${def.label} credential looks too short.`);
  const account = await def.validate(clean);
  db.prepare(
    "INSERT INTO connectors(id,credential_enc,config_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET credential_enc=excluded.credential_enc,config_json=excluded.config_json,updated_at=excluded.updated_at",
  ).run(
    def.id,
    encrypt(clean),
    JSON.stringify({ account, validatedAt: now() }),
    now(),
  );
  return listConnectors().find((c) => c.id === def.id);
}

export async function testConnector(id: string) {
  const def = connectorDefinition(id);
  const secret = connectorSecret(def.id);
  if (!secret) throw new Error(`${def.label} is not connected.`);
  const account = await def.validate(secret);
  db.prepare("UPDATE connectors SET config_json=?,updated_at=? WHERE id=?").run(
    JSON.stringify({ account, validatedAt: now() }),
    now(),
    def.id,
  );
  return { id: def.id, connected: true, account };
}

export function disconnectConnector(id: string) {
  const def = connectorDefinition(id);
  db.prepare("DELETE FROM connectors WHERE id=?").run(def.id);
  return { id: def.id, connected: false };
}

function requireSecret(id: ConnectorId): string {
  const secret = connectorSecret(id);
  if (!secret)
    throw new Error(
      `${connectorDefinition(id).label} is not connected. Ask the user to add a credential in Settings → Connectors.`,
    );
  return secret;
}

/* ------------------------- Agent-facing live calls ------------------------ */

export async function notionSearch(query: string) {
  const token = requireSecret("notion");
  const body = await upstream(
    "https://api.notion.com/v1/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: query.slice(0, 200), page_size: 10 }),
    },
    "Notion",
  );
  return {
    results: (body.results ?? []).map((r: any) => ({
      id: r.id,
      type: r.object,
      title:
        r.properties?.title?.title?.[0]?.plain_text ??
        r.properties?.Name?.title?.[0]?.plain_text ??
        r.child_page?.title ??
        "(untitled)",
      url: r.url ?? null,
      lastEdited: r.last_edited_time ?? null,
    })),
  };
}

export async function linearIssues(limit = 10) {
  const token = requireSecret("linear");
  const data = await upstream(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ issues(first: ${Math.min(Math.max(limit, 1), 25)}, orderBy: updatedAt) { nodes { identifier title state { name } updatedAt url assignee { name } } } }`,
      }),
    },
    "Linear",
  );
  if (data?.errors?.length)
    throw new Error(String(data.errors[0]?.message ?? "Linear query failed"));
  return { issues: data?.data?.issues?.nodes ?? [] };
}

export async function googleDriveSearch(id: "drive" | "gdocs", query: string) {
  const token = requireSecret(id);
  const mime =
    id === "gdocs"
      ? "mimeType='application/vnd.google-apps.document' and "
      : "";
  const q = encodeURIComponent(
    `${mime}name contains '${query.replace(/'/g, "")}' and trashed=false`,
  );
  const body = await upstream(
    `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=10&fields=files(id,name,mimeType,modifiedTime,webViewLink,size)`,
    { headers: bearer(token) },
    "Google Drive",
  );
  return { files: body.files ?? [] };
}

export async function gmailList(query = "", max = 10) {
  const token = requireSecret("gmail");
  const list = await upstream(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(Math.max(max, 1), 25)}${query ? `&q=${encodeURIComponent(query)}` : ""}`,
    { headers: bearer(token) },
    "Gmail",
  );
  const messages = [];
  for (const item of (list.messages ?? []).slice(0, 10)) {
    const detail = await upstream(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: bearer(token) },
      "Gmail",
    );
    const headers = Object.fromEntries(
      (detail.payload?.headers ?? []).map((h: any) => [
        String(h.name).toLowerCase(),
        h.value,
      ]),
    );
    messages.push({
      id: detail.id,
      subject: headers.subject ?? "(no subject)",
      from: headers.from ?? "",
      date: headers.date ?? "",
      snippet: detail.snippet ?? "",
    });
  }
  return {
    messages,
    resultSizeEstimate: list.resultSizeEstimate ?? messages.length,
  };
}

export async function googleCalendarEvents(max = 10) {
  const token = requireSecret("cal");
  const calendars = await upstream(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=10",
    { headers: bearer(token) },
    "Google Calendar",
  );
  const primary =
    (calendars.items ?? []).find((c: any) => c.primary) ??
    (calendars.items ?? [])[0];
  if (!primary) return { calendars: [], events: [] };
  const nowIso = new Date().toISOString();
  const events = await upstream(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primary.id)}/events?timeMin=${encodeURIComponent(nowIso)}&maxResults=${Math.min(Math.max(max, 1), 25)}&singleEvents=true&orderBy=startTime`,
    { headers: bearer(token) },
    "Google Calendar",
  );
  return {
    calendar: primary.summary ?? primary.id,
    events: (events.items ?? []).map((e: any) => ({
      id: e.id,
      title: e.summary ?? "(untitled event)",
      start: e.start?.dateTime ?? e.start?.date ?? null,
      end: e.end?.dateTime ?? e.end?.date ?? null,
      location: e.location ?? null,
      link: e.htmlLink ?? null,
    })),
  };
}
