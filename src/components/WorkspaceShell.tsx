"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UsersRound, Network, UserRound, Building2 } from "lucide-react";
import DeskRpgMark from "./DeskRpgMark";
import OfficeBuilding from "./OfficeBuilding";
import LocaleSwitcher from "./LocaleSwitcher";
import LogoutButton from "./LogoutButton";
import { WORKSPACE_NAV } from "./workspace-navigation";
import { useT } from "@/lib/i18n";

/** Navigation only: route-specific auth, role checks and actions stay with each page. */
export default function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  if (pathname === "/" || pathname.startsWith("/auth") || pathname.startsWith("/game")) {
    return children;
  }
  const icons = {
    gateways: Network,
    profiles: UsersRound,
    characters: UserRound,
    channels: Building2,
  } as const;
  const links = WORKSPACE_NAV.map(({ key, href }) => ({
    href,
    label: t(`nav.${key}`),
    icon: icons[key],
  }));
  function guardNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!window.dispatchEvent(new Event("workspace:before-navigate", { cancelable: true }))) {
      event.preventDefault();
    }
  }
  const editing = pathname === "/characters";
  return (
    <div className={`workspace-shell${editing ? " workspace-shell--editing" : ""}`}>
      <aside className="workspace-sidebar">
        <Link
          href="/gateways"
          className="workspace-brand"
          aria-label="DeskRPG"
          onClick={guardNavigation}
        >
          <span className="workspace-brand-mark">
            <DeskRpgMark size={44} />
          </span>
          <span>
            DeskRPG<small>AI COWORKING SPACE</small>
          </span>
        </Link>
        <nav className="workspace-navigation" aria-label="DeskRPG">
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-label={label}
              onClick={guardNavigation}
              aria-current={pathname.startsWith(href) ? "page" : undefined}
            >
              <Icon size={19} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        {/* Logout and language are common to every screen so the sidebar owns them — the page
            header keeps only that screen's actions so button labels don't wrap at narrow widths (2026-09-20). */}
        <div className="workspace-sidebar-actions">
          <Link href="/account/password" className="workspace-sidebar-action-link">
            {t("account.password.title")}
          </Link>
          <LogoutButton />
          <LocaleSwitcher />
        </div>
        <div className="workspace-sidebar-art" aria-hidden="true">
          <OfficeBuilding />
        </div>
      </aside>
      <div className="workspace-content">{children}</div>
    </div>
  );
}
