"use client";

interface MeetingSpeechBubbleProps {
  preview: string | null;
  visible: boolean;
}

export default function MeetingSpeechBubble({
  preview,
  visible,
}: MeetingSpeechBubbleProps) {
  if (!visible) return null;

  return (
    <div className="absolute -top-14 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
      <div className="min-w-[68px] max-w-[190px] rounded-2xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-medium leading-tight text-slate-900 shadow-[0_10px_30px_rgba(15,23,42,0.28)]">
        <div className="flex items-center gap-1">
          <span className="block whitespace-pre-wrap break-words">
            {preview || "..."}
          </span>
          <span className="flex items-center gap-0.5 text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:240ms]" />
          </span>
        </div>
      </div>
      <div className="absolute left-1/2 top-full h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-slate-200 bg-white" />
    </div>
  );
}
