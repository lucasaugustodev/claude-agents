import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, apiFetch } from "../lib/api";

interface Member {
  agent_id: string;
  agent_name: string;
  role: string;
  last_seen?: string;
}

interface Schedule {
  id: string;
  cron: string;
  description: string;
  enabled: boolean;
}

interface GroupDetail {
  id: string;
  name: string;
  description?: string;
  status: "idle" | "running" | "completed";
  members: Member[];
  orchestrator?: { agent_id: string; agent_name: string };
  schedules?: Schedule[];
  created_at: string;
}

interface Message {
  id: string;
  sender_name: string;
  sender_type: "user" | "orchestrator" | "agent";
  content: string;
  created_at: string;
  delegations?: Delegation[];
  status?: "working" | "done";
}

interface Delegation {
  agent_name: string;
  task: string;
  status: "pending" | "running" | "done";
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isRecentlySeen(lastSeen?: string): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 300_000;
}

function cronToHuman(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  if (min === "*" && hour === "*") return "Every minute";
  if (hour === "*") return `Every hour at :${min.padStart(2, "0")}`;
  if (dom === "*" && mon === "*" && dow === "*") return `Daily at ${hour}:${min.padStart(2, "0")}`;
  if (dow !== "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayNames = dow.split(",").map(d => days[parseInt(d)] || d).join(", ");
    return `${dayNames} at ${hour}:${min.padStart(2, "0")}`;
  }
  return cron;
}

function renderContent(content: string) {
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const parts: (string | { lang: string; code: string })[] = [];
  let lastIndex = 0;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    parts.push({ lang: match[1] || "", code: match[2].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }
  return parts.map((part, i) => {
    if (typeof part === "string") {
      return (
        <span key={i} className="whitespace-pre-wrap break-words">
          {part.split(/(`[^`]+`)/).map((seg, j) =>
            seg.startsWith("`") && seg.endsWith("`") ? (
              <code key={j} className="bg-[var(--surface2)] px-1.5 py-0.5 rounded text-xs font-mono">{seg.slice(1, -1)}</code>
            ) : (
              <span key={j}>{seg}</span>
            )
          )}
        </span>
      );
    }
    return (
      <div key={i} className="my-2 rounded-lg overflow-hidden border border-[var(--border)]">
        {part.lang && (
          <div className="bg-[var(--border)] px-3 py-1 text-[10px] text-[var(--text-dim)] font-mono uppercase">{part.lang}</div>
        )}
        <pre className="bg-[var(--surface2)] p-3 overflow-x-auto text-xs font-mono leading-relaxed">
          <code>{part.code}</code>
        </pre>
      </div>
    );
  });
}

function senderColor(type: string): string {
  switch (type) {
    case "user": return "text-[var(--accent)]";
    case "orchestrator": return "text-[var(--orange)]";
    case "agent": return "text-[var(--blue)]";
    default: return "text-[var(--text)]";
  }
}

function avatarBg(type: string): string {
  switch (type) {
    case "user": return "bg-[var(--accent)]/20 text-[var(--accent)]";
    case "orchestrator": return "bg-[var(--orange)]/20 text-[var(--orange)]";
    case "agent": return "bg-[var(--blue)]/20 text-[var(--blue)]";
    default: return "bg-[var(--surface2)] text-[var(--text-dim)]";
  }
}

export function GroupChatViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [addingAgent, setAddingAgent] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    api<{ group_chat: GroupDetail }>(`/api/group-chats/${id}`)
      .then((d) => setGroup(d.group_chat))
      .catch(() => navigate("/group-chats"));
  }, [id, navigate]);

  useEffect(() => {
    if (!id) return;
    api<{ messages: Message[] }>(`/api/group-chats/${id}/messages`)
      .then((d) => {
        setMessages(d.messages || []);
        setTimeout(scrollToBottom, 50);
      })
      .catch(() => {});
  }, [id, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  async function loadAvailableAgents() {
    try {
      const data = await api<{ created: { id: string; name: string; slug: string }[]; added: { id: string; name: string; slug: string }[] }>("/api/agents/mine");
      const all = [...(data.created || []), ...(data.added || [])];
      const memberIds = new Set(group?.members.map((m) => m.agent_id) || []);
      setAvailableAgents(all.filter((a) => !memberIds.has(a.id)));
    } catch {
      setAvailableAgents([]);
    }
  }

  async function addMember(agentId: string) {
    if (!id || addingAgent) return;
    setAddingAgent(agentId);
    try {
      await api(`/api/group-chats/${id}/members`, {
        method: "POST",
        body: JSON.stringify({ agent_id: agentId }),
      });
      const data = await api<{ group_chat: GroupDetail }>(`/api/group-chats/${id}`);
      setGroup(data.group_chat);
      setShowAddMember(false);
    } catch (e: any) {
      alert(e.message);
    }
    setAddingAgent(null);
  }

  async function toggleSchedule(scheduleId: string, enabled: boolean) {
    if (!id) return;
    try {
      await api(`/api/group-chats/${id}/schedules/${scheduleId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      setGroup((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          schedules: prev.schedules?.map((s) =>
            s.id === scheduleId ? { ...s, enabled } : s
          ),
        };
      });
    } catch {}
  }

  function handleEvent(evType: string, data: any) {
    switch (evType) {
      case "message.user":
        setMessages((prev) => [...prev, {
          id: data.id || crypto.randomUUID(),
          sender_name: data.sender_name || "You",
          sender_type: "user",
          content: data.content,
          created_at: data.created_at || new Date().toISOString(),
        }]);
        break;
      case "message.orchestrator":
        setMessages((prev) => {
          const existing = prev.findIndex((m) => m.id === data.id);
          const msg: Message = {
            id: data.id || crypto.randomUUID(),
            sender_name: data.sender_name || "Orchestrator",
            sender_type: "orchestrator",
            content: data.content || "",
            created_at: data.created_at || new Date().toISOString(),
            delegations: data.delegations,
          };
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = msg;
            return updated;
          }
          return [...prev, msg];
        });
        break;
      case "message.agent_started":
        setMessages((prev) => [...prev, {
          id: data.id || crypto.randomUUID(),
          sender_name: data.agent_name || "Agent",
          sender_type: "agent",
          content: "",
          created_at: data.created_at || new Date().toISOString(),
          status: "working",
        }]);
        break;
      case "message.agent_output":
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === data.id);
          if (idx < 0) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            content: (updated[idx].content || "") + (data.chunk || data.content || ""),
          };
          return updated;
        });
        break;
      case "message.agent_completed":
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === data.id);
          if (idx < 0) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            content: data.content || updated[idx].content,
            status: "done",
          };
          return updated;
        });
        break;
      case "message.schedule_created":
        setGroup((prev) => {
          if (!prev) return prev;
          const schedule: Schedule = {
            id: data.id || crypto.randomUUID(),
            cron: data.cron || "",
            description: data.description || "",
            enabled: true,
          };
          return { ...prev, schedules: [...(prev.schedules || []), schedule] };
        });
        break;
      case "group.completed":
        setGroup((prev) => prev ? { ...prev, status: "completed" } : prev);
        break;
    }
  }

  async function send() {
    if (!input.trim() || sending || !id) return;
    const content = input.trim();
    setInput("");
    setSending(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      const res = await apiFetch(`/api/group-chats/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });

      setGroup((prev) => prev ? { ...prev, status: "running" } : prev);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        let evType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) evType = line.slice(7);
          else if (line.startsWith("data: ") && evType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleEvent(evType, data);
            } catch {}
            evType = "";
          }
        }
      }
    } catch (e: any) {
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        sender_name: "System",
        sender_type: "orchestrator",
        content: `Error: ${e.message}`,
        created_at: new Date().toISOString(),
      }]);
    }
    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function autoResize(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
    setInput(el.value);
  }

  if (!group) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-dim)]">
        <p className="text-sm">Loading group chat...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left Sidebar */}
      <div className="w-64 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-y-auto">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <button
              onClick={() => navigate("/group-chats")}
              className="text-xs text-[var(--text-dim)] hover:text-[var(--text)] transition-colors flex items-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15,18 9,12 15,6" />
              </svg>
              Back
            </button>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
              group.status === "running"
                ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                : group.status === "completed"
                ? "bg-[var(--green)]/10 text-[var(--green)]"
                : "bg-[var(--surface2)] text-[var(--text-dim)]"
            }`}>
              {group.status === "running" && <span className="inline-block w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse mr-1 align-middle" />}
              {group.status}
            </span>
          </div>
          <h2 className="text-sm font-semibold mt-2 truncate">{group.name}</h2>
          {group.description && (
            <p className="text-[10px] text-[var(--text-dim)] mt-1 line-clamp-2">{group.description}</p>
          )}
        </div>

        {/* Orchestrator */}
        {group.orchestrator && (
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <h3 className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider font-semibold mb-2">Orchestrator</h3>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-[var(--orange)]/20 text-[var(--orange)] flex items-center justify-center text-xs font-bold">
                {group.orchestrator.agent_name.charAt(0).toUpperCase()}
              </div>
              <span className="text-xs font-medium truncate">{group.orchestrator.agent_name}</span>
            </div>
          </div>
        )}

        {/* Members */}
        <div className="px-4 py-3 border-b border-[var(--border)] flex-1">
          <h3 className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider font-semibold mb-2">
            Members ({group.members.length})
          </h3>
          <div className="space-y-2">
            {group.members.map((m) => (
              <div key={m.agent_id} className="flex items-center gap-2">
                <div className="relative">
                  <div className="w-7 h-7 rounded-full bg-[var(--blue)]/20 text-[var(--blue)] flex items-center justify-center text-xs font-bold">
                    {m.agent_name.charAt(0).toUpperCase()}
                  </div>
                  <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--surface)] ${
                    isRecentlySeen(m.last_seen) ? "bg-[var(--green)]" : "bg-[var(--surface2)]"
                  }`} />
                </div>
                <div className="min-w-0">
                  <span className="text-xs font-medium truncate block">{m.agent_name}</span>
                  {m.role && m.role !== "member" && (
                    <span className="text-[9px] text-[var(--text-dim)]">{m.role}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Schedules */}
        {group.schedules && group.schedules.length > 0 && (
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <h3 className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider font-semibold mb-2">Schedules</h3>
            <div className="space-y-2">
              {group.schedules.map((s) => (
                <div key={s.id} className="flex items-center justify-between">
                  <div className="min-w-0 mr-2">
                    <p className="text-xs truncate">{s.description || cronToHuman(s.cron)}</p>
                    <p className="text-[9px] text-[var(--text-dim)] font-mono">{s.cron}</p>
                  </div>
                  <button
                    onClick={() => toggleSchedule(s.id, !s.enabled)}
                    className={`w-8 h-4 rounded-full transition-colors shrink-0 relative ${
                      s.enabled ? "bg-[var(--accent)]" : "bg-[var(--surface2)]"
                    }`}
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                      s.enabled ? "left-4" : "left-0.5"
                    }`} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add Member Button */}
        <div className="px-4 py-3">
          <button
            onClick={() => { setShowAddMember(true); loadAvailableAgents(); }}
            className="w-full py-2 text-xs text-[var(--accent)] border border-[var(--accent)]/30 rounded-lg hover:bg-[var(--accent)]/5 transition-colors font-medium"
          >
            + Add Member
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bg)]">
        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-[var(--text-dim)]">
              <div className="text-center">
                <svg className="inline w-10 h-10 mb-3 text-[var(--text-dim)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <p className="text-sm">Send a message to start the group chat</p>
                <p className="text-xs mt-1">The orchestrator will delegate tasks to the agents</p>
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-3 group">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarBg(msg.sender_type)}`}>
                {msg.sender_name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-0.5">
                  <span className={`text-sm font-semibold ${senderColor(msg.sender_type)}`}>
                    {msg.sender_name}
                  </span>
                  <span className="text-[10px] text-[var(--text-dim)] opacity-0 group-hover:opacity-100 transition-opacity">
                    {timeAgo(msg.created_at)}
                  </span>
                  {msg.status === "working" && (
                    <span className="text-[10px] text-[var(--accent)] flex items-center gap-1">
                      <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" />
                      Working...
                    </span>
                  )}
                </div>
                <div className="text-sm text-[var(--text)] leading-relaxed">
                  {msg.content ? renderContent(msg.content) : (
                    msg.status === "working" && (
                      <span className="text-xs text-[var(--text-dim)] italic">Processing...</span>
                    )
                  )}
                </div>
                {/* Delegation Task Board */}
                {msg.delegations && msg.delegations.length > 0 && (
                  <div className="bg-[var(--surface2)] border border-[var(--border)] rounded-lg p-3 my-2 max-w-lg">
                    <div className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
                      </svg>
                      Delegating Tasks
                    </div>
                    <div className="space-y-1.5">
                      {msg.delegations.map((d, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="truncate mr-2">
                            <span className="text-[var(--blue)] font-medium">@{d.agent_name}</span>
                            <span className="text-[var(--text-dim)]">: {d.task}</span>
                          </span>
                          <span className={`shrink-0 flex items-center gap-1 text-[10px] font-medium ${
                            d.status === "done"
                              ? "text-[var(--green)]"
                              : d.status === "running"
                              ? "text-[var(--accent)]"
                              : "text-[var(--text-dim)]"
                          }`}>
                            {d.status === "done" && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20,6 9,17 4,12" />
                              </svg>
                            )}
                            {d.status === "running" && (
                              <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" />
                            )}
                            {d.status === "pending" && (
                              <span className="w-1.5 h-1.5 bg-[var(--text-dim)] rounded-full" />
                            )}
                            {d.status.charAt(0).toUpperCase() + d.status.slice(1)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && messages.length > 0 && messages[messages.length - 1]?.sender_type === "user" && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-[var(--orange)]/20 text-[var(--orange)] flex items-center justify-center text-xs font-bold shrink-0">
                O
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--orange)]">Orchestrator</span>
                <span className="flex items-center gap-1 text-xs text-[var(--text-dim)]">
                  <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" />
                  <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" style={{ animationDelay: "0.2s" }} />
                  <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" style={{ animationDelay: "0.4s" }} />
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="bg-[var(--surface)] border-t border-[var(--border)] p-4">
          <div className="flex items-end gap-3 max-w-[900px] mx-auto">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={autoResize}
              onKeyDown={handleKeyDown}
              placeholder="Send a message to the group..."
              className="flex-1 bg-[var(--surface2)] border border-[var(--border)] rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-[var(--accent)] max-h-40 leading-relaxed"
              rows={1}
              disabled={sending}
            />
            <button
              onClick={send}
              disabled={!input.trim() || sending}
              className="bg-[var(--accent)] text-white rounded-lg px-4 py-3 text-sm font-medium disabled:opacity-50 hover:bg-[var(--accent-hover)] transition-colors shrink-0"
            >
              {sending ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22,2 15,22 11,13 2,9" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Add Member Modal */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setShowAddMember(false)}>
          <div
            className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 w-[420px] max-w-[90vw] max-h-[70vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Add Member</h2>
              <button
                onClick={() => setShowAddMember(false)}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--surface2)] text-[var(--text-dim)]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {availableAgents.length === 0 ? (
              <p className="text-xs text-[var(--text-dim)] text-center py-6">No more agents available to add.</p>
            ) : (
              <div className="space-y-2">
                {availableAgents.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/30 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-[var(--blue)]/20 text-[var(--blue)] flex items-center justify-center text-xs font-bold">
                        {a.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <span className="text-sm font-medium">{a.name}</span>
                        <span className="text-[10px] text-[var(--text-dim)] ml-2">{a.slug}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => addMember(a.id)}
                      disabled={addingAgent === a.id}
                      className="px-3 py-1 text-xs bg-[var(--accent)] text-white rounded-lg disabled:opacity-50 hover:bg-[var(--accent-hover)] transition-colors"
                    >
                      {addingAgent === a.id ? "Adding..." : "Add"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
