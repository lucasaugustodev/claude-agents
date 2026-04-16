import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

interface GroupChat {
  id: string;
  name: string;
  description?: string;
  status: "idle" | "running" | "completed";
  members: { agent_id: string; agent_name: string; role: string }[];
  last_message?: { content: string; sender_name: string; created_at: string };
  created_at: string;
  updated_at: string;
}

interface Agent {
  id: string;
  name: string;
  slug: string;
  description?: string;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}min ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 172800_000) return "yesterday";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    idle: "bg-[var(--surface2)] text-[var(--text-dim)]",
    running: "bg-[var(--accent)]/10 text-[var(--accent)]",
    completed: "bg-[var(--green)]/10 text-[var(--green)]",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium inline-flex items-center gap-1.5 ${styles[status] || styles.idle}`}>
      {status === "running" && <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" />}
      {status}
    </span>
  );
}

export function GroupChatsPage() {
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadGroups();
  }, []);

  async function loadGroups() {
    try {
      const data = await api<{ group_chats: GroupChat[] }>("/api/group-chats");
      setGroups(data.group_chats || []);
    } catch {
      setGroups([]);
    }
    setLoading(false);
  }

  async function loadAgents() {
    try {
      const data = await api<{ created: Agent[]; added: Agent[] }>("/api/agents/mine");
      setAgents([...(data.created || []), ...(data.added || [])]);
    } catch {
      setAgents([]);
    }
  }

  useEffect(() => {
    if (showCreate) loadAgents();
  }, [showCreate]);

  function toggleAgent(id: string) {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const { group_chat } = await api<{ group_chat: GroupChat }>("/api/group-chats", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim() || undefined,
          agent_ids: Array.from(selectedAgents),
        }),
      });
      navigate(`/group-chats/${group_chat.id}`);
    } catch (e: any) {
      alert(e.message);
    }
    setCreating(false);
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-[900px] mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold">Group Chats</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90"
          >
            + New Group
          </button>
        </div>

        {loading ? (
          <div className="text-center text-[var(--text-dim)] py-16">
            <p className="text-sm">Loading...</p>
          </div>
        ) : groups.length === 0 && !showCreate ? (
          <div className="text-center text-[var(--text-dim)] py-16">
            <div className="mb-4">
              <svg className="inline w-12 h-12 text-[var(--text-dim)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <p className="text-sm mb-2">No group chats yet</p>
            <p className="text-xs mb-4">Create a group to have multiple agents collaborate</p>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm"
            >
              Create your first group
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div
                key={g.id}
                onClick={() => navigate(`/group-chats/${g.id}`)}
                className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 hover:border-[var(--accent)]/30 cursor-pointer transition-colors"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center text-[var(--accent)] font-bold text-sm shrink-0">
                      {g.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold truncate">{g.name}</h3>
                      {g.description && (
                        <p className="text-xs text-[var(--text-dim)] truncate mt-0.5">{g.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <StatusBadge status={g.status} />
                    <span className="text-[10px] text-[var(--text-dim)]">
                      {timeAgo(g.updated_at || g.created_at)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider font-medium">
                      {g.members?.length || 0} member{(g.members?.length || 0) !== 1 ? "s" : ""}
                    </span>
                    <div className="flex -space-x-1.5">
                      {(g.members || []).slice(0, 5).map((m, i) => (
                        <div
                          key={i}
                          className="w-5 h-5 rounded-full bg-[var(--surface2)] border border-[var(--border)] flex items-center justify-center text-[8px] text-[var(--text-dim)] font-medium"
                          title={m.agent_name}
                        >
                          {m.agent_name?.charAt(0).toUpperCase() || "?"}
                        </div>
                      ))}
                      {(g.members?.length || 0) > 5 && (
                        <div className="w-5 h-5 rounded-full bg-[var(--surface2)] border border-[var(--border)] flex items-center justify-center text-[8px] text-[var(--text-dim)]">
                          +{g.members.length - 5}
                        </div>
                      )}
                    </div>
                  </div>
                  {g.last_message && (
                    <p className="text-xs text-[var(--text-dim)] truncate max-w-[400px]">
                      <span className="font-medium text-[var(--text)]">{g.last_message.sender_name}:</span>{" "}
                      {g.last_message.content.slice(0, 80)}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Create Modal */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setShowCreate(false)}>
            <div
              className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold">Create Group Chat</h2>
                <button
                  onClick={() => setShowCreate(false)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--surface2)] text-[var(--text-dim)]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              <label className="block text-xs text-[var(--text-dim)] mb-1.5 font-medium">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Product Team"
                className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm mb-4 focus:outline-none focus:border-[var(--accent)]"
                autoFocus
              />

              <label className="block text-xs text-[var(--text-dim)] mb-1.5 font-medium">Description</label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="What is this group about? (optional)"
                className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm mb-4 resize-none focus:outline-none focus:border-[var(--accent)]"
                rows={2}
              />

              <label className="block text-xs text-[var(--text-dim)] mb-2 font-medium">Select Agents</label>
              {agents.length === 0 ? (
                <p className="text-xs text-[var(--text-dim)] mb-4">No agents available. Create agents first.</p>
              ) : (
                <div className="flex flex-wrap gap-2 mb-5">
                  {agents.map((a) => {
                    const selected = selectedAgents.has(a.id);
                    return (
                      <button
                        key={a.id}
                        onClick={() => toggleAgent(a.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                          selected
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                            : "border-[var(--border)] bg-[var(--surface2)] text-[var(--text-dim)] hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
                        }`}
                        title={a.description || a.slug}
                      >
                        {selected && (
                          <svg className="inline w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20,6 9,17 4,12" />
                          </svg>
                        )}
                        {a.name}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-[var(--border)]">
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 text-sm text-[var(--text-dim)] hover:text-[var(--text)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={create}
                  disabled={!name.trim() || selectedAgents.size === 0 || creating}
                  className="px-5 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-[var(--accent-hover)] transition-colors"
                >
                  {creating ? "Creating..." : `Create Group (${selectedAgents.size} agents)`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
