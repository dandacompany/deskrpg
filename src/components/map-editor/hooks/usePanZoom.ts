'use client';

import { useRef, useCallback } from 'react';
import type { EditorState, EditorAction } from './useMapEditor';

interface PanState {
  isPanning: boolean;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
}

type Dispatch = React.Dispatch<EditorAction>;

export function usePanZoom(state: EditorState, dispatch: Dispatch) {
  const panRef = useRef<PanState>({
    isPanning: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
  });

  const handleWheel = useCallback(
    (e: React.WheelEvent | WheelEvent, canvasRect: DOMRect) => {

      if (e.ctrlKey || e.metaKey) {
        // Cmd/Ctrl + scroll = zoom (cursor-anchored)
        const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newZoom = Math.max(0.5, Math.min(8, state.zoom * zoomFactor));
        const mouseX = e.clientX - canvasRect.left;
        const mouseY = e.clientY - canvasRect.top;
        const scale = newZoom / state.zoom;
        const newPanX = mouseX - scale * (mouseX - state.panX);
        const newPanY = mouseY - scale * (mouseY - state.panY);
        dispatch({ type: 'SET_ZOOM', zoom: newZoom });
        dispatch({ type: 'SET_PAN', panX: newPanX, panY: newPanY });
      } else if (e.shiftKey) {
        // Shift + scroll = pan horizontal
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        dispatch({ type: 'SET_PAN', panX: state.panX - delta, panY: state.panY });
      } else {
        // Scroll = pan vertical
        dispatch({ type: 'SET_PAN', panX: state.panX, panY: state.panY - e.deltaY });
      }
    },
    [state.zoom, state.panX, state.panY, dispatch],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent | MouseEvent, _canvasRect: DOMRect): boolean => {
      // Middle-click (button 1) or pan tool with left-click
      const isMiddleClick = e.button === 1;
      const isPanTool = state.tool === 'pan' && e.button === 0;

      if (!isMiddleClick && !isPanTool) return false;

      e.preventDefault();
      const ps = panRef.current;
      ps.isPanning = true;
      ps.startX = e.clientX;
      ps.startY = e.clientY;
      ps.startPanX = state.panX;
      ps.startPanY = state.panY;

      return true;
    },
    [state.tool, state.panX, state.panY],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent | MouseEvent): boolean => {
      const ps = panRef.current;
      if (!ps.isPanning) return false;

      dispatch({
        type: 'SET_PAN',
        panX: ps.startPanX + (e.clientX - ps.startX),
        panY: ps.startPanY + (e.clientY - ps.startY),
      });

      return true;
    },
    [dispatch],
  );

  const handleMouseUp = useCallback(() => {
    panRef.current.isPanning = false;
  }, []);

  return { handleWheel, handleMouseDown, handleMouseMove, handleMouseUp };
}
