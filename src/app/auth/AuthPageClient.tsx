"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import DeskRpgMark from "@/components/DeskRpgMark";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import { ArrowUpRight, Sun } from "lucide-react";
import "./commute.css";

const CommuteCityScene = dynamic(() => import("@/components/CommuteCityScene"), { ssr: false });

const isRegistrationDisabled = process.env.NEXT_PUBLIC_REGISTRATION_DISABLED === "true";

export default function AuthPageClient({ isComingSoon }: { isComingSoon: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginId, setLoginId] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(!isComingSoon);
  const [hasUsers, setHasUsers] = useState(true);
  const router = useRouter();
  const t = useT();

  useEffect(() => {
    if (isComingSoon) return;

    Promise.all([
      fetch("/api/characters", { redirect: "manual" }),
      fetch("/api/auth/status")
        .then((r) => (r.ok ? r.json() : { hasUsers: true }))
        .catch(() => ({ hasUsers: true })),
    ])
      .then(([charRes, status]) => {
        if (charRes.ok) {
          router.replace("/gateways");
        } else {
          setHasUsers(status.hasUsers);
          if (!status.hasUsers) setMode("register");
          else if (isRegistrationDisabled) setMode("login");
          setChecking(false);
        }
      })
      .catch(() => {
        setChecking(false);
      });
  }, [router, isComingSoon]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const payload = mode === "login" ? { loginId, password } : { loginId, nickname, password };

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

      // If they came in with a temporary password, send them straight to the change screen.
      if (data?.user?.mustChangePassword) {
        router.push("/account/password?forced=1");
        return;
      }

      router.push("/gateways");
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
    <div
      className={`theme-web commute-home ${isComingSoon ? "commute-home--soon" : "commute-home--login"}`}
    >
      <div className="commute-sun" aria-hidden="true" />
      <div className="commute-clouds" aria-hidden="true">
        <span className="commute-cloud" />
        <span className="commute-cloud" />
        <span className="commute-cloud" />
      </div>
      <CommuteCityScene />
      <header className="commute-header">
        <Link href="/" className="commute-brand">
          <DeskRpgMark size={30} />
          DeskRPG <span>AI Coworking Space</span>
        </Link>
      </header>

      {/* Language switcher */}
      <div className="fixed top-4 right-4 z-30">
        <LocaleSwitcher />
      </div>

      {/* Login card - centered */}
      <div className="commute-form">
        <div className="w-full max-w-[420px]">
          {/* Title */}
          <div className="commute-intro">
            <p className="commute-eyebrow">
              <Sun size={14} aria-hidden="true" /> {t("auth.morningGreeting")}
            </p>
            <h1>
              DeskRPG <span>AI Coworking Space</span>
            </h1>
            <p className="commute-subtitle">{t("auth.heroSubtitle")}</p>
          </div>

          {/* Card */}
          <div className="commute-card">
            {isComingSoon ? (
              <div className="text-center">
                <div className="commute-coming-soon">
                  <span />
                  {t("auth.comingSoon")}
                </div>
                <a
                  href="https://github.com/dandacompany/deskrpg"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="commute-github"
                >
                  {t("auth.comingSoonGithub")}
                  <ArrowUpRight size={17} aria-hidden="true" />
                </a>
              </div>
            ) : (
              <>
                {/* Tab switcher — hidden during fresh setup or when registration is disabled */}
                {hasUsers && !isRegistrationDisabled && (
                  <div className="flex mb-5 rounded-lg overflow-hidden border border-border">
                    <button
                      onClick={() => setMode("login")}
                      className={`flex-1 py-2.5 text-center text-sm font-semibold transition-colors ${
                        mode === "login"
                          ? "bg-primary text-white"
                          : "bg-bg-deep text-text-dim hover:text-text-secondary"
                      }`}
                    >
                      {t("auth.login")}
                    </button>
                    <button
                      onClick={() => setMode("register")}
                      className={`flex-1 py-2.5 text-center text-sm font-semibold transition-colors ${
                        mode === "register"
                          ? "bg-primary text-white"
                          : "bg-bg-deep text-text-dim hover:text-text-secondary"
                      }`}
                    >
                      {t("auth.register")}
                    </button>
                  </div>
                )}

                {/* Fresh install description */}
                {!hasUsers && (
                  <div className="mb-5 space-y-2">
                    <p className="text-center text-sm text-text-secondary">
                      {t("auth.setupDescription")}
                    </p>
                    {/* The first account becomes the admin: what that means, and how to close sign-ups on a reachable server. */}
                    <p className="text-center text-xs text-text-muted">
                      {t("auth.setupAdminNotice")}
                    </p>
                    <p className="text-center text-xs text-text-muted">
                      {t("auth.setupSignupNotice")}
                    </p>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-3">
                  <input
                    type="text"
                    placeholder={t("auth.loginIdPlaceholder")}
                    value={loginId}
                    onChange={(e) => setLoginId(e.target.value)}
                    className="w-full px-4 py-2.5 bg-bg-deep text-text rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary-light text-sm placeholder-text-dim"
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
                      className="w-full px-4 py-2.5 bg-bg-deep text-text rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary-light text-sm placeholder-text-dim"
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
                    className="w-full px-4 py-2.5 bg-bg-deep text-text rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary-light text-sm placeholder-text-dim"
                    minLength={4}
                    required
                  />
                  {error && <p className="text-danger text-sm">{error}</p>}
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 rounded-lg text-white font-semibold text-sm disabled:opacity-50 mt-2"
                    style={{
                      background: "var(--color-primary)",
                      boxShadow: "0 3px 0 rgba(41,74,58,0.15)",
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
      <footer className="commute-footer">
        <span>HERMES × YOUR LITTLE WORLD</span>
        <span>{t("auth.morningCaption")}</span>
      </footer>
    </div>
  );
}
