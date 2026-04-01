"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import CityScapeBackground from "@/components/CityScapeBackground";

const isComingSoon = process.env.NEXT_PUBLIC_COMING_SOON === "true";

export default function AuthPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginId, setLoginId] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [hasUsers, setHasUsers] = useState(true);
  const router = useRouter();
  const t = useT();

  useEffect(() => {
    Promise.all([
      fetch("/api/characters", { redirect: "manual" }),
      fetch("/api/auth/status").then((r) => r.ok ? r.json() : { hasUsers: true }).catch(() => ({ hasUsers: true })),
    ]).then(([charRes, status]) => {
      if (charRes.ok) {
        router.replace("/characters");
      } else {
        setHasUsers(status.hasUsers);
        if (!status.hasUsers) setMode("register");
        setChecking(false);
      }
    }).catch(() => {
      setChecking(false);
    });
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const payload =
      mode === "login"
        ? { loginId, password }
        : { loginId, nickname, password };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(getLocalizedErrorMessage(t, data));
        return;
      }

      router.push("/characters");
    } catch {
      setError(t("common.networkError"));
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
        {t("auth.checkingAuth")}
      </div>
    );
  }

  return (
    <div className="theme-web min-h-screen relative">
      <CityScapeBackground />

      {/* Language switcher */}
      <div className="fixed top-4 right-4 z-30">
        <LocaleSwitcher />
      </div>

      {/* Login card - centered */}
      <div className="fixed inset-0 flex items-start justify-center pt-[15vh] z-20 pointer-events-none">
        <div className="max-w-[360px] w-[90%] pointer-events-auto">
          {/* Title */}
          <div className="text-center mb-4">
            <h1
              className="font-black text-white font-mono tracking-[10px]"
              style={{
                fontSize: "clamp(28px, 5vw, 42px)",
                textShadow: "0 0 40px rgba(99,102,241,0.3),0 0 80px rgba(99,102,241,0.1),0 2px 4px rgba(0,0,0,0.8)",
              }}
            >
              DeskRPG
            </h1>
            <p
              className="text-[10px] text-primary-light tracking-[6px] mt-1"
              style={{ textShadow: "0 0 12px rgba(129,140,248,0.3)" }}
            >
              {t("auth.heroTagline")}
            </p>
            <p className="mt-3 text-sm text-text-secondary">
              {t("auth.heroSubtitle")}
            </p>
          </div>

          {/* Card */}
          <div
            className="rounded-[14px] p-6"
            style={{
              background: "rgba(10,15,30,0.92)",
              backdropFilter: "blur(20px)",
              border: "1px solid rgba(99,102,241,0.15)",
              boxShadow: "0 8px 48px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.03),inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
          >
            {isComingSoon ? (
              <div className="text-center">
                <div className="text-2xl font-bold text-white mb-5">{t("auth.comingSoon")}</div>
                <a
                  href="https://github.com/dandacompany/deskrpg"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block w-full py-2.5 rounded-lg text-white font-semibold text-sm text-center"
                  style={{
                    background: "linear-gradient(135deg,#4f46e5,#6d28d9)",
                    boxShadow: "0 4px 20px rgba(79,70,229,0.4)",
                  }}
                >
                  {t("auth.comingSoonGithub")}
                </a>
              </div>
            ) : (
            <>
            {/* Tab switcher — hidden during fresh setup */}
            {hasUsers && (
              <div className="flex mb-5 rounded-lg overflow-hidden border border-border">
                <button
                  onClick={() => setMode("login")}
                  className={`flex-1 py-2.5 text-center text-sm font-semibold transition-colors ${
                    mode === "login"
                      ? "bg-primary text-white"
                      : "bg-[#0a0f1e] text-text-dim hover:text-text-secondary"
                  }`}
                >
                  {t("auth.login")}
                </button>
                <button
                  onClick={() => setMode("register")}
                  className={`flex-1 py-2.5 text-center text-sm font-semibold transition-colors ${
                    mode === "register"
                      ? "bg-primary text-white"
                      : "bg-[#0a0f1e] text-text-dim hover:text-text-secondary"
                  }`}
                >
                  {t("auth.register")}
                </button>
              </div>
            )}

            {/* Fresh install description */}
            {!hasUsers && (
              <p className="text-center text-sm text-text-secondary mb-5">
                {t("auth.setupDescription")}
              </p>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="text"
                placeholder={t("auth.loginIdPlaceholder")}
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                className="w-full px-4 py-2.5 bg-[#0a0f1e] text-white rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary-light text-sm placeholder-text-dim"
                minLength={2}
                maxLength={50}
                required
              />
              {mode === "register" && (
                <input
                  type="text"
                  placeholder={t("auth.displayNamePlaceholder")}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  className="w-full px-4 py-2.5 bg-[#0a0f1e] text-white rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary-light text-sm placeholder-text-dim"
                  minLength={2}
                  maxLength={50}
                  required
                />
              )}
              <input
                type="password"
                placeholder={t("auth.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 bg-[#0a0f1e] text-white rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary-light text-sm placeholder-text-dim"
                minLength={4}
                required
              />
              {error && <p className="text-danger text-sm">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-white font-semibold text-sm disabled:opacity-50 mt-2"
                style={{
                  background: "linear-gradient(135deg,#4f46e5,#6d28d9)",
                  boxShadow: "0 4px 20px rgba(79,70,229,0.4)",
                }}
              >
                {loading
                  ? mode === "login"
                    ? t("auth.loggingIn")
                    : t("auth.registering")
                  : !hasUsers
                  ? t("auth.getStarted")
                  : mode === "login"
                  ? t("auth.login")
                  : t("auth.register")}
              </button>
            </form>
            </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
