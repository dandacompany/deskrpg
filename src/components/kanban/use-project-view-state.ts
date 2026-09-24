"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { KanbanTask } from "@/lib/hermes/deskrpg-plugin-types";
import {
  applyFilter,
  DEFAULT_VIEW_STATE,
  groupTasks,
  normalizeViewState,
  sortTasks,
  type ProjectViewState,
  type TaskGroup,
} from "@/lib/kanban-view-state";

const STORAGE_PREFIX = "deskrpg.kanban.view.";

/**
 * Holds view state and folds the task list to match it.
 *
 * Persisted per-channel in `localStorage` — how a person views things is their preference, not a
 * server fact. Reads are assumed to be able to fail at any time (private browsing, blocked
 * storage) and fall back to defaults.
 */
export function useProjectViewState(channelId: string) {
  const [state, setState] = useState<ProjectViewState>(DEFAULT_VIEW_STATE);

  // When the channel changes, read that channel's stored value. Not reading it on the first
  // render keeps server rendering and client rendering from diverging.
  useEffect(() => {
    setState(readStored(channelId));
  }, [channelId]);

  const update = useCallback(
    (patch: Partial<ProjectViewState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        writeStored(channelId, next);
        return next;
      });
    },
    [channelId],
  );

  const setFilter = useCallback(
    (patch: Partial<ProjectViewState["filter"]>) => {
      setState((prev) => {
        const next = { ...prev, filter: { ...prev.filter, ...patch } };
        writeStored(channelId, next);
        return next;
      });
    },
    [channelId],
  );

  const toggleGroup = useCallback(
    (key: string) => {
      setState((prev) => {
        const has = prev.collapsedGroups.includes(key);
        const next = {
          ...prev,
          collapsedGroups: has
            ? prev.collapsedGroups.filter((k) => k !== key)
            : [...prev.collapsedGroups, key],
        };
        writeStored(channelId, next);
        return next;
      });
    },
    [channelId],
  );

  return { state, update, setFilter, toggleGroup };
}

/**
 * Filters, sorts, and groups the task list according to view state.
 *
 * Split from the state hook because of ordering — `includeArchived` is needed **before** fetching
 * the board, while grouping can only happen **after** the response arrives. Combining them into
 * one hook would make the board fetch wait on its own result.
 */
export function useTaskGroups(
  tasks: readonly KanbanTask[],
  state: ProjectViewState,
  known: { tenants?: readonly string[]; assignees?: readonly string[] },
): TaskGroup[] {
  const { tenants, assignees } = known;
  return useMemo(() => {
    const filtered = applyFilter(tasks, state.filter);
    const sorted = sortTasks(filtered, state.sortField, state.sortDir);
    return groupTasks(sorted, state.groupBy, { tenants, assignees });
  }, [tasks, state.filter, state.sortField, state.sortDir, state.groupBy, tenants, assignees]);
}

function readStored(channelId: string): ProjectViewState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + channelId);
    return normalizeViewState(raw ? JSON.parse(raw) : null);
  } catch {
    // Storage is blocked or the value is corrupted. It's only a view preference, so fall back to defaults silently.
    return DEFAULT_VIEW_STATE;
  }
}

function writeStored(channelId: string, state: ProjectViewState): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + channelId, JSON.stringify(state));
  } catch {
    // Even if the write fails, this session's screen keeps working as-is.
  }
}
