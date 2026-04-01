'use client';

import { useCallback } from 'react';
import { getLocalizedErrorMessage } from '@/lib/i18n/error-codes';
import type { TiledMap, TiledTileset } from './useMapEditor';
import type { TilesetImageInfo } from './useMapEditor';
import { createDefaultMap } from './useMapEditor';
import { getProjectMapDataForLoad } from '../project-load';

// === Types ===

export interface ProjectData {
  project: {
    id: string;
    name: string;
    tiledJson: TiledMap;
    thumbnail: string | null;
    settings: Record<string, unknown>;
  };
  tilesets: Array<{
    id: string;
    name: string;
    tilewidth: number;
    tileheight: number;
    columns: number;
    tilecount: number;
    image: string;
    firstgid: number;
  }>;
  stamps: Array<{
    id: string;
    name: string;
    cols: number;
    rows: number;
    thumbnail: string | null;
    layerNames: string[];
  }>;
}

export interface UseProjectManagerOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatch: (action: any) => void;
  addBuiltinTileset: (mapData: TiledMap) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

// === Hook ===

export function useProjectManager({ dispatch, addBuiltinTileset, t }: UseProjectManagerOptions) {
  const getResponseErrorMessage = useCallback(
    async (res: Response, fallbackKey: string) => {
      const data = await res.json().catch(() => null);
      return getLocalizedErrorMessage(t, data, fallbackKey);
    },
    [t]
  );

  /**
   * Load a project from the API, convert tileset base64 images to HTMLImageElement,
   * and dispatch SET_MAP + ADD_TILESET actions.
   */
  const loadProject = useCallback(
    async (projectId: string): Promise<ProjectData> => {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'errors.failedToFetchProject'));
      }
      const data: ProjectData = await res.json();

      const { project, tilesets } = data;

      // Prefer linked DB tilesets when available, but preserve embedded tilesets for built-in samples.
      const mapData = getProjectMapDataForLoad(project.tiledJson, tilesets) as TiledMap;

      dispatch({
        type: 'SET_MAP',
        mapData,
        projectName: project.name,
        projectId: project.id,
        templateId: null,
      });

      // Load each tileset image from DB and dispatch ADD_TILESET
      for (const ts of tilesets) {
        const img = new Image();
        img.src = ts.image;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(t('errors.failedToFetchProject')));
        });

        const tileset: TiledTileset = {
          firstgid: ts.firstgid,
          name: ts.name,
          tilewidth: ts.tilewidth,
          tileheight: ts.tileheight,
          tilecount: ts.tilecount,
          columns: ts.columns,
          image: ts.image,
          imagewidth: ts.columns * ts.tilewidth,
          imageheight: Math.ceil(ts.tilecount / ts.columns) * ts.tileheight,
        };

        const imageInfo: TilesetImageInfo = {
          img,
          firstgid: ts.firstgid,
          columns: ts.columns,
          tilewidth: ts.tilewidth,
          tileheight: ts.tileheight,
          tilecount: ts.tilecount,
          name: ts.name,
        };

        dispatch({ type: 'ADD_TILESET', tileset, imageInfo });
      }

      return data;
    },
    [dispatch, getResponseErrorMessage, t]
  );

  /**
   * Save a project to the API and dispatch MARK_CLEAN.
   */
  const saveProject = useCallback(
    async (
      projectId: string,
      mapData: TiledMap,
      thumbnail: string | null,
      settings?: Record<string, unknown>,
      name?: string
    ): Promise<void> => {
      const body: Record<string, unknown> = { tiledJson: mapData, thumbnail };
      if (settings !== undefined) body.settings = settings;
      if (name !== undefined) body.name = name;

      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'errors.failedToSaveProject'));
      }

      dispatch({ type: 'MARK_CLEAN' });
    },
    [dispatch, getResponseErrorMessage]
  );

  /**
   * Create a new project via the API, dispatch SET_MAP + addBuiltinTileset.
   */
  const createProject = useCallback(
    async (
      name: string,
      cols: number,
      rows: number,
      tileWidth: number,
      tileHeight: number
    ): Promise<{ id: string; createdBy: string | null }> => {
      void tileHeight;
      const mapData = createDefaultMap(name, cols, rows, tileWidth);

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tiledJson: mapData, settings: {} }),
      });

      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'errors.failedToCreateProject'));
      }

      const created = await res.json();

      dispatch({
        type: 'SET_MAP',
        mapData,
        projectName: created.name,
        projectId: created.id,
        templateId: null,
      });

      addBuiltinTileset(mapData);

      return { id: created.id as string, createdBy: (created.createdBy ?? created.created_by ?? null) as string | null };
    },
    [dispatch, addBuiltinTileset, getResponseErrorMessage]
  );

  /**
   * Link a tileset to a project.
   */
  const linkTileset = useCallback(
    async (projectId: string, tilesetId: string, firstgid: number): Promise<void> => {
      const res = await fetch(`/api/projects/${projectId}/tilesets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tilesetId, firstgid }),
      });

      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'errors.failedToLinkTileset'));
      }
    },
    [getResponseErrorMessage]
  );

  /**
   * Unlink a tileset from a project.
   */
  const unlinkTileset = useCallback(
    async (projectId: string, tilesetId: string): Promise<void> => {
      const res = await fetch(`/api/projects/${projectId}/tilesets/${tilesetId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'errors.failedToUnlinkTileset'));
      }
    },
    [getResponseErrorMessage]
  );

  /**
   * Link a stamp to a project.
   */
  const linkStamp = useCallback(
    async (projectId: string, stampId: string): Promise<void> => {
      const res = await fetch(`/api/projects/${projectId}/stamps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stampId }),
      });

      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'errors.failedToLinkStamp'));
      }
    },
    [getResponseErrorMessage]
  );

  /**
   * Unlink a stamp from a project.
   */
  const unlinkStamp = useCallback(
    async (projectId: string, stampId: string): Promise<void> => {
      const res = await fetch(`/api/projects/${projectId}/stamps/${stampId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error(await getResponseErrorMessage(res, 'errors.failedToUnlinkStamp'));
      }
    },
    [getResponseErrorMessage]
  );

  return {
    loadProject,
    saveProject,
    createProject,
    linkTileset,
    unlinkTileset,
    linkStamp,
    unlinkStamp,
  };
}
