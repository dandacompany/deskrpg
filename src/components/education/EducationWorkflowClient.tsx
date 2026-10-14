"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BookOpenCheck, CircleAlert, LoaderCircle, Plus, RefreshCw } from "lucide-react";

type Candidate = { id: string; title: string; rationale: string; audience?: string | null; deliverable?: string | null };
type Workflow = {
  id: string; title: string; requestText: string; stage: string; status: string; version: number;
  source: string; createdAt: string; updatedAt: string; state: Record<string, unknown>;
  events?: Array<{ id: string; version: number; action: string; actor: string; createdAt: string; payload: Record<string, unknown> }>;
};

const STAGES: Record<string, string> = {
  topic_recommendation: "주제 추천", topic_selected: "주제 선택", brief_confirmed: "교육 목표 확정",
  team_selected: "참여 팀 선택", researching: "자료 조사", evidence_review: "자료 검토",
  outline_review: "구성안 검토", cards_and_diagrams: "카드·도식 제작", document_draft: "문서 초안",
  final_review: "최종 검토",
};
const TEAM = ["atlas", "forge", "vector", "nova", "metric", "guard", "scout", "market", "slides"];
const TEAM_NAME: Record<string, string> = {
  atlas: "Atlas · AI 연구", forge: "Forge · 개발", vector: "Vector · Physical AI", nova: "Nova · AX·PoC",
  metric: "Metric · 데이터 분석", guard: "Guard · QA·문서", scout: "Scout · 출처 조사", market: "Market · 시장 조사", slides: "Slides · 발표 자료",
};

async function jsonFetch(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.errorCode === "string" ? data.errorCode : `HTTP ${response.status}`);
  return data;
}

export default function EducationWorkflowClient() {
  const [rows, setRows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [title, setTitle] = useState("");
  const [requestText, setRequestText] = useState("");
  const [candidateLines, setCandidateLines] = useState("");
  const [audience, setAudience] = useState("개발·영업·사무 조직 임직원");
  const [objective, setObjective] = useState("AI를 안전하게 활용하고 주요 보안 위험과 대응 방법을 이해한다.");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [deliverable, setDeliverable] = useState("교육안, 발표 자료, 한 장 요약 카드");
  const [outlineText, setOutlineText] = useState("");
  const [cardsText, setCardsText] = useState("");
  const [documentDraft, setDocumentDraft] = useState("");
  const [team, setTeam] = useState<string[]>(["atlas", "guard"]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (id = selectedId) => {
    const list = await jsonFetch("/api/education-workflows?limit=50");
    const workflows = Array.isArray(list.workflows) ? list.workflows as Workflow[] : [];
    setRows(workflows);
    const chosenId = id || workflows[0]?.id || "";
    setSelectedId(chosenId);
    if (chosenId) {
      const detail = await jsonFetch(`/api/education-workflows/${encodeURIComponent(chosenId)}`);
      setSelected(detail.workflow as Workflow);
    } else setSelected(null);
  }, [selectedId]);

  useEffect(() => {
    let live = true;
    const query = new URLSearchParams(window.location.search);
    const initialId = query.get("taskId") ?? "";
    setSelectedId(initialId);
    void (async () => {
      try { await refresh(initialId); }
      catch (err) { if (live) setError(err instanceof Error ? err.message : "불러오기에 실패했습니다."); }
      finally { if (live) setLoading(false); }
    })();
    const timer = window.setInterval(() => { if (!busy) void refresh().catch(() => undefined); }, 4000);
    return () => { live = false; window.clearInterval(timer); };
  }, [refresh, busy]);

  const candidates = useMemo(() => Array.isArray(selected?.state.candidates) ? selected.state.candidates as Candidate[] : [], [selected]);

  async function createWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const data = await jsonFetch("/api/education-workflows", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ title, requestText }),
      });
      const id = (data.workflow as Workflow).id;
      setTitle(""); setRequestText("");
      window.history.replaceState({}, "", `/workflows/education?taskId=${encodeURIComponent(id)}`);
      await refresh(id);
    } catch (err) { setError(err instanceof Error ? err.message : "작업 생성에 실패했습니다."); }
    finally { setBusy(false); }
  }

  async function act(action: string, payload: Record<string, unknown> = {}) {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await jsonFetch(`/api/education-workflows/${encodeURIComponent(selected.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedVersion: selected.version, action, payload }),
      });
      await refresh(selected.id);
    } catch (err) {
      setError(err instanceof Error && err.message === "stale_version" ? "다른 화면에서 먼저 변경했습니다. 최신 상태를 다시 불러왔습니다." : err instanceof Error ? err.message : "변경을 저장하지 못했습니다.");
      await refresh(selected.id).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function addCandidates() {
    const lines = candidateLines.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 4);
    if (!lines.length) return;
    await act("save_candidates", { candidates: lines.map((line, index) => ({ id: `manual-${index + 1}`, title: line.slice(0, 200), rationale: "요청자가 DeskRPG에서 추가한 후보" })) });
    setCandidateLines("");
  }

  async function changeTeam(profile: string) {
    const next = team.includes(profile) ? team.filter((item) => item !== profile) : [...team, profile];
    setTeam(next);
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-5 py-8 sm:px-8">
      <header className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-muted"><BookOpenCheck size={17} /> 공동 작업 공간</div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-text">교육·발표 자료 워크플로</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-text-muted">DeskRPG와 Slack이 같은 작업 기록을 읽고 씁니다. 요청, 선택, 자료, 검토 이력은 하나의 작업 ID와 버전으로 저장됩니다. 민감한 고객·개인정보·내부 코드는 입력하지 마세요.</p>
      </header>

      {error && <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><CircleAlert size={17} />{error}</div>}

      <section className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <form onSubmit={createWorkflow} className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <h2 className="font-semibold text-text">새 교육 작업</h2>
            <label className="block text-xs font-medium text-text-muted">작업 제목<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" placeholder="예: AI 활용 보안 교육" /></label>
            <label className="block text-xs font-medium text-text-muted">요청 내용<textarea required maxLength={8000} value={requestText} onChange={(e) => setRequestText(e.target.value)} className="mt-1 min-h-24 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" placeholder="대상, 목적, 희망 산출물을 적어 주세요." /></label>
            <button disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"><Plus size={16} /> 작업 만들기</button>
          </form>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-text">진행 중인 작업</h2><button type="button" onClick={() => void refresh()} aria-label="새로고침" className="rounded-md p-1 text-text-muted hover:bg-canvas"><RefreshCw size={16} /></button></div>
            {loading ? <div className="flex items-center gap-2 text-sm text-text-muted"><LoaderCircle className="animate-spin" size={16} />불러오는 중</div> : rows.length === 0 ? <p className="text-sm text-text-muted">아직 작업이 없습니다.</p> : <ul className="space-y-2">{rows.map((row) => <li key={row.id}><button type="button" onClick={() => { setSelectedId(row.id); window.history.replaceState({}, "", `/workflows/education?taskId=${encodeURIComponent(row.id)}`); void refresh(row.id); }} className={`w-full rounded-xl border p-3 text-left ${selectedId === row.id ? "border-primary bg-primary/5" : "border-border hover:bg-canvas"}`}><span className="block truncate text-sm font-semibold text-text">{row.title}</span><span className="mt-1 block text-xs text-text-muted">{STAGES[row.stage] ?? row.stage} · v{row.version} · {row.source === "slack" ? "Slack" : "DeskRPG"}</span></button></li>)}</ul>}
          </div>
        </aside>

        <section className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-7">
          {!selected ? <div className="grid min-h-72 place-items-center text-sm text-text-muted">목록에서 작업을 선택하거나 새 작업을 만드세요.</div> : <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
              <div><p className="text-xs font-semibold uppercase tracking-wide text-primary">EDU · {selected.id.slice(0, 8)} · 버전 {selected.version}</p><h2 className="mt-2 text-2xl font-bold text-text">{selected.title}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">{selected.requestText}</p></div>
              <div className="flex items-center gap-2"><span className="rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">{STAGES[selected.stage] ?? selected.stage}</span>{selected.status === "paused" && <span className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800">보류</span>}{selected.status === "approved" && <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-800">승인</span>}</div>
            </div>
            <div className="mt-5 space-y-5">
              {selected.stage === "topic_recommendation" && <div className="space-y-3"><h3 className="font-semibold text-text">주제 후보</h3>{candidates.length ? <div className="grid gap-3 sm:grid-cols-2">{candidates.map((candidate) => <article key={candidate.id} className="rounded-xl border border-border p-4"><h4 className="font-semibold text-text">{candidate.title}</h4><p className="mt-2 text-sm leading-5 text-text-muted">{candidate.rationale}</p>{candidate.audience && <p className="mt-2 text-xs text-text-muted">대상: {candidate.audience}</p>}{candidate.deliverable && <p className="text-xs text-text-muted">산출물: {candidate.deliverable}</p>}<button disabled={busy} onClick={() => void act("choose_topic", { candidateId: candidate.id })} className="mt-3 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">이 주제 선택</button></article>)}</div> : <p className="text-sm text-text-muted">Slack에서 Sophie에게 요청하면 후보가 이곳에도 나타납니다. 직접 추가할 수도 있습니다.</p>}<label className="block text-xs font-medium text-text-muted">직접 후보 추가 · 한 줄에 하나, 최대 4개<textarea value={candidateLines} onChange={(e) => setCandidateLines(e.target.value)} className="mt-1 min-h-20 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" /></label><button disabled={busy || !candidateLines.trim()} onClick={() => void addCandidates()} className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-text disabled:opacity-50">후보 저장</button></div>}
              {Boolean(selected.state.selectedTopic) && <div className="rounded-xl border border-border bg-canvas p-4"><h3 className="font-semibold text-text">선택 주제</h3><p className="mt-1 text-sm text-text">{(selected.state.selectedTopic as Candidate).title}</p></div>}
              {selected.stage === "topic_selected" && <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-text-muted">교육 대상<input value={audience} onChange={(e) => setAudience(e.target.value)} maxLength={300} className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" /></label><label className="text-xs font-medium text-text-muted">학습 목표<input value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={1000} className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" /></label><label className="text-xs font-medium text-text-muted">교육 시간(분)<input type="number" min={5} max={480} value={durationMinutes} onChange={(e) => setDurationMinutes(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" /></label><label className="text-xs font-medium text-text-muted">산출물<input value={deliverable} onChange={(e) => setDeliverable(e.target.value)} maxLength={300} className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" /></label><div className="sm:col-span-2"><button disabled={busy} onClick={() => void act("save_brief", { audience, objective, durationMinutes, deliverable })} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">교육 개요 저장</button></div></div>}
              {selected.stage === "brief_confirmed" && <div className="space-y-3"><h3 className="font-semibold text-text">참여 팀 선택</h3><div className="grid gap-2 sm:grid-cols-2">{TEAM.map((profile) => <label key={profile} className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-text"><input type="checkbox" checked={team.includes(profile)} onChange={() => void changeTeam(profile)} />{TEAM_NAME[profile]}</label>)}</div><button disabled={busy || !team.length} onClick={() => void act("select_team", { team })} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">팀 선택 저장</button></div>}
              {selected.stage === "team_selected" && <button disabled={busy} onClick={() => void act("start_research")} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">조사 단계로 이동</button>}
              {selected.stage === "researching" && <p className="rounded-xl bg-canvas p-4 text-sm leading-6 text-text-muted">Slack의 Sophie가 조사를 진행하면 요약과 출처가 이 작업에 저장됩니다. 완료 후 여기서 같은 결과와 검토 상태를 확인할 수 있습니다.</p>}
              {selected.stage === "evidence_review" && <button disabled={busy} onClick={() => void act("approve_research")} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">자료 검토 완료 · 구성안 단계로</button>}
              {selected.stage === "outline_review" && <div className="space-y-3"><h3 className="font-semibold text-text">교육 구성안</h3><label className="block text-xs font-medium text-text-muted">한 줄에 소주제 하나<textarea value={outlineText} onChange={(e) => setOutlineText(e.target.value)} className="mt-1 min-h-32 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" /></label><div className="flex flex-wrap gap-2"><button disabled={busy || !outlineText.trim()} onClick={() => void act("save_outline", { outline: outlineText.split("\n").map((line) => line.trim()).filter(Boolean) })} className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-text disabled:opacity-50">구성안 저장</button><button disabled={busy || !Array.isArray(selected.state.outline) || !(selected.state.outline as string[]).length} onClick={() => void act("approve_outline")} className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">구성안 승인</button></div></div>}
              {selected.stage === "cards_and_diagrams" && <div className="space-y-3"><h3 className="font-semibold text-text">이미지 카드·도식 요점</h3><label className="block text-xs font-medium text-text-muted">한 줄에 카드 핵심 하나<textarea value={cardsText} onChange={(e) => setCardsText(e.target.value)} className="mt-1 min-h-32 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text" /></label><button disabled={busy || !cardsText.trim()} onClick={() => void act("save_cards", { cards: cardsText.split("\n").map((line) => line.trim()).filter(Boolean) })} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">카드 요점 저장</button></div>}
              {selected.stage === "document_draft" && <div className="space-y-3"><h3 className="font-semibold text-text">교육 자료 초안</h3><label className="block text-xs font-medium text-text-muted">Markdown 초안<textarea value={documentDraft} onChange={(e) => setDocumentDraft(e.target.value)} maxLength={30000} className="mt-1 min-h-56 w-full rounded-lg border border-border bg-canvas px-3 py-2 font-mono text-sm text-text" /></label><button disabled={busy || !documentDraft.trim()} onClick={() => void act("save_document", { documentDraft })} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">최종 검토 요청</button></div>}
              {selected.stage === "final_review" && selected.status !== "approved" && <div className="space-y-3"><h3 className="font-semibold text-text">최종 자료 검토</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-canvas p-4 text-sm text-text">{String(selected.state.documentDraft ?? "초안이 아직 저장되지 않았습니다.")}</pre><button disabled={busy || !selected.state.documentDraft} onClick={() => void act("approve_final")} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">최종 승인</button></div>}
              {Boolean(selected.state.brief) && <div><h3 className="font-semibold text-text">교육 개요</h3><pre className="mt-2 whitespace-pre-wrap rounded-xl bg-canvas p-4 text-sm text-text">{JSON.stringify(selected.state.brief, null, 2) ?? ""}</pre></div>}
              {Boolean(selected.state.research) && <div><h3 className="font-semibold text-text">조사 자료</h3><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-canvas p-4 text-sm text-text">{JSON.stringify(selected.state.research, null, 2) ?? ""}</pre></div>}
              {Array.isArray(selected.state.outline) && selected.state.outline.length > 0 && <div><h3 className="font-semibold text-text">구성안</h3><ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-text">{(selected.state.outline as string[]).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></div>}
              {Array.isArray(selected.state.cards) && selected.state.cards.length > 0 && <div><h3 className="font-semibold text-text">카드 요점</h3><ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-text">{(selected.state.cards as string[]).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></div>}
              {selected.status === "paused" ? <button disabled={busy} onClick={() => void act("resume")} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text">작업 재개</button> : selected.status !== "approved" && <button disabled={busy} onClick={() => void act("pause")} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text">잠시 보류</button>}
              <div className="border-t border-border pt-4"><h3 className="font-semibold text-text">변경 이력</h3><ol className="mt-3 space-y-2">{(selected.events ?? []).slice().reverse().slice(0, 12).map((entry) => <li key={entry.id} className="flex flex-wrap justify-between gap-2 text-xs text-text-muted"><span>{entry.action} · {entry.actor} · v{entry.version}</span><time>{new Date(entry.createdAt).toLocaleString("ko-KR")}</time></li>)}</ol></div>
            </div>
          </>}
        </section>
      </section>
    </main>
  );
}
