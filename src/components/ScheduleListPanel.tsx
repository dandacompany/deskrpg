"use client";

import { useEffect, useState, useCallback } from "react";
import { useT } from "@/lib/i18n";
import { Timer, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import type { Socket } from "socket.io-client";
import ScheduleCreateForm from "./ScheduleCreateForm";

interface ScheduledTask {
  id: string;
  channelId: string;
  npcId: string;
  title: string;
  summary: string | null;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface NpcInfo {
  id: string;
  name: string;
}

interface ScheduleListPanelProps {
  channelId: string;
  socket: Socket | null;
  npcs: NpcInfo[];
  selectedNpcId?: string | null;
}

export default function ScheduleListPanel({ channelId, socket, npcs, selectedNpcId }: ScheduleListPanelProps) {
  const t = useT();
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createNpcId, setCreateNpcId] = useState<string | null>(selectedNpcId || null);

  useEffect(() => {
    if (!socket || !channelId) return;

    const handleListResponse = ({ schedules: list }: { schedules: ScheduledTask[] }) => {
      setSchedules(list);
    };
    const handleUpdated = ({ schedule, action }: { schedule: ScheduledTask; action: string }) => {
      if (action === "delete") {
        setSchedules((prev) => prev.filter((s) => s.id !== schedule.id));
      } else {
        setSchedules((prev) => {
          const idx = prev.findIndex((s) => s.id === schedule.id);
          if (idx >= 0) { const u = [...prev]; u[idx] = schedule; return u; }
          return [schedule, ...prev];
        });
      }
    };

    socket.on("schedule:list-response", handleListResponse);
    socket.on("schedule:updated", handleUpdated);
    socket.emit("schedule:list", { channelId });

    return () => {
      socket.off("schedule:list-response", handleListResponse);
      socket.off("schedule:updated", handleUpdated);
    };
  }, [socket, channelId]);

  const handleCreate = useCallback((data: { title: string; summary: string; cronExpr: string; timezone: string }) => {
    if (!socket || !createNpcId) return;
    socket.emit("schedule:create", { channelId, npcId: createNpcId, ...data });
    setShowCreateForm(false);
  }, [socket, channelId, createNpcId]);

  const handleToggle = useCallback((scheduleId: string, enabled: boolean) => {
    socket?.emit("schedule:toggle", { scheduleId, enabled });
  }, [socket]);

  const handleDelete = useCallback((scheduleId: string) => {
    socket?.emit("schedule:delete", { scheduleId });
  }, [socket]);

  const filtered = selectedNpcId ? schedules.filter((s) => s.npcId === selectedNpcId) : schedules;
  const npcMap = new Map(npcs.map((n) => [n.id, n.name]));

  return (
    <div className="space-y-2">
      {/* Create button */}
      {showCreateForm ? (
        <div className="space-y-2">
          {!selectedNpcId && (
            <select
              value={createNpcId || ""}
              onChange={(e) => setCreateNpcId(e.target.value || null)}
              className="w-full bg-surface text-text text-[11px] rounded px-2 py-1 border border-border"
            >
              <option value="">{t("schedule.selectNpc")}</option>
              {npcs.map((npc) => (
                <option key={npc.id} value={npc.id}>{npc.name}</option>
              ))}
            </select>
          )}
          <ScheduleCreateForm onSubmit={handleCreate} onCancel={() => setShowCreateForm(false)} />
        </div>
      ) : (
        <button
          onClick={() => { setCreateNpcId(selectedNpcId || null); setShowCreateForm(true); }}
          className="w-full border border-dashed border-primary/50 rounded-lg py-1.5 text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition"
        >
          + {t("schedule.createNew")}
        </button>
      )}

      {/* Schedule list */}
      {filtered.length === 0 && !showCreateForm && (
        <div className="text-center text-text-muted text-[11px] py-4">{t("schedule.empty")}</div>
      )}
      {filtered.map((s) => (
        <div key={s.id} className={`rounded-lg border p-2.5 ${s.enabled ? "border-border bg-surface" : "border-border/50 bg-surface/50 opacity-60"}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <Timer className="w-3 h-3 text-primary shrink-0" />
                <span className="text-[12px] font-bold text-text truncate">{s.title}</span>
              </div>
              {!selectedNpcId && (
                <div className="text-[10px] text-text-muted mt-0.5">{npcMap.get(s.npcId) || s.npcId}</div>
              )}
              <div className="text-[10px] text-text-dim font-mono mt-0.5">{s.cronExpr}</div>
              {s.nextRunAt && (
                <div className="text-[9px] text-text-dim mt-0.5">
                  {t("schedule.nextRun")}: {new Date(s.nextRunAt).toLocaleString("ko-KR", { timeZone: s.timezone })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => handleToggle(s.id, !s.enabled)}
                className={`p-1 rounded transition ${s.enabled ? "text-success hover:bg-success/10" : "text-text-muted hover:bg-white/5"}`}
                title={s.enabled ? t("schedule.disable") : t("schedule.enable")}
              >
                {s.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
              </button>
              <button
                onClick={() => handleDelete(s.id)}
                className="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition"
                title={t("common.delete")}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
