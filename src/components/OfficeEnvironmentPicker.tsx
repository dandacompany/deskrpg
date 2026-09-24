"use client";

import Image from "next/image";
import thumbnails from "@/game/three/office-environment-thumbnails.json";
import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useLocale, useT } from "@/lib/i18n";
import {
  OFFICE_ENVIRONMENTS,
  buildOfficeEnvironment,
  environmentLabel,
} from "@/game/three/office-environments";

const Preview = dynamic(() => import("./ThreeMapPreview"), { ssr: false });

export default function OfficeEnvironmentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { locale } = useLocale();
  const t = useT();
  const selected =
    OFFICE_ENVIRONMENTS.find((environment) => environment.id === value) ?? OFFICE_ENVIRONMENTS[0];
  const map = useMemo(() => buildOfficeEnvironment(selected.id), [selected.id]);
  return (
    <section aria-label={t("officeEnv.choose")} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("officeEnv.title")}</h2>
        <span className="text-xs text-text-muted">{t("officeEnv.count")}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {OFFICE_ENVIRONMENTS.map((environment, index) => (
          <button
            key={environment.id}
            type="button"
            aria-pressed={environment.id === value}
            onClick={() => onChange(environment.id)}
            className={`text-left rounded-lg border p-3 transition-colors ${environment.id === value ? "border-accent bg-accent/10" : "border-border bg-surface hover:bg-surface-raised"}`}
          >
            <div className="mb-2 aspect-[874/450] w-full overflow-hidden rounded bg-background">
              <Image
                src={thumbnails[environment.id]}
                width={874}
                height={450}
                sizes="(max-width: 640px) 45vw, 260px"
                alt={t("officeEnv.thumbnailAlt", {
                  name: environmentLabel(environment, locale).name,
                })}
                className="h-full w-full object-contain"
              />
            </div>
            <span className="block text-xs mb-2" style={{ color: environment.color }}>
              0{index + 1}
            </span>
            <span className="block font-semibold text-sm">
              {environmentLabel(environment, locale).name}
            </span>
          </button>
        ))}
      </div>
      <div
        className="h-72 sm:h-96 overflow-hidden rounded-lg border border-border"
        aria-label={t("officeEnv.previewLabel")}
      >
        <Preview map={map} />
      </div>
      <p className="text-sm text-text-muted">{environmentLabel(selected, locale).description}</p>
    </section>
  );
}
