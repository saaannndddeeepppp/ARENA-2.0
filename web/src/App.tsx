import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  CircleHelp,
  Code2,
  Copy,
  Columns2,
  Download,
  Github,
  Grip,
  MessageCircle,
  PencilLine,
  Swords,
  Trash2,
  File,
  FileImage,
  FileText,
  Folder,
  GitBranch,
  History,
  Landmark,
  Mic,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  PanelRight,
  PanelRightClose,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trophy,
  X,
  Zap,
  RotateCcw,
  Eye,
  Sparkles,
} from "lucide-react";
import {
  activityFiles,
  fileExtension,
  formatDuration,
  groupActivities,
  toolDisplayName,
} from "./activity";

type Session = {
  id: string;
  title: string;
  updated_at: number;
  status: string;
  total_cost_usd: number;
  total_tokens: number;
  pinned: number;
  archived?: number;
  model_provider?: string | null;
  model_id?: string | null;
  repo_full_name?: string | null;
  repo_branch?: string | null;
  repo_locked?: number;
};
type GithubRepo = {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  description?: string | null;
};
type PreviewInfo = {
  id: string;
  port: number;
  command: string;
  state: string;
  url: string;
  output: string;
  lastError?: string;
};
type Msg = {
  id: string;
  role: string;
  content: string;
  created_at: number;
  tool_calls_json?: string | null;
};
type Provider = {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  api_key_masked: string;
  models: Array<{
    id: string;
    displayName: string;
    contextWindow?: number;
    supportsTools: boolean;
    supportsVision: boolean;
    supportsReasoning: boolean;
    inputPricePer1M?: number;
    outputPricePer1M?: number;
  }>;
  models_fetched_at?: number | null;
  is_default: boolean;
  enabled: boolean;
};
type EventItem = { type: string; data: any; seq?: number };
type ToolItem = {
  callId: string;
  toolName: string;
  args: any;
  summary: string;
  status: string;
  result?: any;
  durationMs?: number;
};
const fmt = (n: number) =>
  n < 1000 ? `${n} tokens` : `${(n / 1000).toFixed(1)}k tokens`;
const ago = (value: number) => {
  const m = Math.floor((Date.now() - value) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const token = appToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    const raw = await response
      .clone()
      .text()
      .catch(() => "");
    try {
      const body = JSON.parse(raw) as { error?: string };
      if (body.error) message = body.error;
      else if (raw) message = `${message}: ${raw.slice(0, 200)}`;
    } catch {
      if (raw) message = `${message}: ${raw.slice(0, 200)}`;
    }
    throw new Error(message);
  }
  if (response.headers.get("content-type")?.includes("application/json"))
    return response.json() as Promise<T>;
  return response as unknown as T;
}
export const appToken = () => {
  try {
    return localStorage.getItem("galaxy-app-token") ?? "";
  } catch {
    return "";
  }
};
export const withToken = (url: string) => {
  const token = appToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
};
const connectorUi = [
  {
    id: "github",
    label: "GitHub",
    symbol: "\u25C9",
    description: "Work with repos, issues, and pull requests.",
  },
  {
    id: "drive",
    label: "Drive",
    symbol: "\u25B2",
    description: "Find and manage files in Google Drive.",
  },
  {
    id: "gdocs",
    label: "Docs",
    symbol: "\u25A3",
    description: "Create, read, and edit Google Docs.",
  },
  {
    id: "notion",
    label: "Notion",
    symbol: "N",
    description: "Look up your documents.",
  },
  {
    id: "gmail",
    label: "Gmail",
    symbol: "\u2709",
    description: "Connect your email account.",
  },
  {
    id: "linear",
    label: "Linear",
    symbol: "\u25CD",
    description: "Track issues, projects, and cycles.",
  },
  {
    id: "cal",
    label: "Calendar",
    symbol: "\u25A6",
    description: "Connect your Google Calendar.",
  },
] as const;

export type ChatMode = "agent" | "direct" | "side" | "battle";
export const MODE_META: Record<
  ChatMode,
  { label: string; short: string; description: string }
> = {
  battle: {
    label: "Battle Mode",
    short: "Battle",
    description: "Battle 2 anonymous models",
  },
  agent: {
    label: "Agent Mode",
    short: "Agent",
    description: "Built for complex tasks",
  },
  side: {
    label: "Side by Side",
    short: "Side by Side",
    description: "Compare 2 models of your choice",
  },
  direct: {
    label: "Direct",
    short: "Direct",
    description: "Chat with 1 model at a time",
  },
};
type ConnectorStatus = {
  id: string;
  label: string;
  tokenLabel: string;
  help: string;
  connected: boolean;
  account: string;
  validatedAt: number | null;
  credentialMasked: string;
};
function Waveform({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const peaksRef = useRef<number[]>([]);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = appToken();
        const res = await fetch(src, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error("audio fetch failed");
        const buffer = await res.arrayBuffer();
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const decoded = await new Ctx().decodeAudioData(buffer);
        const channel = decoded.getChannelData(0);
        const bars = 56;
        const peaks: number[] = [];
        const block = Math.max(1, Math.floor(channel.length / bars));
        for (let i = 0; i < bars; i++) {
          let max = 0;
          for (let j = 0; j < block; j += Math.max(1, Math.floor(block / 32)))
            max = Math.max(max, Math.abs(channel[i * block + j] ?? 0));
          peaks.push(max);
        }
        if (!cancelled) {
          peaksRef.current = peaks;
          draw(peaks, 0);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  const draw = (peaks: number[], ratio: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(document.documentElement);
    const played = styles.getPropertyValue("--accent").trim() || "#8a6d00";
    const rest = styles.getPropertyValue("--border-strong").trim() || "#c9c4b2";
    const barW = width / Math.max(peaks.length, 1);
    peaks.forEach((peak, i) => {
      const h = Math.max(3, peak * (height - 8));
      ctx.fillStyle = i / peaks.length <= ratio ? played : rest;
      ctx.beginPath();
      ctx.roundRect(
        i * barW + 1,
        (height - h) / 2,
        Math.max(2, barW - 2),
        h,
        2,
      );
      ctx.fill();
    });
  };
  if (failed)
    return (
      <div className="audio-viewer">
        <audio controls preload="metadata" src={src} />
      </div>
    );
  return (
    <div className="audio-viewer">
      <canvas
        ref={canvasRef}
        className="waveform"
        width={560}
        height={72}
        title="Audio waveform — click to seek"
        onClick={(e) => {
          const audio = audioRef.current;
          if (!audio?.duration) return;
          const rect = e.currentTarget.getBoundingClientRect();
          audio.currentTime =
            ((e.clientX - rect.left) / rect.width) * audio.duration;
        }}
      />
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={src}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          const r = a.duration ? a.currentTime / a.duration : 0;
          setProgress(r);
          draw(peaksRef.current, r);
        }}
      />
      <small className="muted">
        {Math.round(progress * 100)}% played · waveform rendered locally from
        the audio file
      </small>
    </div>
  );
}
const suggestions = [
  "Research a topic and create a cited report",
  "Build a responsive portfolio site in this workspace",
  "Analyze my files and summarize key findings",
  "Create a small Python tool and verify it",
];
const toolColors: Record<string, string> = {
  bash: "amber",
  read_file: "blue",
  write_file: "blue",
  edit_file: "blue",
  present_file: "purple",
  web_search: "green",
  fetch_page: "green",
  image_search: "green",
  generate_image: "purple",
  generate_speech: "purple",
  ask_user: "pink",
  todo_write: "gold",
  notion_search: "purple",
  linear_issues: "blue",
  google_drive_search: "green",
  google_docs_search: "blue",
  gmail_list: "pink",
  google_calendar_events: "green",
};

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [composer, setComposer] = useState("");
  const [running, setRunning] = useState(false);
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [workspace, setWorkspace] = useState<
    Array<{ path: string; size: number; kind: string }>
  >([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState("Workspace");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Session[]>([]);
  const [drop, setDrop] = useState(false);
  const [attachments, setAttachments] = useState<
    Array<{ name: string; path: string; size: number }>
  >([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [todos, setTodos] = useState<any[]>([]);
  const [pendingAsk, setPendingAsk] = useState<any>(null);
  const [approval, setApproval] = useState<any>(null);
  const [expandedTool, setExpandedTool] = useState("");
  const [cost, setCost] = useState({ turn: 0, total: 0, tokens: 0 });
  const [providerForm, setProviderForm] = useState({
    name: "OpenAI-compatible",
    kind: "custom-openai",
    base_url: "http://localhost:1234/v1",
    api_key: "",
  });
  const [modelMenu, setModelMenu] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>("agent");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectorsSheetOpen, setConnectorsSheetOpen] = useState(false);
  const [sessionMenuId, setSessionMenuId] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [expandedActivity, setExpandedActivity] = useState("");
  const [enabledConnectors, setEnabledConnectors] = useState<
    Record<string, boolean>
  >({});
  const [comparePickA, setComparePickA] = useState("");
  const [comparePickB, setComparePickB] = useState("");
  const [compareResult, setCompareResult] = useState<any>(null);
  const [reasoning, setReasoning] = useState("medium");
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [battleHistory, setBattleHistory] = useState<
    Array<{ winner: string; loser: string; at: number }>
  >(() => {
    try {
      return JSON.parse(localStorage.getItem("galaxy-battle-history") ?? "[]");
    } catch {
      return [];
    }
  });
  const [feedback, setFeedback] = useState<Record<string, "up" | "down">>(
    () => {
      try {
        return JSON.parse(localStorage.getItem("galaxy-feedback") ?? "{}");
      } catch {
        return {};
      }
    },
  );
  const [battlePick, setBattlePick] = useState(-1);
  const [battleRevealed, setBattleRevealed] = useState(false);
  const [settingsTab, setSettingsTab] = useState("Providers");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [github, setGithub] = useState<{
    connected: boolean;
    user?: { login: string };
    selectedRepos: string[];
    rateLimit?: { remaining: number; resetAt: number };
  }>({ connected: false, selectedRepos: [] });
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([]);
  const [githubToken, setGithubToken] = useState("");
  const [repoQuery, setRepoQuery] = useState("");
  const [repoToClone, setRepoToClone] = useState("");
  const [repoBranch, setRepoBranch] = useState("main");
  const [sessionRepo, setSessionRepo] = useState<any>(null);
  const [diffData, setDiffData] = useState<any>(null);
  const [diffFull, setDiffFull] = useState(false);
  const [previews, setPreviews] = useState<PreviewInfo[]>([]);
  const [previewReload, setPreviewReload] = useState(0);
  const [checksData, setChecksData] = useState<any>(null);
  const [previewDevice, setPreviewDevice] = useState("100%");
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("galaxy-theme") ?? "light";
    } catch {
      return "light";
    }
  });
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [connectorForms, setConnectorForms] = useState<Record<string, string>>(
    {},
  );
  const [metrics, setMetrics] = useState<any>(null);
  const [appTokenInput, setAppTokenInput] = useState(() => appToken());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const activeSession = sessions.find((s) => s.id === activeId);
  const selectedProvider =
    providers.find((p) => p.id === providerId) ??
    providers.find((p) => p.is_default);
  const selectedModel =
    selectedProvider?.models.find((m) => m.id === modelId) ??
    selectedProvider?.models[0];
  const refresh = useCallback(async () => {
    try {
      const [s, p, c] = await Promise.all([
        api<Session[]>("/api/sessions"),
        api<Provider[]>("/api/providers"),
        api<{ connectors: ConnectorStatus[] }>("/api/connectors").catch(() => ({
          connectors: [],
        })),
      ]);
      setSessions(s);
      setProviders(p);
      setConnectors(c.connectors ?? []);
      const def =
        p.find((x) => x.is_default) ?? p.find((x) => x.models.length > 0);
      if (def) {
        setProviderId((old) => old || def.id);
        setModelId((old) => old || def.models[0]?.id || "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const refreshGithub = useCallback(async () => {
    try {
      const status = await api<typeof github>("/api/github/status");
      setGithub(status);
      if (status.connected) {
        const repoData = await api<{ repositories: GithubRepo[] }>(
          "/api/github/repos",
        );
        setGithubRepos(repoData.repositories ?? []);
      } else setGithubRepos([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const loadSessionExtras = useCallback(async (id: string) => {
    const [repo, previewData] = await Promise.all([
      api<any>(`/api/sessions/${id}/github/status`).catch(() => null),
      api<{ previews: PreviewInfo[] }>(`/api/sessions/${id}/previews`).catch(
        () => ({ previews: [] }),
      ),
    ]);
    setSessionRepo(repo);
    setPreviews(previewData.previews ?? []);
    if (repo?.connected) {
      api<any>(`/api/sessions/${id}/diff`)
        .then(setDiffData)
        .catch(() => setDiffData(null));
      api<any>(`/api/sessions/${id}/checks`)
        .then(setChecksData)
        .catch(() => setChecksData(null));
    } else {
      setDiffData(null);
      setChecksData(null);
    }
  }, []);
  const loadSession = useCallback(
    async (id: string) => {
      try {
        const data = await api<any>(`/api/sessions/${id}`);
        setActiveId(id);
        setMessages(data.messages ?? []);
        setTools([]);
        setPendingAsk(data.pendingAsk ?? null);
        setRunning(data.runStatus === "running" && !data.pendingAsk);
        await loadWorkspace(id);
        await loadSessionExtras(id);
        if (esRef.current) esRef.current.close();
        const from = Number(sessionStorage.getItem(`seq:${id}`) || 0);
        const es = new EventSource(
          withToken(`/api/sessions/${id}/stream?fromSeq=${from}`),
        );
        esRef.current = es;
        const eventNames = [
          "session_joined",
          "run_started",
          "text_delta",
          "text_done",
          "tool_start",
          "tool_end",
          "file_changed",
          "artifact_present",
          "ask_user_request",
          "ask_user_answered",
          "todo_updated",
          "cost_update",
          "turn_end",
          "run_error",
          "run_stopped",
          "approval_required",
          "context_compacted",
          "provider_failover",
          "message_persisted",
          "resync_required",
          "preview_status",
          "diff_updated",
          "check_updated",
          "session_cleared",
        ];
        for (const name of eventNames)
          es.addEventListener(name, (raw) => {
            const ev = raw as MessageEvent;
            const data = JSON.parse(ev.data || "{}");
            const seq = Number(ev.lastEventId || 0);
            if (seq) sessionStorage.setItem(`seq:${id}`, String(seq));
            if (name === "run_started") setRunning(true);
            if (name === "text_delta") {
              setMessages((prev) => {
                const last = prev.at(-1);
                if (last?.role === "assistant" && last.id === "streaming")
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: last.content + data.delta },
                  ];
                return [
                  ...prev,
                  {
                    id: "streaming",
                    role: "assistant",
                    content: data.delta,
                    created_at: Date.now(),
                  },
                ];
              });
              if (follow)
                bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            }
            if (name === "text_done") {
              setMessages((prev) => {
                const last = prev.at(-1);
                if (last?.id === "streaming")
                  return [
                    ...prev.slice(0, -1),
                    { ...last, id: data.messageId },
                  ];
                return prev;
              });
            }
            if (name === "tool_start")
              setTools((prev) => [
                ...prev,
                {
                  callId: data.callId,
                  toolName: data.toolName,
                  args: data.args,
                  summary: data.summary,
                  status: "running",
                },
              ]);
            if (name === "tool_end") {
              setTools((prev) =>
                prev.map((t) =>
                  t.callId === data.callId
                    ? {
                        ...t,
                        status: data.status,
                        result: data.result,
                        durationMs: data.durationMs,
                      }
                    : t,
                ),
              );
              loadWorkspace(id);
              if (
                [
                  "git_commit",
                  "git_push",
                  "create_pull_request",
                  "merge_pull_request",
                ].includes(data.toolName)
              ) {
                api<any>(`/api/sessions/${id}/github/status`)
                  .then(setSessionRepo)
                  .catch(() => {});
                api<any>(
                  `/api/sessions/${id}/diff?full=${diffFull ? "1" : "0"}`,
                )
                  .then(setDiffData)
                  .catch(() => {});
              }
              if (
                [
                  "git_push",
                  "create_pull_request",
                  "merge_pull_request",
                  "get_check_runs",
                ].includes(data.toolName)
              )
                api<any>(`/api/sessions/${id}/checks`)
                  .then(setChecksData)
                  .catch(() => {});
            }
            if (name === "file_changed") {
              loadWorkspace(id);
              setPreviewReload((n) => n + 1);
              if (sessionRepo?.connected)
                api<any>(`/api/sessions/${id}/diff`)
                  .then(setDiffData)
                  .catch(() => {});
            }
            if (name === "preview_status") {
              setPreviewReload((n) => n + 1);
              api<{ previews: PreviewInfo[] }>(`/api/sessions/${id}/previews`)
                .then((v) => setPreviews(v.previews ?? []))
                .catch(() => {});
            }
            if (name === "diff_updated")
              api<any>(`/api/sessions/${id}/diff`)
                .then(setDiffData)
                .catch(() => {});
            if (name === "check_updated")
              api<any>(`/api/sessions/${id}/checks`)
                .then(setChecksData)
                .catch(() => {});
            if (name === "session_cleared") loadSession(id);
            if (name === "artifact_present") {
              // Never auto-open panels: just remember the file so it is
              // preselected if/when the user opens the Files tab. The
              // presented file is already a clickable card in the thread.
              setSelectedFile(data.path);
              loadWorkspace(id);
            }
            if (name === "ask_user_request") {
              setPendingAsk(data);
              setRunning(false);
            }
            if (name === "ask_user_answered") setPendingAsk(null);
            if (name === "todo_updated") setTodos(data.todos ?? []);
            if (name === "cost_update")
              setCost({
                turn: data.turnCostUsd ?? 0,
                total: data.sessionCostUsd ?? 0,
                tokens: (data.promptTokens ?? 0) + (data.completionTokens ?? 0),
              });
            if (name === "turn_end" || name === "run_stopped") {
              setRunning(false);
              refresh();
            }
            if (name === "run_error") {
              setRunning(false);
              setError(data.message ?? "The run stopped unexpectedly.");
            }
            if (name === "approval_required") setApproval(data);
            if (name === "provider_failover")
              setNotice(
                `Provider failover: switched to ${data.toProvider ?? "a fallback provider"}${data.model ? ` (${data.model})` : ""}.`,
              );
            if (name === "context_compacted")
              setNotice(
                `Context compacted: ${data.dropped} earlier message(s) summarised to fit the model budget.`,
              );
            if (name === "resync_required") loadSession(id);
          });
        es.onerror = () => {};
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [follow, refresh, loadSessionExtras, sessionRepo?.connected, diffFull],
  );
  const loadWorkspace = async (id: string) => {
    try {
      const data = await api<{ files: any[] }>(`/api/sessions/${id}/workspace`);
      setWorkspace(data.files);
    } catch {
      setWorkspace([]);
    }
  };
  const openFile = async (id: string, path: string) => {
    try {
      const token = appToken();
      const response = await fetch(
        `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!response.ok) throw new Error("Unable to open that workspace file.");
      const type = response.headers.get("content-type") ?? "";
      if (type.startsWith("image/") || type.startsWith("audio/"))
        setFileContent(
          withToken(
            `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`,
          ),
        );
      else setFileContent(await response.text());
      setSelectedFile(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refresh();
    void refreshGithub();
    return () => esRef.current?.close();
  }, [refresh, refreshGithub]);
  useEffect(() => {
    if (activeId) setFollow(true);
  }, [activeId]);
  useEffect(() => {
    if (!activeId || !sessionRepo?.connected) return;
    const timer = window.setInterval(() => {
      api<any>(`/api/sessions/${activeId}/checks`)
        .then(setChecksData)
        .catch(() => {});
    }, 20000);
    return () => window.clearInterval(timer);
  }, [activeId, sessionRepo?.connected]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("galaxy-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    if (!settingsOpen || settingsTab !== "Advanced") return;
    const load = () =>
      api<any>("/api/metrics")
        .then(setMetrics)
        .catch(() => setMetrics(null));
    void load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [settingsOpen, settingsTab]);
  useEffect(() => {
    const ready = previews.filter((x) => x.state === "ready");
    if (ready.length && !ready.some((x) => x.port === previewPort))
      setPreviewPort(ready[0]!.port);
  }, [previews, previewPort]);
  useEffect(() => {
    if (search.trim().length > 1) {
      api<any>(`/api/history/search?q=${encodeURIComponent(search)}`)
        .then((r) => setSearchResults(r.results ?? []))
        .catch(() => setSearchResults([]));
    } else setSearchResults([]);
  }, [search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandQuery("");
        setCommandOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setNotice(
          "Commands: /new /clear /model /provider /settings /cost /export /workspace /diff /preview /checks /download-workspace. Shortcuts: Ctrl/⌘+N new · Ctrl/⌘+K palette · Ctrl/⌘+S download · Ctrl/⌘+Enter send · Esc stop/close",
        );
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && activeId) {
        e.preventDefault();
        window.location.assign(`/api/sessions/${activeId}/download-workspace`);
      }
      if (
        e.key === "ArrowUp" &&
        e.target instanceof HTMLTextAreaElement &&
        !e.target.value &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        const previous = messages
          .filter((message) => message.role === "user")
          .at(-1);
        if (previous) {
          e.preventDefault();
          setComposer(previous.content);
        }
      }
      if (e.key === "Escape") {
        if (commandOpen) setCommandOpen(false);
        else if (leaderboardOpen) setLeaderboardOpen(false);
        else if (connectorsSheetOpen) setConnectorsSheetOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (modeMenuOpen) setModeMenuOpen(false);
        else if (connectionsOpen) setConnectionsOpen(false);
        else if (running) void stop();
        else if (modelMenu) setModelMenu(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const newChat = async () => {
    setMobileMenu(false);
    try {
      const s = await api<Session>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refresh();
      setMessages([]);
      setTools([]);
      setActiveId(s.id);
      setSelectedFile("");
      setRightOpen(false);
      setRightTab("Workspace");
      setComposer("");
      setTimeout(() => inputRef.current?.focus(), 50);
      await loadSession(s.id);
    } catch (e) {
      setError(String(e));
    }
  };
  const recordBattle = (side: number, result: any) => {
    if (!result) return;
    const winner = side === 0 ? result.a : result.b;
    const loser = side === 0 ? result.b : result.a;
    if (!winner?.ok || !loser) return;
    const entry = {
      winner: `${winner.providerName} · ${winner.model}`,
      loser: `${loser.providerName ?? ""} · ${loser.model ?? ""}`,
      at: Date.now(),
    };
    setBattleHistory((old) => {
      const next = [...old, entry].slice(-500);
      try {
        localStorage.setItem("galaxy-battle-history", JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const recordFeedback = (messageId: string, value: "up" | "down") => {
    setFeedback((old) => {
      const next = { ...old };
      if (next[messageId] === value) delete next[messageId];
      else next[messageId] = value;
      try {
        localStorage.setItem("galaxy-feedback", JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    } catch {
      setError("Clipboard is not available in this browser context.");
    }
  };
  const send = async (rawText?: string) => {
    const source = (rawText ?? composer).trim();
    if (!source || running) return;
    setModeMenuOpen(false);
    setConnectionsOpen(false);
    setModelMenu(false);
    setSessionMenuId("");
    let id = activeId;
    if (!id) {
      const s = await api<Session>("/api/sessions", {
        method: "POST",
        body: "{}",
      });
      id = s.id;
      setActiveId(id);
    }
    let text = source;
    if (!rawText && attachments.length)
      text += `\n\nAttached files in workspace: ${attachments.map((a) => a.path).join(", ")}`;
    setComposer("");
    setError("");
    const user: Msg = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      created_at: Date.now(),
    };
    setMessages((m) => [...m, user]);
    try {
      if (!rawText && attachments.length) {
        for (const a of attachments)
          text += `\n[Attachment: ${a.name} at ${a.path}]`;
      }
      if (chatMode === "side" || chatMode === "battle") {
        setAttachments([]);
        await runCompare(id, text);
        return;
      }
      await api(`/api/sessions/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: text,
          providerId: providerId || selectedProvider?.id,
          modelId: modelId || selectedModel?.id,
          reasoning,
          mode: chatMode === "direct" ? "direct" : "agent",
        }),
      });
      setAttachments([]);
      setRunning(true);
      if (!esRef.current || activeId !== id) await loadSession(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  };
  const stop = async () => {
    if (activeId)
      await api(`/api/sessions/${activeId}/stop`, { method: "POST" }).catch(
        () => {},
      );
    setRunning(false);
  };
  const resumeSession = async () => {
    if (!activeId) return;
    try {
      await api(`/api/sessions/${activeId}/resume`, {
        method: "POST",
        body: "{}",
      });
      setRunning(true);
      await loadSession(activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const upload = async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    let id = activeId;
    if (!id) {
      const created = await api<Session>("/api/sessions", {
        method: "POST",
        body: "{}",
      });
      id = created.id;
      setActiveId(id);
      await loadSession(id);
    }
    setNotice(
      `Uploading ${incoming.length} file${incoming.length === 1 ? "" : "s"}…`,
    );
    try {
      // Files above 6 MB go through the chunked endpoint (4 MB chunks,
      // assembled + magic-byte validated on the server, with progress).
      const large = incoming.filter((f) => f.size > 6 * 1024 * 1024);
      const uploadedFiles: Array<{ name: string; path: string; size: number }> =
        [];
      for (const file of large) {
        const uploadId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const chunkSize = 4 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);
        for (let index = 0; index < totalChunks; index++) {
          const form = new FormData();
          form.append("uploadId", uploadId);
          form.append("fileName", file.name);
          form.append("chunkIndex", String(index));
          form.append("totalChunks", String(totalChunks));
          form.append(
            "files",
            file.slice(index * chunkSize, (index + 1) * chunkSize),
            file.name,
          );
          const token = appToken();
          const response = await fetch(`/api/sessions/${id}/upload/chunk`, {
            method: "POST",
            body: form,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!response.ok) {
            let message = `Upload failed (${response.status}).`;
            try {
              message = (await response.json()).error ?? message;
            } catch {}
            throw new Error(message);
          }
          const result = await response.json();
          setNotice(
            `Uploading ${file.name} — ${index + 1}/${totalChunks} chunks…`,
          );
          if (result.complete) uploadedFiles.push(...(result.files ?? []));
        }
      }
      const small = incoming.filter((f) => f.size <= 6 * 1024 * 1024);
      if (!small.length) {
        setAttachments((prev) => [...prev, ...uploadedFiles]);
        await loadWorkspace(id);
        setNotice(`${uploadedFiles.length} large file(s) uploaded in chunks.`);
        return;
      }
      const form = new FormData();
      small.forEach((file) => form.append("files", file));
      const token = appToken();
      const response = await fetch(`/api/sessions/${id}/upload`, {
        method: "POST",
        body: form,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        let message = `Upload failed (${response.status}).`;
        try {
          message = (await response.json()).error ?? message;
        } catch {}
        throw new Error(message);
      }
      const data = await response.json();
      setAttachments((prev) => [
        ...prev,
        ...uploadedFiles,
        ...data.files.map((file: any) => ({
          name: file.name,
          path: file.path,
          size: file.size,
        })),
      ]);
      await loadWorkspace(id);
      setNotice(
        `${data.files.length + uploadedFiles.length} file${data.files.length + uploadedFiles.length === 1 ? "" : "s"} uploaded.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNotice("");
    }
  };
  const saveProvider = async () => {
    try {
      const response = await api<any>("/api/providers", {
        method: "POST",
        body: JSON.stringify(providerForm),
      });
      await api(`/api/providers/${response.provider.id}/default`, {
        method: "POST",
      });
      let fetched: any;
      try {
        fetched = await api<any>(
          `/api/providers/${response.provider.id}/refresh-models`,
          { method: "POST" },
        );
      } catch (fetchError) {
        // The provider itself is saved and set as default — only the live
        // catalog fetch failed. Say so, instead of looking like the whole
        // connect step failed (which made users create duplicates).
        await refresh();
        setProviderId(response.provider.id);
        setError(
          `Provider saved, but models could not be fetched. ${
            fetchError instanceof Error
              ? fetchError.message
              : String(fetchError)
          }`,
        );
        return;
      }
      setNotice(
        `Connected. ${fetched.models.length} models fetched from the live catalog.`,
      );
      setProviderForm({
        name: "OpenAI-compatible",
        kind: "custom-openai",
        base_url: "http://localhost:1234/v1",
        api_key: "",
      });
      await refresh();
      setProviderId(response.provider.id);
      setModelId(fetched.models[0]?.id ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const newProviderRefresh = async (id: string) => {
    try {
      const result = await api<any>(`/api/providers/${id}/refresh-models`, {
        method: "POST",
      });
      setNotice(`${result.models.length} models fetched from the provider.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const connectGithub = async () => {
    try {
      await api("/api/github/connect", {
        method: "POST",
        body: JSON.stringify({ token: githubToken }),
      });
      setGithubToken("");
      await refreshGithub();
      setNotice("GitHub token validated and encrypted in local storage.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const startDictation = () => {
    const Ctor =
      (
        window as unknown as {
          SpeechRecognition?: any;
          webkitSpeechRecognition?: any;
        }
      ).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: any })
        .webkitSpeechRecognition;
    if (!Ctor) {
      setNotice(
        "Voice input is not supported in this browser. Type your prompt instead.",
      );
      return;
    }
    try {
      const recognition = new Ctor();
      recognition.lang = navigator.language || "en-US";
      recognition.interimResults = false;
      recognition.onresult = (event: any) => {
        const transcript = String(event.results?.[0]?.[0]?.transcript ?? "");
        if (transcript)
          setComposer((old) => (old ? `${old} ${transcript}` : transcript));
      };
      recognition.onerror = () =>
        setNotice(
          "Voice input stopped. Check microphone permission and try again.",
        );
      recognition.start();
      setNotice("Listening… speak now.");
    } catch {
      setNotice("Voice input could not be started in this browser.");
    }
  };
  const connectConnector = async (connectorId: string) => {
    const token = (connectorForms[connectorId] ?? "").trim();
    if (!token) return;
    try {
      await api(`/api/connectors/${connectorId}/connect`, {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setConnectorForms((old) => ({ ...old, [connectorId]: "" }));
      await refresh();
      setNotice(
        "Connector validated against the live service and stored encrypted.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const disconnectConnector = async (connectorId: string) => {
    try {
      await api(`/api/connectors/${connectorId}`, { method: "DELETE" });
      await refresh();
      setNotice("Connector disconnected and its credential removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const testConnector = async (connectorId: string) => {
    try {
      const result = await api<any>(`/api/connectors/${connectorId}/test`, {
        method: "POST",
        body: "{}",
      });
      await refresh();
      setNotice(`${result.id}: connected as ${result.account}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const toggleRepo = async (fullName: string, checked: boolean) => {
    const selected = new Set(github.selectedRepos);
    if (checked) selected.add(fullName);
    else selected.delete(fullName);
    try {
      const result = await api<{ selectedRepos: string[] }>(
        "/api/github/repos",
        {
          method: "PUT",
          body: JSON.stringify({ selectedRepos: [...selected] }),
        },
      );
      setGithub((old) => ({ ...old, selectedRepos: result.selectedRepos }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const cloneSelectedRepo = async (repoName: string, branch: string) => {
    try {
      let id = activeId;
      if (!id) {
        const created = await api<Session>("/api/sessions", {
          method: "POST",
          body: "{}",
        });
        id = created.id;
        setActiveId(id);
        await refresh();
      }
      const result = await api<any>(`/api/sessions/${id}/github/clone`, {
        method: "POST",
        body: JSON.stringify({ repo: repoName, baseBranch: branch || "main" }),
      });
      await loadSession(id);
      setRightOpen(true);
      setRightTab("Diff");
      setNotice(`Cloned ${result.repo} on ${result.branch}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const disconnectGithub = async () => {
    try {
      await api("/api/github/connect", { method: "DELETE" });
      await refreshGithub();
      setNotice(
        "GitHub token removed. Saved repository selections are preserved.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const submitAsk = async (answer: string) => {
    if (!activeId || !pendingAsk) return;
    await api(`/api/sessions/${activeId}/answer`, {
      method: "POST",
      body: JSON.stringify({ callId: pendingAsk.callId, answer }),
    });
    setPendingAsk(null);
    setRunning(true);
  };
  const respondApproval = async (approved: boolean) => {
    if (!approval) return;
    await api(`/api/approvals/${approval.approvalId}`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
    setApproval(null);
  };
  const handleSlash = (value: string) => {
    const [cmd, ...args] = value.trim().split(/\s+/);
    if (cmd === "/new") {
      void newChat();
      return true;
    }
    if (cmd === "/settings") {
      setSettingsOpen(true);
      return true;
    }
    if (cmd === "/help") {
      setNotice(
        "Commands: /new /clear /model /provider /settings /cost /export /workspace /diff /preview /checks /download-workspace. Shortcuts: Ctrl/⌘+N new · Ctrl/⌘+K palette · Ctrl/⌘+/ help · Ctrl/⌘+S download · Ctrl/⌘+Enter send · Shift+Tab panels · Esc stop/close",
      );
      return true;
    }
    if (cmd === "/stop") {
      void stop();
      return true;
    }
    if (cmd === "/clear" && activeId) {
      if (
        window.confirm(
          "Clear this session's conversation, tool history, and cost ledger? Workspace files will be kept.",
        )
      )
        void api(`/api/sessions/${activeId}/messages`, { method: "DELETE" })
          .then(() => loadSession(activeId))
          .then(() =>
            setNotice("Conversation cleared. Workspace files were kept."),
          )
          .catch((e) => setError(String(e)));
      return true;
    }
    if (cmd === "/download-workspace" && activeId) {
      window.location.href = `/api/sessions/${activeId}/download-workspace`;
      return true;
    }
    if (cmd === "/workspace") {
      setRightOpen(true);
      setRightTab("Workspace");
      return true;
    }
    if (cmd === "/files") {
      setRightOpen(true);
      setRightTab("Files");
      return true;
    }
    if (cmd === "/provider") {
      if (args[0]) {
        const match = providers.find(
          (p) =>
            p.id === args[0] || p.name.toLowerCase() === args[0]!.toLowerCase(),
        );
        if (match) {
          setProviderId(match.id);
          setModelId(match.models[0]?.id ?? "");
          setNotice(`Selected ${match.name}.`);
        } else setNotice(`No configured provider named ${args[0]}.`);
        return true;
      }
      setSettingsOpen(true);
      setSettingsTab("Providers");
      return true;
    }
    if (cmd === "/model" && args[0]) {
      const [p, m] = args[0].split("/");
      const match = providers.find(
        (v) => v.id === p || v.name.toLowerCase() === p?.toLowerCase(),
      );
      if (match) {
        setProviderId(match.id);
        if (m) setModelId(m);
        else setModelId(match.models[0]?.id ?? "");
      }
      return true;
    }
    if (cmd === "/export" && activeId) {
      window.open(`/api/sessions/${activeId}/export`, "_blank");
      return true;
    }
    if (cmd === "/cost" && activeId) {
      void api<any>(`/api/sessions/${activeId}/costs`)
        .then((data) =>
          setNotice(
            `Session total: $${Number(data.totalCostUsd).toFixed(4)} · ${fmt(Number(data.totalTokens))} · ${data.turns.length} provider calls`,
          ),
        )
        .catch((e) => setError(String(e)));
      return true;
    }
    if (["/diff", "/preview", "/checks"].includes(cmd ?? "")) {
      setRightOpen(true);
      setRightTab(
        cmd === "/diff" ? "Diff" : cmd === "/preview" ? "Preview" : "Checks",
      );
      return true;
    }
    return false;
  };
  const submit = () => {
    if (composer.trim().startsWith("/") && handleSlash(composer.trim())) {
      setComposer("");
      return;
    }
    void send();
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrop(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  };
  const removeSession = async (id: string) => {
    if (!window.confirm("Delete this conversation and its local workspace?"))
      return;
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
    }
    await refresh();
  };
  const renameSession = async (s: Session) => {
    const title = window.prompt("Rename conversation", s.title);
    if (title?.trim()) {
      await api(`/api/sessions/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      await refresh();
    }
  };
  const modelOptions = providers.flatMap((p) =>
    p.models.map((m) => ({
      key: `${p.id}::${m.id}`,
      label: `${p.name} · ${m.displayName}`,
      providerId: p.id,
      modelId: m.id,
    })),
  );
  const effPickA = comparePickA || modelOptions[0]?.key || "";
  const effPickB =
    comparePickB ||
    modelOptions.find((o) => o.key !== effPickA)?.key ||
    modelOptions[0]?.key ||
    "";
  const runCompare = async (id: string, text: string) => {
    const parse = (key: string) => {
      const [pid, mid] = key.split("::");
      return { providerId: pid, modelId: mid };
    };
    let aKey = effPickA;
    let bKey = effPickB;
    if (chatMode === "battle") {
      const pool = [...modelOptions];
      if (pool.length >= 2) {
        const i = Math.floor(Math.random() * pool.length);
        let j = Math.floor(Math.random() * (pool.length - 1));
        if (j >= i) j += 1;
        aKey = pool[i]?.key ?? "";
        bKey = pool[j]?.key ?? "";
      }
    }
    if (!aKey || !bKey || aKey === bKey) {
      setError(
        "Add at least two models (Settings → Providers) to compare models.",
      );
      return;
    }
    setRunning(true);
    setCompareResult(null);
    setBattlePick(-1);
    setBattleRevealed(false);
    try {
      const result = await api<any>(`/api/sessions/${id}/compare`, {
        method: "POST",
        body: JSON.stringify({ content: text, a: parse(aKey), b: parse(bKey) }),
      });
      setCompareResult(result);
      await loadSession(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };
  const archiveSession = async (session: Session) => {
    await api(`/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    }).catch((e) => setError(String(e)));
    setSessionMenuId("");
    if (activeId === session.id) {
      setActiveId(null);
      setMessages([]);
    }
    await refresh();
  };
  const saveRename = async (session: Session) => {
    const title = renameValue.trim();
    setRenamingId("");
    if (!title || title === session.title) return;
    await api(`/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }).catch((e) => setError(String(e)));
    await refresh();
  };
  const connectorEnabled = (connectorId: string) =>
    enabledConnectors[connectorId] ?? connectorConnected(connectorId);
  const toggleConnectorEnabled = (connectorId: string) =>
    setEnabledConnectors((old) => ({
      ...old,
      [connectorId]: !(old[connectorId] ?? connectorConnected(connectorId)),
    }));
  const openConnectorSettings = () => {
    setConnectionsOpen(false);
    setConnectorsSheetOpen(false);
    setSettingsOpen(true);
    setSettingsTab("Connectors");
  };
  const searchList = search.trim() ? searchResults : sessions;
  const grouped = useMemo(() => {
    const groups: Record<string, Session[]> = {
      Today: [],
      Yesterday: [],
      "Previous 7 days": [],
      Older: [],
    };
    const nowDate = new Date();
    for (const s of searchList) {
      const age = (Date.now() - s.updated_at) / 86400000;
      const group =
        age < 1
          ? "Today"
          : age < 2
            ? "Yesterday"
            : age < 7
              ? "Previous 7 days"
              : "Older";
      groups[group]?.push(s);
    }
    return groups;
  }, [searchList]);
  const fileUrl =
    selectedFile && activeId
      ? withToken(
          `/api/sessions/${activeId}/file?path=${encodeURIComponent(selectedFile)}`,
        )
      : "";
  const isHome = !activeId && messages.length === 0 && !running;
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");
  const selectedPreview =
    previews.find((x) => x.state === "ready" && x.port === previewPort) ??
    previews.find((x) => x.state === "ready");
  const connectorConnected = (connectorId: string) =>
    connectorId === "github"
      ? github.connected
      : Boolean(connectors.find((c) => c.id === connectorId)?.connected);
  const paletteItems = [
    {
      label: "New chat",
      detail: "Create a new session",
      run: () => void newChat(),
    },
    {
      label: "Settings",
      detail: "Providers, GitHub, data and appearance",
      run: () => setSettingsOpen(true),
    },
    {
      label: "Workspace",
      detail: "Open the workspace tree",
      run: () => {
        setRightOpen(true);
        setRightTab("Workspace");
      },
    },
    {
      label: "Diff",
      detail: "Inspect repository changes",
      run: () => {
        setRightOpen(true);
        setRightTab("Diff");
      },
    },
    {
      label: "Preview",
      detail: "Open the local app preview",
      run: () => {
        setRightOpen(true);
        setRightTab("Preview");
      },
    },
    {
      label: "Checks",
      detail: "Inspect GitHub CI checks",
      run: () => {
        setRightOpen(true);
        setRightTab("Checks");
      },
    },
    {
      label: "Files",
      detail: "Open the artifact viewer",
      run: () => {
        setRightOpen(true);
        setRightTab("Files");
      },
    },
    {
      label: "Download workspace",
      detail: "Export workspace as ZIP",
      run: () => {
        if (activeId)
          window.location.assign(
            `/api/sessions/${activeId}/download-workspace`,
          );
      },
    },
    {
      label: "Export conversation",
      detail: "Download current chat as Markdown",
      run: () => {
        if (activeId) window.open(`/api/sessions/${activeId}/export`, "_blank");
      },
    },
    {
      label: "Stop run",
      detail: "Abort the active run",
      run: () => void stop(),
    },
  ].filter((item) =>
    `${item.label} ${item.detail}`
      .toLowerCase()
      .includes(commandQuery.toLowerCase()),
  );
  return (
    <div
      className={`app ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}${isHome ? " home" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDrop(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onPaste={(e) => {
        const files = e.clipboardData.files;
        if (files.length) {
          e.preventDefault();
          void upload(files);
        }
      }}
    >
      {drop && (
        <div className="drop-overlay" onDragLeave={() => setDrop(false)}>
          <div>
            <Paperclip size={28} />
            <h2>Drop files to attach</h2>
            <p>Files stay in this local workspace.</p>
          </div>
        </div>
      )}
      {mobileMenu && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? "mobile-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark">
            <span className="brand-pill">G</span>
            <span className="brand-name">galaxy</span>
          </div>
          <span className="brand-row-actions">
            <button
              className="icon-btn sidebar-close-mobile"
              title="Close sidebar"
              onClick={() => setMobileMenu(false)}
            >
              <X size={17} />
            </button>
            <button
              className="icon-btn sidebar-toggle"
              title="Close sidebar"
              onClick={() => {
                setSidebarOpen((v) => !v);
                setMobileMenu(false);
              }}
            >
              <PanelRightClose size={17} />
            </button>
          </span>
        </div>
        <button className="new-chat" onClick={() => void newChat()}>
          <MessageSquarePlus size={17} />
          <span>New chat</span>
          <kbd>⌘ N</kbd>
        </button>
        <label className="search-box">
          <Search size={15} />
          <input
            placeholder="Search conversations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
        <div className="history-scroll">
          {Object.entries(grouped).map(
            ([group, list]) =>
              list.length > 0 && (
                <section className="history-group" key={group}>
                  <div className="group-label">{group}</div>
                  {list.map((s) => (
                    <div
                      key={s.id}
                      className={`history-item ${activeId === s.id ? "selected" : ""}`}
                      onClick={() => {
                        void loadSession(s.id);
                        setMobileMenu(false);
                      }}
                    >
                      <span
                        className={`status-dot ${s.status === "running" ? "running" : ""}`}
                      />
                      {renamingId === s.id ? (
                        <input
                          className="rename-input"
                          autoFocus
                          value={renameValue}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => void saveRename(s)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveRename(s);
                            if (e.key === "Escape") setRenamingId("");
                          }}
                        />
                      ) : (
                        <span className="history-title">{s.title}</span>
                      )}
                      <span className="history-time">{ago(s.updated_at)}</span>
                      <button
                        className="history-more"
                        title="Conversation options"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSessionMenuId(sessionMenuId === s.id ? "" : s.id);
                        }}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {sessionMenuId === s.id && (
                        <div
                          className="session-menu"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => {
                              setRenamingId(s.id);
                              setRenameValue(s.title);
                              setSessionMenuId("");
                            }}
                          >
                            <PencilLine size={14} /> Rename
                          </button>
                          <button
                            className="danger"
                            onClick={() => void archiveSession(s)}
                          >
                            <Archive size={14} /> Archive
                          </button>
                          <button
                            className="danger"
                            onClick={() => void removeSession(s.id)}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              ),
          )}
          {search.trim() && searchResults.length === 0 && (
            <p className="muted small pad">No matching conversations</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="mode-selector-wrap">
            <button
              className="mode-selector"
              aria-label="Mode"
              onClick={() => setModeMenuOpen((v) => !v)}
            >
              <Zap size={15} />
              <span>{MODE_META[chatMode].short}</span>
              <ChevronDown size={13} />
            </button>
            {modeMenuOpen && (
              <ModeMenu
                mode={chatMode}
                onSelect={(m) => {
                  setChatMode(m);
                  setModeMenuOpen(false);
                }}
              />
            )}
          </div>
          <button
            className="sidebar-setting"
            onClick={() => {
              setLeaderboardOpen(true);
              setMobileMenu(false);
            }}
          >
            <BarChart3 size={16} /> <span>Leaderboard</span>
            <span className="new-badge">New</span>
          </button>
          <button
            className="sidebar-setting"
            onClick={() => {
              setSettingsOpen(true);
              setMobileMenu(false);
            }}
          >
            <Settings size={16} /> <span>Settings</span>
          </button>
          <div className="local-tag">
            <span />
            Local workspace
          </div>
        </div>
      </aside>
      {!sidebarOpen && (
        <button
          className="sidebar-reopen-floating"
          title="Open sidebar"
          onClick={() => setSidebarOpen(true)}
        >
          <PanelRight size={17} />
        </button>
      )}
      <main
        className="main-column"
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 90);
        }}
      >
        {!isHome && (
          <header className="topbar">
            <button
              className="icon-btn mobile-menu"
              onClick={() => setMobileMenu((v) => !v)}
            >
              <Menu size={18} />
            </button>
            <div className="topbar-left">
              <button
                className="icon-btn small-icon"
                onClick={() => void newChat()}
                title="New chat"
              >
                <Plus size={17} />
              </button>
              <span className="crumb">Agent</span>
              {activeSession && (
                <>
                  <ChevronRight size={14} className="dim" />
                  <button
                    className="session-name"
                    onClick={() => void renameSession(activeSession)}
                  >
                    {activeSession.title}
                  </button>
                  {sessionRepo?.connected && (
                    <span className="repo-pill">
                      <GitBranch size={12} />
                      {sessionRepo.repo} · {sessionRepo.branch}
                      {sessionRepo.locked ? " · locked" : ""}
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="topbar-actions">
              <span className="local-indicator">
                <span />
                Local
              </span>
              <button
                className="icon-btn"
                onClick={() => setRightOpen((v) => !v)}
                title="Toggle workspace"
              >
                <PanelRight size={17} />
              </button>
              <button
                className="icon-btn"
                onClick={() => setSettingsOpen(true)}
                title="Settings"
              >
                <Settings size={17} />
              </button>
            </div>
          </header>
        )}
        <div className="thread" ref={scrollRef}>
          {activeSession &&
            ["interrupted", "error"].includes(activeSession.status) && (
              <div className="resume-banner">
                <div>
                  <b>
                    {activeSession.status === "interrupted"
                      ? "This run was interrupted"
                      : "This run ended with an error"}
                  </b>
                  <small>
                    Conversation and workspace are saved. Resume with the
                    selected model.
                  </small>
                </div>
                <button
                  className="outline-btn"
                  onClick={() => void resumeSession()}
                >
                  <RotateCcw size={13} /> Resume
                </button>
              </div>
            )}
          {messages.length === 0 && !running ? (
            <div className="empty-state">
              <div className="intro-brand">
                <div className="galaxy-logo" aria-label="Galaxy">
                  <Landmark size={25} strokeWidth={1.7} />
                  <span>Galaxy</span>
                </div>
                <h1 className="intro-title">
                  Experience the <em>frontier</em>
                </h1>
              </div>
              <div className="empty-composer">
                <textarea
                  ref={inputRef}
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder="Ask anything..."
                  rows={3}
                />
                <div className="composer-tools">
                  <button
                    className="icon-btn attach-btn"
                    title="Connections and files"
                    onClick={() => setConnectionsOpen((v) => !v)}
                  >
                    <span className="grid-plus">
                      <Grip size={17} />
                      <Plus size={9} />
                    </span>
                  </button>
                  <div className="mode-pill-wrap">
                    <button
                      className="agent-pill"
                      onClick={() => setModeMenuOpen((v) => !v)}
                    >
                      {chatMode === "battle" ? (
                        <Swords size={13} />
                      ) : chatMode === "side" ? (
                        <Columns2 size={13} />
                      ) : chatMode === "direct" ? (
                        <MessageCircle size={13} />
                      ) : (
                        <Zap size={13} />
                      )}{" "}
                      {MODE_META[chatMode].short} <ChevronDown size={12} />
                    </button>
                    {modeMenuOpen && (
                      <ModeMenu
                        mode={chatMode}
                        onSelect={(m) => {
                          setChatMode(m);
                          setModeMenuOpen(false);
                        }}
                      />
                    )}
                  </div>
                  <div className="composer-spacer" />
                  <button
                    className="model-button"
                    onClick={() => setModelMenu((v) => !v)}
                  >
                    <span className="provider-dot" />
                    {selectedProvider?.name ?? "Choose provider"}
                    {selectedModel ? ` · ${selectedModel.displayName}` : ""}
                    <ChevronDown size={12} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Voice input"
                    onClick={startDictation}
                  >
                    <Mic size={16} />
                  </button>
                  <button
                    className="send-btn"
                    onClick={submit}
                    disabled={!composer.trim()}
                    title="Send"
                  >
                    <ArrowUp size={18} />
                  </button>
                </div>
                {connectionsOpen && (
                  <ConnectionsPopover
                    isConnected={connectorConnected}
                    isEnabled={connectorEnabled}
                    onToggle={toggleConnectorEnabled}
                    onConnect={openConnectorSettings}
                    onViewAll={() => setConnectorsSheetOpen(true)}
                    onAddFiles={() =>
                      document.getElementById("file-input")?.click()
                    }
                    onClose={() => setConnectionsOpen(false)}
                  />
                )}
                {modelMenu && (
                  <ModelPicker
                    providers={providers}
                    providerId={providerId}
                    modelId={modelId}
                    mode={chatMode}
                    options={modelOptions}
                    pickA={effPickA}
                    pickB={effPickB}
                    onPickA={setComparePickA}
                    onPickB={setComparePickB}
                    reasoning={reasoning}
                    onReasoning={setReasoning}
                    onSelect={(p, m) => {
                      setProviderId(p.id);
                      setModelId(m.id);
                      setModelMenu(false);
                    }}
                  />
                )}
              </div>
              {attachments.length > 0 && (
                <div className="attachment-row">
                  {attachments.map((a, i) => (
                    <span className="attachment-chip" key={`${a.path}-${i}`}>
                      <File size={13} />
                      {a.name}
                      <button
                        onClick={() =>
                          setAttachments((x) => x.filter((_, j) => j !== i))
                        }
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="connector-row" aria-label="Connectors">
                {connectorUi.map((item, i) => (
                  <button
                    key={item.id}
                    className="connector-chip"
                    title={
                      connectorConnected(item.id)
                        ? `${item.label}: connected`
                        : `${item.label}: connect in Settings`
                    }
                    onClick={() => setConnectorsSheetOpen(true)}
                  >
                    <span className={`connector-symbol c${i}`}>
                      {item.symbol}
                    </span>
                    {item.label}
                    {connectorConnected(item.id) && (
                      <span className="connector-dot" />
                    )}
                  </button>
                ))}
              </div>
              {providers.length === 0 && (
                <button
                  className="setup-provider"
                  onClick={() => setSettingsOpen(true)}
                >
                  <ShieldCheck size={16} /> Add a model provider to begin{" "}
                  <ChevronRight size={15} />
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="message-list">
                {messages.map((m, i) => (
                  <div
                    className={`message ${m.role === "user" ? "user-message" : "assistant-message"}`}
                    key={m.id || i}
                  >
                    {m.role === "user" ? (
                      <div className="user-content">{m.content}</div>
                    ) : (
                      <div className="assistant-content">
                        {m.content && (
                          <div className="markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {m.content}
                            </ReactMarkdown>
                          </div>
                        )}
                        {m.id === "streaming" && (
                          <span className="stream-caret" />
                        )}
                      </div>
                    )}
                    {m.role === "assistant" &&
                      m.id !== "streaming" &&
                      !running && (
                        <div className="message-actions">
                          <button onClick={() => void copyText(m.content)}>
                            <Copy size={13} /> Copy
                          </button>
                          {i === lastAssistantIdx && (
                            <button
                              onClick={() => {
                                const lastUser = [...messages]
                                  .reverse()
                                  .find((x) => x.role === "user");
                                if (lastUser) void send(lastUser.content);
                              }}
                            >
                              <RotateCcw size={13} /> Regenerate
                            </button>
                          )}
                          <button
                            className={feedback[m.id] === "up" ? "active" : ""}
                            title="Good response"
                            onClick={() => recordFeedback(m.id, "up")}
                          >
                            <ThumbsUp size={13} />
                          </button>
                          <button
                            className={
                              feedback[m.id] === "down" ? "active" : ""
                            }
                            title="Bad response"
                            onClick={() => recordFeedback(m.id, "down")}
                          >
                            <ThumbsDown size={13} />
                          </button>
                        </div>
                      )}
                    {m.role === "user" && !running && (
                      <div className="message-actions">
                        <button
                          onClick={() => {
                            setComposer(m.content);
                            setTimeout(() => inputRef.current?.focus(), 30);
                          }}
                        >
                          <PencilLine size={13} /> Edit
                        </button>
                        <button onClick={() => void copyText(m.content)}>
                          <Copy size={13} /> Copy
                        </button>
                      </div>
                    )}
                    {m.role === "assistant" &&
                      i === messages.length - 1 &&
                      tools.length > 0 && (
                        <ActivityFeed
                          tools={tools}
                          expandedGroup={expandedActivity}
                          onToggleGroup={(key) =>
                            setExpandedActivity(
                              expandedActivity === key ? "" : key,
                            )
                          }
                          expandedTool={expandedTool}
                          onToggleTool={(callId) =>
                            setExpandedTool(
                              expandedTool === callId ? "" : callId,
                            )
                          }
                          onOpenFile={(path) => {
                            setRightOpen(true);
                            setRightTab("Files");
                            if (activeId) void openFile(activeId, path);
                          }}
                        />
                      )}
                    {i === messages.length - 1 && compareResult && (
                      <CompareResult
                        result={compareResult}
                        battle={chatMode === "battle"}
                        pick={battlePick}
                        revealed={battleRevealed}
                        onPick={(side) => {
                          if (!battleRevealed)
                            recordBattle(side, compareResult);
                          setBattlePick(side);
                          setBattleRevealed(true);
                        }}
                      />
                    )}
                    {i === messages.length - 1 && pendingAsk && (
                      <AskCard ask={pendingAsk} onSubmit={submitAsk} />
                    )}
                    {i === messages.length - 1 && approval && (
                      <div className="approval-card">
                        <div className="approval-top">
                          <ShieldCheck size={17} /> <b>Confirm shell command</b>
                          <span>High impact</span>
                        </div>
                        <p>{approval.message}</p>
                        <code>{approval.command}</code>
                        <div>
                          <button
                            className="btn-muted"
                            onClick={() => void respondApproval(false)}
                          >
                            Deny
                          </button>
                          <button
                            className="btn-danger"
                            onClick={() => void respondApproval(true)}
                          >
                            Run once
                          </button>
                        </div>
                      </div>
                    )}
                    {i === messages.length - 1 && todos.length > 0 && (
                      <div className="todo-card">
                        <b>Plan</b>
                        <div className="todo-progress">
                          <i
                            style={{
                              width: `${todos.length ? Math.round((todos.filter((t) => t.status === "completed").length / todos.length) * 100) : 0}%`,
                            }}
                          />
                        </div>
                        {todos.map((t, j) => (
                          <div className="todo-row" key={j}>
                            <span
                              className={
                                t.status === "completed"
                                  ? "todo-check done"
                                  : "todo-check"
                              }
                            >
                              {t.status === "completed" ? "✓" : ""}
                            </span>
                            <span
                              className={
                                t.status === "completed" ? "done-text" : ""
                              }
                            >
                              {t.status === "in_progress"
                                ? (t.activeForm ?? t.content)
                                : t.content}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              {running && (
                <div className="working-strip">
                  <div className="working-line" />
                  <span className="pulse-dot" /> Working · {tools.length} tool
                  calls{" "}
                  {tools.length > 0 && <span>· {tools.at(-1)?.toolName}</span>}
                  <button onClick={() => void stop()}>
                    <Square size={13} /> Stop
                  </button>
                </div>
              )}
              {!follow && (
                <button
                  className="jump-latest"
                  onClick={() =>
                    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  Jump to latest <ArrowDown size={14} />
                </button>
              )}
              <div className="composer-wrap">
                <div className="composer-main">
                  <button
                    className="icon-btn attach-btn"
                    title="Connections and files"
                    onClick={() => setConnectionsOpen((v) => !v)}
                  >
                    <span className="grid-plus">
                      <Grip size={17} />
                      <Plus size={9} />
                    </span>
                  </button>
                  <div className="mode-pill-wrap">
                    <button
                      className="agent-pill compact-pill"
                      onClick={() => setModeMenuOpen((v) => !v)}
                      title="Mode"
                    >
                      {chatMode === "battle" ? (
                        <Swords size={13} />
                      ) : chatMode === "side" ? (
                        <Columns2 size={13} />
                      ) : chatMode === "direct" ? (
                        <MessageCircle size={13} />
                      ) : (
                        <Zap size={13} />
                      )}{" "}
                      {MODE_META[chatMode].short} <ChevronDown size={12} />
                    </button>
                    {modeMenuOpen && (
                      <ModeMenu
                        mode={chatMode}
                        onSelect={(m) => {
                          setChatMode(m);
                          setModeMenuOpen(false);
                        }}
                      />
                    )}
                  </div>
                  <textarea
                    ref={inputRef}
                    value={composer}
                    onChange={(e) => setComposer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    placeholder="What would you like to do?"
                    rows={1}
                  />
                  <button
                    className="model-button compact"
                    onClick={() => setModelMenu((v) => !v)}
                    title="Select model"
                  >
                    <span className="provider-dot" />
                    {selectedModel?.displayName ??
                      selectedProvider?.name ??
                      "Set up model"}
                    <ChevronDown size={12} />
                  </button>
                  <button
                    className={`send-btn ${running ? "stop-btn" : ""}`}
                    onClick={running ? () => void stop() : submit}
                    disabled={!running && !composer.trim()}
                    title={running ? "Stop" : "Send"}
                  >
                    {running ? <Square size={15} /> : <ArrowUp size={18} />}
                  </button>
                </div>
                {connectionsOpen && (
                  <ConnectionsPopover
                    isConnected={connectorConnected}
                    isEnabled={connectorEnabled}
                    onToggle={toggleConnectorEnabled}
                    onConnect={openConnectorSettings}
                    onViewAll={() => setConnectorsSheetOpen(true)}
                    onAddFiles={() =>
                      document.getElementById("file-input")?.click()
                    }
                    onClose={() => setConnectionsOpen(false)}
                  />
                )}
                {attachments.length > 0 && (
                  <div className="attachment-row inline">
                    {attachments.map((a, i) => (
                      <span className="attachment-chip" key={`${a.path}-${i}`}>
                        <File size={13} />
                        {a.name}
                        <button
                          onClick={() =>
                            setAttachments((x) => x.filter((_, j) => j !== i))
                          }
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {modelMenu && (
                  <ModelPicker
                    providers={providers}
                    providerId={providerId}
                    modelId={modelId}
                    mode={chatMode}
                    options={modelOptions}
                    pickA={effPickA}
                    pickB={effPickB}
                    onPickA={setComparePickA}
                    onPickB={setComparePickB}
                    reasoning={reasoning}
                    onReasoning={setReasoning}
                    onSelect={(p, m) => {
                      setProviderId(p.id);
                      setModelId(m.id);
                      setModelMenu(false);
                      if (activeId)
                        void api(`/api/sessions/${activeId}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            providerId: p.id,
                            modelId: m.id,
                          }),
                        });
                    }}
                  />
                )}
                <div className="composer-meta">
                  <span>
                    Model output may be inaccurate. Verify important results.
                  </span>
                  <span>
                    {cost.turn > 0
                      ? `Turn · $${cost.turn.toFixed(4)} · ${fmt(cost.tokens)}`
                      : (selectedProvider?.name ?? "No provider configured")}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      {rightOpen && !isHome && (
        <aside className="right-panel">
          <div className="panel-header">
            <div className="panel-tabs">
              {["Workspace", "Diff", "Preview", "Checks", "Files"].map((t) => (
                <button
                  key={t}
                  className={rightTab === t ? "active" : ""}
                  onClick={() => setRightTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={() => setRightOpen(false)}>
              <X size={16} />
            </button>
          </div>
          {rightTab === "Workspace" && (
            <div className="panel-body workspace-sheet">
              <div className="panel-title-row">
                <div>
                  <b>Workspace</b>
                  <small>
                    {(() => {
                      const filesOnly = workspace.filter(
                        (f) => f.kind === "file",
                      );
                      const bytes = filesOnly.reduce((n, f) => n + f.size, 0);
                      return `${(bytes / 1048576).toFixed(1)}MB/128.0MB · ${filesOnly.length}/10K files`;
                    })()}
                  </small>
                  <div className="usage-bar">
                    <i
                      style={{
                        width: `${Math.min(
                          100,
                          (workspace
                            .filter((f) => f.kind === "file")
                            .reduce((n, f) => n + f.size, 0) /
                            (128 * 1048576)) *
                            100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
                <button
                  className="icon-btn"
                  title="Download workspace as ZIP"
                  onClick={() =>
                    activeId &&
                    void window.location.assign(
                      `/api/sessions/${activeId}/download-workspace`,
                    )
                  }
                >
                  <Download size={16} />
                </button>
              </div>
              {workspace.length === 0 ? (
                <div className="panel-empty">
                  <Folder size={27} />
                  <b>Your workspace is ready</b>
                  <span>Files created by the agent will appear here.</span>
                </div>
              ) : (
                <div className="file-tree">
                  {Array.from(
                    new Set(
                      workspace
                        .map((f) => f.path.split("/")[0])
                        .filter(
                          (seg) =>
                            seg &&
                            workspace.some((f) => f.path.startsWith(`${seg}/`)),
                        ),
                    ),
                  ).map((folder) => (
                    <div className="folder-row" key={`folder-${folder}`}>
                      <Folder size={14} /> {folder}
                    </div>
                  ))}
                  {workspace.map((f) => (
                    <button
                      key={f.path}
                      style={{
                        paddingLeft: 9 + (f.path.split("/").length - 1) * 13,
                      }}
                      className={`file-row ${selectedFile === f.path ? "selected" : ""}`}
                      onClick={() => {
                        setRightTab("Files");
                        if (activeId) void openFile(activeId, f.path);
                      }}
                    >
                      <span className="file-tree-icon">
                        {f.kind === "directory" ? (
                          <Folder size={15} />
                        ) : (
                          fileIcon(f.path)
                        )}
                      </span>
                      <span className="file-name">{f.path}</span>
                      <small>
                        {f.kind === "file" ? prettyBytes(f.size) : ""}
                      </small>
                    </button>
                  ))}
                </div>
              )}
              <div className="workspace-connectors">
                <span>Connectors</span>
                <span className="workspace-connector-chips">
                  {connectorUi
                    .filter((c) => connectorEnabled(c.id))
                    .slice(0, 4)
                    .map((c) => (
                      <span
                        className="connector-symbol mini"
                        key={c.id}
                        title={c.label}
                      >
                        {c.symbol}
                      </span>
                    ))}
                </span>
                <button
                  className="icon-btn"
                  title="Add connectors"
                  onClick={() => setConnectorsSheetOpen(true)}
                >
                  <Plus size={15} />
                </button>
              </div>
            </div>
          )}
          {rightTab === "Diff" &&
            (sessionRepo?.connected ? (
              <div className="panel-body live-panel">
                <div className="panel-title-row">
                  <div>
                    <b>{sessionRepo.repo}</b>
                    <small>
                      {sessionRepo.branch} ← {sessionRepo.baseBranch}
                      {sessionRepo.locked ? " · locked" : ""}
                    </small>
                  </div>
                  <button
                    className="outline-btn"
                    onClick={() =>
                      activeId &&
                      api<any>(
                        `/api/sessions/${activeId}/diff?full=${diffFull ? "1" : "0"}`,
                      )
                        .then(setDiffData)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <RotateCcw size={13} /> Refresh
                  </button>
                </div>
                <div className="diff-controls">
                  <button
                    className={!diffFull ? "active" : ""}
                    onClick={() => {
                      setDiffFull(false);
                      if (activeId)
                        api<any>(`/api/sessions/${activeId}/diff`)
                          .then(setDiffData)
                          .catch(() => {});
                    }}
                  >
                    Working tree
                  </button>
                  <button
                    className={diffFull ? "active" : ""}
                    onClick={() => {
                      setDiffFull(true);
                      if (activeId)
                        api<any>(`/api/sessions/${activeId}/diff?full=1`)
                          .then(setDiffData)
                          .catch(() => {});
                    }}
                  >
                    Full branch
                  </button>
                </div>
                <div className="diff-stats">
                  {diffData?.stats ||
                    "Diff compares workspace changes against the base branch."}
                </div>
                <pre className="diff-view">
                  {diffData?.diff ||
                    "No tracked changes yet. Edit files, then refresh."}
                </pre>
                {sessionRepo.locked && (
                  <div className="setting-note">
                    This repository session is locked after its pull request was
                    closed or merged.
                  </div>
                )}
              </div>
            ) : (
              <div className="panel-empty">
                <GitBranch size={25} />
                <b>No repository connected to this session</b>
                <span>
                  Connect GitHub and clone a selected repository into a session
                  to view its changes.
                </span>
                <button
                  className="outline-btn"
                  onClick={() => {
                    setSettingsOpen(true);
                    setSettingsTab("Connectors");
                  }}
                >
                  Connect repository
                </button>
              </div>
            ))}
          {rightTab === "Preview" &&
            (previews.some((p) => p.state === "ready") ? (
              <div className="preview-panel">
                <div className="preview-toolbar">
                  <select
                    value={selectedPreview?.port ?? ""}
                    onChange={(e) => {
                      setPreviewPort(Number(e.target.value));
                      setPreviewReload((n) => n + 1);
                    }}
                  >
                    {previews
                      .filter((p) => p.state === "ready")
                      .map((p) => (
                        <option key={p.id} value={p.port}>
                          Port {p.port}
                        </option>
                      ))}
                  </select>
                  <select
                    value={previewDevice}
                    onChange={(e) => setPreviewDevice(e.target.value)}
                  >
                    <option value="100%">Desktop</option>
                    <option value="768px">Tablet</option>
                    <option value="375px">Mobile</option>
                  </select>
                  <button
                    className="outline-btn"
                    onClick={() => setPreviewReload((n) => n + 1)}
                  >
                    <RotateCcw size={13} /> Reload
                  </button>
                  <a
                    className="outline-btn"
                    href={withToken(
                      `/preview/${activeId}/${selectedPreview?.port}/`,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open ↗
                  </a>
                  <button
                    className="icon-btn"
                    title="Stop preview"
                    onClick={() =>
                      activeId &&
                      api(`/api/sessions/${activeId}/previews/stop`, {
                        method: "POST",
                        body: "{}",
                      })
                        .then(() => setPreviews([]))
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <Square size={13} />
                  </button>
                </div>
                <iframe
                  key={previewReload}
                  className="preview-frame"
                  style={{ width: previewDevice }}
                  src={withToken(
                    `/preview/${activeId}/${selectedPreview?.port}/`,
                  )}
                  title="Local app preview"
                  sandbox="allow-scripts allow-same-origin"
                />
              </div>
            ) : (
              <div className="panel-empty">
                <Eye size={26} />
                <b>No preview running</b>
                <span>
                  Ask the agent to start a real dev server with the
                  start_preview tool. It will be proxied through this app.
                </span>
                <code>npm run dev -- --host 127.0.0.1 --port 4173</code>
                {previews
                  .filter((p) => p.state === "error")
                  .map((p) => (
                    <pre className="preview-error" key={p.id}>
                      {p.lastError ?? p.output}
                    </pre>
                  ))}
              </div>
            ))}
          {rightTab === "Checks" &&
            (checksData?.checkRuns?.length ? (
              <div className="panel-body live-panel">
                <div className="panel-title-row">
                  <div>
                    <b>GitHub checks</b>
                    <small>
                      {
                        checksData.checkRuns.filter(
                          (c: any) => c.conclusion === "success",
                        ).length
                      }{" "}
                      passing ·{" "}
                      {
                        checksData.checkRuns.filter(
                          (c: any) => c.conclusion === "failure",
                        ).length
                      }{" "}
                      failing
                    </small>
                  </div>
                  <button
                    className="outline-btn"
                    onClick={() =>
                      activeId &&
                      api<any>(`/api/sessions/${activeId}/checks`)
                        .then(setChecksData)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <RotateCcw size={13} /> Refresh
                  </button>
                </div>
                {checksData.checkRuns.map((check: any) => (
                  <details className="check-row" key={String(check.id)}>
                    <summary>
                      <span
                        className={`check-status ${String(check.conclusion ?? check.status)}`}
                      >
                        {check.conclusion === "success"
                          ? "✓"
                          : check.conclusion === "failure"
                            ? "×"
                            : "◌"}
                      </span>
                      <span>{String(check.name ?? "Check")}</span>
                      <small>
                        {String(check.conclusion ?? check.status ?? "pending")}
                      </small>
                    </summary>
                    <div className="check-detail">
                      {String(
                        check.output?.title ??
                          check.output?.summary ??
                          check.details_url ??
                          "No log details provided by GitHub.",
                      )}
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <div className="panel-empty">
                <CheckCircle2 size={26} />
                <b>
                  {sessionRepo?.connected
                    ? "No CI checks yet"
                    : "Connect a repository"}
                </b>
                <span>
                  {sessionRepo?.connected
                    ? "Checks appear after a push or pull request."
                    : "Repository CI checks appear here when a GitHub session is connected."}
                </span>
                {sessionRepo?.connected && (
                  <button
                    className="outline-btn"
                    onClick={() =>
                      activeId &&
                      api<any>(`/api/sessions/${activeId}/checks`)
                        .then(setChecksData)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <RotateCcw size={13} /> Check now
                  </button>
                )}
              </div>
            ))}
          {rightTab === "Files" && (
            <div className="viewer">
              <div className="viewer-toolbar">
                <span className="breadcrumb">
                  <Folder size={14} /> {selectedFile || "Select a file"}
                </span>
                {selectedFile && (
                  <button
                    className="icon-btn"
                    onClick={() => window.open(fileUrl, "_blank")}
                    title="Open file"
                  >
                    <Eye size={15} />
                  </button>
                )}
              </div>
              {!selectedFile ? (
                <div className="panel-empty">
                  <FileText size={26} />
                  <b>Artifact viewer</b>
                  <span>
                    Select a workspace file or ask the agent to present one.
                  </span>
                </div>
              ) : isImage(selectedFile) ? (
                <img
                  className="image-viewer"
                  src={fileContent || fileUrl}
                  alt={selectedFile}
                />
              ) : selectedFile.toLowerCase().endsWith(".pdf") ? (
                <iframe
                  className="pdf-viewer"
                  src={fileUrl}
                  title={selectedFile}
                />
              ) : isAudio(selectedFile) ? (
                <div className="audio-viewer">
                  <div className="panel-empty">
                    <Play size={26} />
                    <b>Audio preview</b>
                    <span>{selectedFile}</span>
                  </div>
                  <Waveform src={fileContent || fileUrl} />
                </div>
              ) : selectedFile.toLowerCase().endsWith(".html") ? (
                <iframe
                  className="html-viewer"
                  src={fileUrl}
                  sandbox="allow-scripts"
                  title={selectedFile}
                />
              ) : selectedFile.toLowerCase().endsWith(".md") ? (
                <div className="file-markdown markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {fileContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="code-viewer">
                  <code>{fileContent}</code>
                </pre>
              )}
            </div>
          )}
        </aside>
      )}
      {!rightOpen && !isHome && (
        <button className="right-reopen" onClick={() => setRightOpen(true)}>
          <PanelRight size={16} />
        </button>
      )}
      <input
        id="file-input"
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files);
          e.currentTarget.value = "";
        }}
      />
      {commandOpen && (
        <div
          className="modal-backdrop command-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCommandOpen(false);
          }}
        >
          <div
            className="command-palette"
            role="dialog"
            aria-label="Command palette"
          >
            <div className="command-search">
              <Search size={16} />
              <input
                autoFocus
                value={commandQuery}
                onChange={(e) => setCommandQuery(e.target.value)}
                placeholder="Search actions…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && paletteItems[0]) {
                    e.preventDefault();
                    setCommandOpen(false);
                    paletteItems[0].run();
                  }
                }}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="command-list">
              {paletteItems.length ? (
                paletteItems.map((item) => (
                  <button
                    key={item.label}
                    onClick={() => {
                      setCommandOpen(false);
                      item.run();
                    }}
                  >
                    <span>
                      <b>{item.label}</b>
                      <small>{item.detail}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))
              ) : (
                <div className="command-empty">No matching actions</div>
              )}
            </div>
          </div>
        </div>
      )}
      {leaderboardOpen && (
        <Leaderboard
          history={battleHistory}
          sessions={sessions}
          onClose={() => setLeaderboardOpen(false)}
        />
      )}
      {connectorsSheetOpen && (
        <ConnectorsSheet
          isConnected={connectorConnected}
          isEnabled={connectorEnabled}
          accountFor={(id) =>
            id === "github"
              ? (github.user?.login ?? "")
              : (connectors.find((c) => c.id === id)?.account ?? "")
          }
          onToggle={toggleConnectorEnabled}
          onConnect={openConnectorSettings}
          onClose={() => setConnectorsSheetOpen(false)}
        />
      )}
      {settingsOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div className="settings-modal">
            <div className="settings-head">
              <div>
                <b>Settings</b>
                <span>Local configuration for your agent</span>
              </div>
              <button
                className="icon-btn"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="settings-layout">
              <nav className="settings-nav">
                {[
                  "Providers",
                  "Agent",
                  "Appearance",
                  "Connectors",
                  "Data",
                  "Advanced",
                ].map((t) => (
                  <button
                    key={t}
                    className={settingsTab === t ? "active" : ""}
                    onClick={() => setSettingsTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </nav>
              <div className="settings-content">
                {settingsTab === "Providers" ? (
                  <>
                    <div className="settings-section-title">
                      <div>
                        <h3>Model providers</h3>
                        <p>
                          Keys are encrypted in your local data folder. Models
                          are fetched live from each provider.
                        </p>
                      </div>
                    </div>
                    {providers.map((p) => (
                      <div className="provider-row" key={p.id}>
                        <div className="provider-avatar">
                          <Zap size={16} />
                        </div>
                        <div className="provider-info">
                          <b>
                            {p.name}
                            {p.is_default && (
                              <span className="default-badge">Default</span>
                            )}
                          </b>
                          <small>
                            {p.kind} · {p.models.length} models ·{" "}
                            {p.api_key_masked || "No key"}
                          </small>
                        </div>
                        <button
                          className="outline-btn"
                          onClick={() => void newProviderRefresh(p.id)}
                        >
                          <RotateCcw size={13} /> Refresh
                        </button>
                        <button
                          className="icon-btn"
                          onClick={async () => {
                            await api(`/api/providers/${p.id}/default`, {
                              method: "POST",
                            });
                            await refresh();
                          }}
                          title="Set default"
                        >
                          <CheckCircle2 size={16} />
                        </button>
                        <button
                          className="icon-btn danger-icon"
                          onClick={async () => {
                            if (confirm("Delete this provider?")) {
                              try {
                                await api(`/api/providers/${p.id}`, {
                                  method: "DELETE",
                                });
                                await refresh();
                              } catch (e) {
                                setError(String(e));
                              }
                            }
                          }}
                          title="Delete provider"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ))}
                    <div className="provider-form">
                      <h4>Add provider</h4>
                      <div className="form-grid">
                        <label>
                          Display name
                          <input
                            value={providerForm.name}
                            onChange={(e) =>
                              setProviderForm({
                                ...providerForm,
                                name: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Provider type
                          <select
                            value={providerForm.kind}
                            onChange={(e) => {
                              const kind = e.target.value;
                              const urls: Record<string, string> = {
                                openai: "https://api.openai.com/v1",
                                openrouter: "https://openrouter.ai/api/v1",
                                kilo: "https://api.kilo.ai/api/gateway",
                                gemini:
                                  "https://generativelanguage.googleapis.com/v1beta",
                                anthropic: "https://api.anthropic.com/v1",
                                ollama: "http://localhost:11434/v1",
                                "custom-openai": "http://localhost:1234/v1",
                                "gemini-openai":
                                  "https://generativelanguage.googleapis.com/v1beta/openai",
                                demo: "demo://offline",
                              };
                              setProviderForm({
                                ...providerForm,
                                kind,
                                base_url: urls[kind] ?? providerForm.base_url,
                              });
                            }}
                          >
                            {[
                              ["openai", "OpenAI"],
                              ["openrouter", "OpenRouter"],
                              ["kilo", "Kilo Gateway"],
                              ["gemini", "Gemini native"],
                              ["anthropic", "Anthropic"],
                              ["custom-openai", "Custom OpenAI-compatible"],
                              ["ollama", "Ollama local"],
                              ["gemini-openai", "Gemini OpenAI-compatible"],
                              [
                                "demo",
                                "Offline demo (no key / internet needed)",
                              ],
                            ].map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="wide">
                          API base URL
                          <input
                            value={providerForm.base_url}
                            onChange={(e) =>
                              setProviderForm({
                                ...providerForm,
                                base_url: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="wide">
                          API key
                          <input
                            type="password"
                            value={providerForm.api_key}
                            onChange={(e) =>
                              setProviderForm({
                                ...providerForm,
                                api_key: e.target.value,
                              })
                            }
                            placeholder="Paste your provider key"
                            autoComplete="off"
                          />
                        </label>
                      </div>
                      <button
                        className="primary-btn"
                        onClick={() => void saveProvider()}
                      >
                        Connect provider and fetch models <ArrowUp size={15} />
                      </button>
                      <p className="form-hint">
                        {providerForm.kind === "demo"
                          ? "Offline demo needs no key and no internet — it streams built-in sample replies so you can try chat, Agent/Direct and Battle/Side-by-Side anywhere. "
                          : ""}
                        Your API key is stored only on this machine and never
                        returned in plaintext.
                      </p>
                    </div>
                  </>
                ) : settingsTab === "Data" ? (
                  <div className="settings-section-title">
                    <h3>Local data</h3>
                    <p>
                      Sessions, encrypted credentials, database, and workspaces
                      are stored under <code>./data</code>.
                    </p>
                    <button
                      className="outline-btn"
                      onClick={() =>
                        activeId &&
                        window.open(
                          `/api/sessions/${activeId}/export?format=json`,
                          "_blank",
                        )
                      }
                    >
                      Export current session
                    </button>
                    <a href="/api/diagnostics" target="_blank">
                      Open diagnostics JSON
                    </a>
                  </div>
                ) : settingsTab === "Connectors" ? (
                  <div className="settings-section-title">
                    <h3>GitHub &amp; connectors</h3>
                    <p>
                      Connect a GitHub Personal Access Token. It is encrypted
                      locally and never returned to the browser.
                    </p>
                    {!github.connected ? (
                      <div className="github-connect-form">
                        <label>
                          Personal access token
                          <input
                            type="password"
                            value={githubToken}
                            onChange={(e) => setGithubToken(e.target.value)}
                            placeholder="github_pat_…"
                            autoComplete="off"
                          />
                        </label>
                        <button
                          className="primary-btn"
                          disabled={!githubToken.trim()}
                          onClick={() => void connectGithub()}
                        >
                          Validate and connect <ArrowUp size={14} />
                        </button>
                        <a
                          href="https://github.com/settings/personal-access-tokens"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Create a fine-grained token ↗
                        </a>
                      </div>
                    ) : (
                      <>
                        <div className="github-status-row">
                          <span className="status-dot running" />
                          <b>
                            Connected as @{github.user?.login ?? "GitHub user"}
                          </b>
                          {github.rateLimit && (
                            <small>
                              {github.rateLimit.remaining} API requests left ·
                              resets{" "}
                              {new Date(
                                github.rateLimit.resetAt,
                              ).toLocaleTimeString()}
                            </small>
                          )}
                          <button
                            className="outline-btn"
                            onClick={() => void disconnectGithub()}
                          >
                            Disconnect
                          </button>
                        </div>
                        <label className="repo-search">
                          Search repositories
                          <input
                            value={repoQuery}
                            onChange={(e) => setRepoQuery(e.target.value)}
                            placeholder="owner/name"
                          />
                        </label>
                        <div className="repo-list">
                          {githubRepos
                            .filter((r) =>
                              r.full_name
                                .toLowerCase()
                                .includes(repoQuery.toLowerCase()),
                            )
                            .map((repo) => (
                              <label className="repo-choice" key={repo.id}>
                                <input
                                  type="checkbox"
                                  checked={github.selectedRepos.includes(
                                    repo.full_name,
                                  )}
                                  onChange={(e) =>
                                    void toggleRepo(
                                      repo.full_name,
                                      e.target.checked,
                                    )
                                  }
                                />
                                <span>
                                  <b>{repo.full_name}</b>
                                  <small>
                                    {repo.private ? "Private" : "Public"} ·
                                    default: {repo.default_branch}
                                  </small>
                                </span>
                              </label>
                            ))}
                        </div>
                        <div className="clone-repo-row">
                          <label>
                            Selected repo
                            <select
                              value={repoToClone}
                              onChange={(e) => {
                                setRepoToClone(e.target.value);
                                const item = githubRepos.find(
                                  (r) => r.full_name === e.target.value,
                                );
                                setRepoBranch(item?.default_branch ?? "main");
                              }}
                            >
                              <option value="">
                                Choose a selected repository
                              </option>
                              {githubRepos
                                .filter((r) =>
                                  github.selectedRepos.includes(r.full_name),
                                )
                                .map((r) => (
                                  <option value={r.full_name} key={r.id}>
                                    {r.full_name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label>
                            Base branch
                            <input
                              value={repoBranch}
                              onChange={(e) => setRepoBranch(e.target.value)}
                            />
                          </label>
                          <button
                            className="primary-btn"
                            disabled={!repoToClone}
                            onClick={() =>
                              void cloneSelectedRepo(repoToClone, repoBranch)
                            }
                          >
                            Clone into{" "}
                            {activeId ? "this session" : "new session"}
                          </button>
                        </div>
                      </>
                    )}
                    <div className="connector-list">
                      {connectors.map((connector) => (
                        <div className="connector-setting" key={connector.id}>
                          <span className="connector-symbol">
                            {connector.label.slice(0, 1)}
                          </span>
                          <div>
                            <b>
                              {connector.label}
                              {connector.connected
                                ? ` · ${connector.account}`
                                : ""}
                            </b>
                            <small>
                              {connector.connected
                                ? `Validated${connector.validatedAt ? ` ${new Date(connector.validatedAt).toLocaleString()}` : ""} · ${connector.credentialMasked}`
                                : connector.help}
                            </small>
                            {!connector.connected && (
                              <div className="connector-form">
                                <input
                                  type="password"
                                  autoComplete="off"
                                  placeholder={connector.tokenLabel}
                                  value={connectorForms[connector.id] ?? ""}
                                  onChange={(e) =>
                                    setConnectorForms((old) => ({
                                      ...old,
                                      [connector.id]: e.target.value,
                                    }))
                                  }
                                />
                                <button
                                  className="outline-btn"
                                  disabled={
                                    !(connectorForms[connector.id] ?? "").trim()
                                  }
                                  onClick={() =>
                                    void connectConnector(connector.id)
                                  }
                                >
                                  Validate & connect
                                </button>
                              </div>
                            )}
                          </div>
                          {connector.connected && (
                            <span className="connector-actions">
                              <button
                                className="outline-btn"
                                onClick={() => void testConnector(connector.id)}
                              >
                                Test
                              </button>
                              <button
                                className="outline-btn"
                                onClick={() =>
                                  void disconnectConnector(connector.id)
                                }
                              >
                                Disconnect
                              </button>
                            </span>
                          )}
                        </div>
                      ))}
                      {connectors.length === 0 && (
                        <p className="muted small">
                          Connector status could not be loaded. Is the local
                          server running?
                        </p>
                      )}
                    </div>
                  </div>
                ) : settingsTab === "Agent" ? (
                  <div className="settings-section-title">
                    <h3>Agent behavior</h3>
                    <p>
                      Runs support up to 30 tool rounds per request. Shell
                      commands execute in the session workspace with a scrubbed
                      environment and a confirmation gate for high-impact
                      patterns.
                    </p>
                    <div className="setting-note">
                      <ShieldCheck size={17} /> Local shell commands can change
                      files. Review high-impact command approvals carefully.
                    </div>
                  </div>
                ) : settingsTab === "Appearance" ? (
                  <div className="settings-section-title">
                    <h3>Appearance</h3>
                    <p>
                      Light is the default Galaxy theme. Reduced motion follows
                      your system setting.
                    </p>
                    <div className="theme-choices">
                      <button
                        className={`theme-choice ${theme === "light" ? "active" : ""}`}
                        onClick={() => setTheme("light")}
                      >
                        \u2600 Light{" "}
                        <span>
                          {theme === "light" ? "Current" : "Original"}
                        </span>
                      </button>
                      <button
                        className={`theme-choice ${theme === "dark" ? "active" : ""}`}
                        onClick={() => setTheme("dark")}
                      >
                        \u263E Dark{" "}
                        <span>
                          {theme === "dark" ? "Current" : "Workspace"}
                        </span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="settings-section-title">
                    <h3>Diagnostics & production</h3>
                    <p>
                      Live resource metrics from <code>/api/metrics</code>{" "}
                      (auto-refreshes every 5 seconds while this tab is open).
                      No telemetry leaves this machine.
                    </p>
                    {metrics ? (
                      <div className="metrics-grid">
                        <div>
                          <b>{metrics.version}</b>
                          <small>version</small>
                        </div>
                        <div>
                          <b>{metrics.uptimeSeconds}s</b>
                          <small>uptime</small>
                        </div>
                        <div>
                          <b>
                            {Math.round(
                              (metrics.process?.rssBytes ?? 0) / 1048576,
                            )}{" "}
                            MB
                          </b>
                          <small>process RSS</small>
                        </div>
                        <div>
                          <b>
                            {Math.round(
                              (metrics.process?.heapUsedBytes ?? 0) / 1048576,
                            )}{" "}
                            MB
                          </b>
                          <small>heap used</small>
                        </div>
                        <div>
                          <b>{metrics.counts?.sessions ?? 0}</b>
                          <small>sessions</small>
                        </div>
                        <div>
                          <b>{metrics.counts?.providers ?? 0}</b>
                          <small>providers</small>
                        </div>
                        <div>
                          <b>{metrics.runningSessions ?? 0}</b>
                          <small>running</small>
                        </div>
                        <div>
                          <b>{metrics.security?.authRequired ? "On" : "Off"}</b>
                          <small>app auth (APP_AUTH_TOKEN)</small>
                        </div>
                        <div>
                          <b>
                            {metrics.security?.rateLimitMax}/
                            {metrics.security?.windowMs / 1000}s
                          </b>
                          <small>rate limit</small>
                        </div>
                        <div>
                          <b>
                            {metrics.security?.failoverEnabled ? "On" : "Off"}
                          </b>
                          <small>provider failover</small>
                        </div>
                      </div>
                    ) : (
                      <p className="muted small">Loading metrics…</p>
                    )}
                    <a href="/api/diagnostics" target="_blank" rel="noreferrer">
                      Open diagnostics JSON
                    </a>{" "}
                    <a href="/api/metrics" target="_blank" rel="noreferrer">
                      Open metrics JSON
                    </a>
                    <div className="github-connect-form">
                      <label>
                        App access token (only needed when the server runs with
                        APP_AUTH_TOKEN)
                        <input
                          type="password"
                          autoComplete="off"
                          value={appTokenInput}
                          onChange={(e) => setAppTokenInput(e.target.value)}
                          placeholder="Paste the server APP_AUTH_TOKEN"
                        />
                      </label>
                      <button
                        className="outline-btn"
                        onClick={() => {
                          try {
                            if (appTokenInput.trim())
                              localStorage.setItem(
                                "galaxy-app-token",
                                appTokenInput.trim(),
                              );
                            else localStorage.removeItem("galaxy-app-token");
                          } catch {}
                          setNotice(
                            "App access token saved in this browser. Reloading data…",
                          );
                          void refresh();
                        }}
                      >
                        Save token in this browser
                      </button>
                    </div>
                    <div className="setting-note">
                      <Activity size={17} /> Set APP_AUTH_TOKEN, RATE_LIMIT_*
                      and FAILOVER_ENABLED on the server for production. See
                      docs/PRODUCTION.md.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {notice && (
        <div className="toast" onClick={() => setNotice("")}>
          <Check size={15} />
          {notice}
          <button>
            <X size={13} />
          </button>
        </div>
      )}
      {error && (
        <div className="toast error-toast" onClick={() => setError("")}>
          <CircleHelp size={15} />
          {error}
          <button>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
function fileIcon(path: string) {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext ?? ""))
    return <FileImage size={15} />;
  if (["md", "txt", "pdf"].includes(ext ?? "")) return <FileText size={15} />;
  if (
    ["js", "jsx", "ts", "tsx", "py", "css", "html", "json"].includes(ext ?? "")
  )
    return <Code2 size={15} />;
  return <File size={15} />;
}
function prettyBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function isImage(p: string) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(p);
}
function isAudio(p: string) {
  return /\.(mp3|wav|ogg|m4a|aac|opus|flac)$/i.test(p);
}
function ModeMenu({
  mode,
  onSelect,
}: {
  mode: ChatMode;
  onSelect: (mode: ChatMode) => void;
}) {
  const icons: Record<ChatMode, React.ReactNode> = {
    battle: <Swords size={16} />,
    agent: <Zap size={16} />,
    side: <Columns2 size={16} />,
    direct: <MessageCircle size={16} />,
  };
  return (
    <div className="mode-menu" role="menu">
      {(Object.keys(MODE_META) as ChatMode[]).map((key) => (
        <button
          key={key}
          className={mode === key ? "active" : ""}
          onClick={() => onSelect(key)}
        >
          <span className="mode-menu-icon">{icons[key]}</span>
          <span>
            <b>{MODE_META[key].label}</b>
            <small>{MODE_META[key].description}</small>
          </span>
          {mode === key && <Check size={15} />}
        </button>
      ))}
    </div>
  );
}

function ConnectionsPopover({
  isConnected,
  isEnabled,
  onToggle,
  onConnect,
  onViewAll,
  onAddFiles,
  onClose,
}: {
  isConnected: (id: string) => boolean;
  isEnabled: (id: string) => boolean;
  onToggle: (id: string) => void;
  onConnect: () => void;
  onViewAll: () => void;
  onAddFiles: () => void;
  onClose: () => void;
}) {
  return (
    <div className="connections-popover">
      <div className="connections-head">
        <b>Connections</b>
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
      {connectorUi.slice(0, 4).map((item) => (
        <div className="connection-row" key={item.id}>
          <span className="connector-symbol">{item.symbol}</span>
          <span className="connection-name">{item.label}</span>
          {isConnected(item.id) ? (
            <button
              className={`toggle ${isEnabled(item.id) ? "on" : ""}`}
              role="switch"
              aria-checked={isEnabled(item.id)}
              title={isEnabled(item.id) ? "Enabled" : "Disabled"}
              onClick={() => onToggle(item.id)}
            >
              <i />
            </button>
          ) : (
            <button className="connect-link" onClick={onConnect}>
              Connect
            </button>
          )}
        </div>
      ))}
      <button
        className="connections-viewall"
        onClick={() => {
          onClose();
          onViewAll();
        }}
      >
        View all connectors
      </button>
      <div className="connections-divider" />
      <button
        className="connection-row add-files"
        onClick={() => {
          onClose();
          onAddFiles();
        }}
      >
        <Paperclip size={15} />
        <span className="connection-name">Add files</span>
        <small>Up to 25MB per file</small>
      </button>
    </div>
  );
}

function ConnectorsSheet({
  isConnected,
  isEnabled,
  accountFor,
  onToggle,
  onConnect,
  onClose,
}: {
  isConnected: (id: string) => boolean;
  isEnabled: (id: string) => boolean;
  accountFor: (id: string) => string;
  onToggle: (id: string) => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="connectors-sheet"
        role="dialog"
        aria-label="Connectors"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <b>Connectors</b>
          <span>
            <button
              className="icon-btn"
              title="Add a connector"
              onClick={onConnect}
            >
              <Plus size={17} />
            </button>
            <button className="icon-btn" title="Close" onClick={onClose}>
              <X size={17} />
            </button>
          </span>
        </div>
        <div className="sheet-list">
          {connectorUi.map((item) => {
            const connected = isConnected(item.id);
            const account = accountFor(item.id);
            return (
              <div className="sheet-card" key={item.id}>
                <span className="connector-symbol large">{item.symbol}</span>
                <div className="sheet-card-text">
                  <b>
                    {item.label}
                    {connected && (
                      <span className="connected-check">
                        <Check size={11} />
                      </span>
                    )}
                  </b>
                  <small>
                    {connected && account
                      ? `${item.description} Connected as ${account}.`
                      : item.description}
                  </small>
                </div>
                {connected ? (
                  <button
                    className={`toggle ${isEnabled(item.id) ? "on" : ""}`}
                    role="switch"
                    aria-checked={isEnabled(item.id)}
                    title={isEnabled(item.id) ? "Enabled" : "Disabled"}
                    onClick={() => onToggle(item.id)}
                  >
                    <i />
                  </button>
                ) : (
                  <button
                    className="sheet-add"
                    title={`Connect ${item.label}`}
                    onClick={onConnect}
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="sheet-note">
          Connected connectors are validated locally and exposed to the agent as
          tools. Tokens stay encrypted on this device.
        </p>
      </div>
    </div>
  );
}

function Leaderboard({
  history,
  sessions,
  onClose,
}: {
  history: Array<{ winner: string; loser: string; at: number }>;
  sessions: Session[];
  onClose: () => void;
}) {
  const standings = new Map<string, { w: number; l: number }>();
  for (const h of history) {
    const w = standings.get(h.winner) ?? { w: 0, l: 0 };
    w.w += 1;
    standings.set(h.winner, w);
    if (h.loser.trim()) {
      const l = standings.get(h.loser) ?? { w: 0, l: 0 };
      l.l += 1;
      standings.set(h.loser, l);
    }
  }
  const ranked = [...standings.entries()]
    .map(([model, v]) => ({
      model,
      ...v,
      rate: v.w + v.l ? Math.round((v.w / (v.w + v.l)) * 100) : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.w - a.w);
  const usage = new Map<
    string,
    { chats: number; tokens: number; cost: number }
  >();
  for (const s of sessions) {
    const key = s.model_id ?? "Not recorded";
    const row = usage.get(key) ?? { chats: 0, tokens: 0, cost: 0 };
    row.chats += 1;
    row.tokens += s.total_tokens ?? 0;
    row.cost += s.total_cost_usd ?? 0;
    usage.set(key, row);
  }
  const usageRows = [...usage.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens,
  );
  return (
    <div className="sheet-backdrop center" onClick={onClose}>
      <div
        className="leaderboard-card"
        role="dialog"
        aria-label="Leaderboard"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <b>
            <Trophy size={17} /> Leaderboard
          </b>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <h4>Battle standings</h4>
        {ranked.length === 0 ? (
          <p className="muted small">
            No battles yet. Switch to Battle Mode, ask something, and pick a
            winner — standings build from your picks on this device.
          </p>
        ) : (
          <div className="leaderboard-table">
            {ranked.map((r, i) => (
              <div className="leaderboard-row" key={r.model}>
                <span className="rank">#{i + 1}</span>
                <span className="leaderboard-model">{r.model}</span>
                <span>
                  {r.w}W · {r.l}L
                </span>
                <b>{r.rate}%</b>
              </div>
            ))}
          </div>
        )}
        <h4>Your model usage</h4>
        {usageRows.length === 0 ? (
          <p className="muted small">No chats yet.</p>
        ) : (
          <div className="leaderboard-table">
            {usageRows.map(([model, u]) => (
              <div className="leaderboard-row" key={model}>
                <span className="leaderboard-model">{model}</span>
                <span>{u.chats} chats</span>
                <span>{fmt(u.tokens)}</span>
                <b>${u.cost.toFixed(3)}</b>
              </div>
            ))}
          </div>
        )}
        <p className="sheet-note">
          Local-only standings — unlike the public Arena leaderboard, nothing
          leaves this device.
        </p>
      </div>
    </div>
  );
}

function ModelPicker({
  providers,
  providerId,
  modelId,
  mode,
  options,
  pickA,
  pickB,
  onPickA,
  onPickB,
  onSelect,
  reasoning,
  onReasoning,
}: {
  providers: Provider[];
  providerId: string;
  modelId: string;
  mode: ChatMode;
  options: Array<{ key: string; label: string }>;
  pickA: string;
  pickB: string;
  onPickA: (key: string) => void;
  onPickB: (key: string) => void;
  onSelect: (provider: Provider, model: Provider["models"][number]) => void;
  reasoning: string;
  onReasoning: (value: string) => void;
}) {
  return (
    <div className="model-menu">
      <div className="menu-heading">Choose model</div>
      {providers.map((p) => (
        <div key={p.id}>
          <div className="model-provider-heading">
            {p.name} {p.is_default && <span>Default</span>}
          </div>
          {p.models.map((m) => (
            <button
              key={m.id}
              className={
                providerId === p.id && modelId === m.id ? "active" : ""
              }
              onClick={() => onSelect(p, m)}
            >
              <span>
                {m.displayName}
                <small>
                  {m.contextWindow
                    ? `${Math.round(m.contextWindow / 1000)}k context`
                    : ""}
                </small>
              </span>
              {providerId === p.id && modelId === m.id && <Check size={14} />}
            </button>
          ))}
        </div>
      ))}
      {providers.length === 0 && (
        <div className="muted small pad">
          Add a provider in Settings to fetch live models.
        </div>
      )}
      {(mode === "agent" || mode === "direct") && (
        <div className="compare-picks">
          <div className="menu-heading">Reasoning effort</div>
          <div className="reasoning-row">
            {["low", "medium", "high"].map((level) => (
              <button
                key={level}
                className={reasoning === level ? "active" : ""}
                onClick={() => onReasoning(level)}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === "side" && (
        <div className="compare-picks">
          <div className="menu-heading">Compare two models</div>
          <label>
            Model A
            <select value={pickA} onChange={(e) => onPickA(e.target.value)}>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model B
            <select value={pickB} onChange={(e) => onPickB(e.target.value)}>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {mode === "battle" && (
        <p className="muted small pad">
          Battle picks two different models at random and hides their names
          until you choose a winner.
        </p>
      )}
      {mode === "direct" && (
        <p className="muted small pad">
          Direct chats with one model at a time — no tools are offered.
        </p>
      )}
    </div>
  );
}

function CompareResult({
  result,
  battle,
  pick,
  revealed,
  onPick,
}: {
  result: any;
  battle: boolean;
  pick: number;
  revealed: boolean;
  onPick: (side: number) => void;
}) {
  const sides = [result?.a, result?.b];
  return (
    <div className="compare-grid">
      {sides.map((side, i) => (
        <div
          className={`compare-card ${battle && pick === i ? "winner" : ""}`}
          key={i}
        >
          <div className="compare-head">
            <b>
              {battle && !revealed
                ? `Model ${i === 0 ? "A" : "B"}`
                : (side?.model ?? `Model ${i === 0 ? "A" : "B"}`)}
            </b>
            {side?.ok && (
              <small>
                {formatDuration(side.latencyMs)} · {side.usage?.completion ?? 0}{" "}
                tokens
              </small>
            )}
            {battle && pick === i && (
              <span className="winner-badge">Winner</span>
            )}
          </div>
          <div className="compare-body">
            {side?.ok ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {side.text || "_(empty response)_"}
              </ReactMarkdown>
            ) : (
              <p className="compare-error">
                {side?.error ?? "This model did not respond."}
              </p>
            )}
          </div>
          {battle && !revealed && side?.ok && (
            <button className="outline-btn" onClick={() => onPick(i)}>
              Pick as winner
            </button>
          )}
          {battle && revealed && (
            <small className="muted">
              {side?.providerName} · {side?.model}
            </small>
          )}
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({
  tools,
  expandedGroup,
  onToggleGroup,
  expandedTool,
  onToggleTool,
  onOpenFile,
}: {
  tools: ToolItem[];
  expandedGroup: string;
  onToggleGroup: (key: string) => void;
  expandedTool: string;
  onToggleTool: (callId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const groups = groupActivities(tools);
  const files = activityFiles(tools);
  return (
    <div className="activity-feed">
      {groups.map((group) => (
        <div
          className={`activity-group ${group.running ? "running" : ""}`}
          key={group.key}
        >
          <button
            className="activity-summary"
            onClick={() => onToggleGroup(group.key)}
          >
            <span
              className={`activity-chevron ${expandedGroup === group.key ? "open" : ""}`}
            >
              <ChevronRight size={14} />
            </span>
            <span>{group.label}</span>
            {group.running ? (
              <span className="activity-working">Working…</span>
            ) : (
              <Check size={13} className="activity-done" />
            )}
          </button>
          {expandedGroup === group.key && (
            <div className="activity-rows">
              {group.tools.map((tool) => (
                <div className="activity-row-wrap" key={tool.callId}>
                  <button
                    className="activity-row"
                    onClick={() => onToggleTool(tool.callId)}
                  >
                    <span className="activity-used">used</span>
                    <b>{toolDisplayName(tool.toolName)}</b>
                    {tool.status === "running" ? (
                      <span className="activity-working">running…</span>
                    ) : (
                      <Check size={12} className="activity-done" />
                    )}
                    <span className="activity-duration">
                      {formatDuration(tool.durationMs)}
                    </span>
                  </button>
                  {expandedTool === tool.callId && (
                    <div className="activity-detail">
                      <div className="detail-label">{tool.summary}</div>
                      <pre>{JSON.stringify(tool.args, null, 2)}</pre>
                      {tool.result !== undefined && (
                        <>
                          <div className="detail-label">Result</div>
                          <pre>
                            {typeof tool.result === "string"
                              ? tool.result.slice(0, 4000)
                              : JSON.stringify(tool.result, null, 2).slice(
                                  0,
                                  4000,
                                )}
                          </pre>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {files.length > 0 && (
        <div className="activity-files">
          {files.map((path) => (
            <button
              className="activity-file-card"
              key={path}
              onClick={() => onOpenFile(path)}
              title={path}
            >
              <span className="file-ext">{fileExtension(path)}</span>
              <span className="activity-file-name">
                {path.split("/").pop()}
              </span>
              <small>{path}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AskCard({
  ask,
  onSubmit,
}: {
  ask: any;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  return (
    <div className="ask-card">
      <div className="ask-head">
        <CircleHelp size={17} />
        <b>{ask.question}</b>
        <span>Waiting for your response</span>
      </div>
      {ask.options?.length > 0 && (
        <div className="ask-options">
          {ask.options.map((o: any) => (
            <button key={o.value} onClick={() => onSubmit(o.value)}>
              {o.label}
            </button>
          ))}
          {ask.allow_other && (
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Other answer"
            />
          )}
        </div>
      )}
      {ask.type === "free_text" && (
        <div className="ask-free">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your response"
          />
          <button
            className="primary-btn"
            onClick={() => onSubmit(answer)}
            disabled={!answer.trim()}
          >
            Continue <ArrowUp size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
