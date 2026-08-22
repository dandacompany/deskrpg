"use client";

import { useState, type ReactNode } from "react";

interface DroppableColumnProps {
  status: string;
  onDrop: (taskId: string, fromStatus: string, toStatus: string) => void;
  children: ReactNode;
  header: ReactNode;
  className?: string;
}

export default function DroppableColumn({
  status,
  onDrop,
  children,
  header,
  className = "",
}: DroppableColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const taskId = e.dataTransfer.getData("text/task-id");
    const fromStatus = e.dataTransfer.getData("text/from-status");
    if (!taskId || fromStatus === status) return;

    onDrop(taskId, fromStatus, status);
  };

  return (
    <div
      className={`flex-1 bg-surface rounded-lg p-2.5 flex flex-col transition-all ${
        isDragOver ? "ring-2 ring-primary/60 bg-primary/5" : ""
      } ${className}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {header}
      <div className="flex-1 overflow-y-auto space-y-2">{children}</div>
    </div>
  );
}
