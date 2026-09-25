import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider, type Locale } from "@/lib/i18n";
import WorkerPluginLine, { type WorkerPluginApplyResponse } from "./WorkerPluginLine";

const LOCALES: Locale[] = ["ko", "en", "ja", "zh"];
const WARN = { fixable: ["sophie", "oliver"], disabledByOperator: [] as string[] };

async function render(node: React.ReactElement, locale: Locale = "ko") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
  });
  return {
    host,
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const noop = async (): Promise<WorkerPluginApplyResponse> => ({ ok: true, results: [] });

test("without a warning there is no line at all", async () => {
  const { host, cleanup } = await render(
    <WorkerPluginLine warning={null} isOwner apply={noop} onApplied={() => {}} />,
  );
  assert.ok(!host.querySelector("[data-worker-plugin-line]"));
  await cleanup();
});

for (const locale of LOCALES) {
  test(`[${locale}] 직원 수와 이름, 소유자에게 버튼과 무엇이 바뀌는지를 보인다`, async () => {
    const { host, cleanup } = await render(
      <WorkerPluginLine warning={WARN} isOwner apply={noop} onApplied={() => {}} />,
      locale,
    );
    const text = host.textContent ?? "";
    assert.match(text, /2/);
    assert.match(text, /sophie, oliver/);
    assert.equal(host.querySelectorAll("button").length, 1);
    // Translation keys do not leak through as is.
    assert.doesNotMatch(text, /gateways\.workerPlugin/);
    await cleanup();
  });
}

test("non-owners get no button", async () => {
  const { host, cleanup } = await render(
    <WorkerPluginLine warning={WARN} isOwner={false} apply={noop} onApplied={() => {}} />,
  );
  assert.equal(host.querySelectorAll("button").length, 0);
  assert.match(host.textContent ?? "", /sophie/);
  await cleanup();
});

test("employees the operator turned off are mentioned separately", async () => {
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={{ fixable: ["sophie"], disabledByOperator: ["mia"] }}
      isOwner
      apply={noop}
      onApplied={() => {}}
    />,
  );
  assert.match(host.textContent ?? "", /mia/);
  await cleanup();
});

test("applying reloads the list, and the result notice stays even after the warning disappears", async () => {
  let reloaded = 0;
  const { host, root, cleanup } = await render(
    <WorkerPluginLine
      warning={WARN}
      isOwner
      apply={async () => ({
        ok: true,
        results: [
          { profile: "sophie", link: "created", enabled: "added" },
          { profile: "oliver", error: "config_unreadable" },
        ],
      })}
      onApplied={() => {
        reloaded += 1;
      }}
    />,
  );
  await act(async () => {
    host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.equal(reloaded, 1);
  assert.ok(host.querySelector('[data-worker-plugin-result="applied"]'));
  assert.ok(host.querySelector('[data-worker-plugin-failure="oliver"]'));
  assert.ok(!host.querySelector('[data-worker-plugin-failure="sophie"]'));

  // The list was reloaded and the warning is gone — the user must read the cron restart notice, so the result stays.
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <WorkerPluginLine warning={null} isOwner apply={noop} onApplied={() => {}} />
      </I18nProvider>,
    );
  });
  assert.ok(host.querySelector('[data-worker-plugin-result="applied"]'));
  await cleanup();
});

test("a failed request shows the code and does not reload the list", async () => {
  let reloaded = 0;
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={WARN}
      isOwner
      apply={async () => ({ ok: false, errorCode: "plugin_unreachable" })}
      onApplied={() => {
        reloaded += 1;
      }}
    />,
  );
  await act(async () => {
    host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.equal(reloaded, 0);
  assert.ok(host.querySelector('[data-worker-plugin-result="error"]'));
  assert.match(host.textContent ?? "", /plugin_unreachable/);
  await cleanup();
});

// --- 0.16.0 worker propagation opt-in -------------------------------------------------

const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const buttonText = (host: HTMLElement, text: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""));

for (const locale of LOCALES) {
  test(`[${locale}] 전파가 꺼져 있으면 빠진 직원이 없어도 설명과 켜는 명령을 보인다`, async () => {
    const { host, cleanup } = await render(
      <WorkerPluginLine
        warning={null}
        propagation="disabled"
        isOwner
        apply={noop}
        onApplied={() => {}}
        onRecheck={() => {}}
      />,
      locale,
    );
    const text = host.textContent ?? "";
    assert.ok(host.querySelector('[data-worker-propagation="disabled"]'));
    assert.match(text, /hermes config set plugins\.entries\.deskrpg\.worker_propagation true/);
    assert.match(text, /DESKRPG_WORKER_PROPAGATION/);
    assert.doesNotMatch(text, /gateways\.workerPlugin/);
    assert.doesNotMatch(text, /worker_propagation_disabled/);
    await cleanup();
  });
}

test("with propagation off, [적용] is hidden and [다시 확인] calls onRecheck", async () => {
  let rechecked = 0;
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={WARN}
      propagation="disabled"
      isOwner
      apply={noop}
      onApplied={() => {}}
      onRecheck={() => {
        rechecked += 1;
      }}
    />,
  );
  assert.equal(buttonText(host, /^적용$/), undefined);
  assert.match(host.textContent ?? "", /sophie, oliver/);
  await click(host.querySelector('[data-action="worker-propagation-recheck"]')!);
  assert.equal(rechecked, 1);
  await cleanup();
});

test("with an enable entry point, [설정에서 켜기] turns it on and reloads the list — no command at first", async () => {
  let calls = 0;
  let reloaded = 0;
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={null}
      propagation="disabled"
      isOwner
      apply={noop}
      onApplied={() => {
        reloaded += 1;
      }}
      enablePropagation={async () => {
        calls += 1;
        return { ok: true, results: [{ profile: "sophie", link: "created", enabled: "added" }] };
      }}
    />,
  );
  assert.doesNotMatch(host.textContent ?? "", /hermes config set/);
  await click(host.querySelector('[data-action="worker-propagation-enable"]')!);
  assert.equal(calls, 1);
  assert.equal(reloaded, 1);
  assert.ok(host.querySelector('[data-worker-propagation-result="enabled"]'));
  await cleanup();
});

test("a host where commands cannot run (plugin_update_unsupported_host) falls back to copying the command", async () => {
  let reloaded = 0;
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={null}
      propagation="disabled"
      isOwner
      apply={noop}
      onApplied={() => {
        reloaded += 1;
      }}
      enablePropagation={async () => ({ ok: false, errorCode: "plugin_update_unsupported_host" })}
    />,
  );
  await click(host.querySelector('[data-action="worker-propagation-enable"]')!);
  const text = host.textContent ?? "";
  assert.equal(reloaded, 0);
  assert.match(text, /hermes config set/);
  assert.doesNotMatch(text, /plugin_update_unsupported_host/);
  await cleanup();
});

test("turned on but the apply step failed reports that and reloads the list ([적용] shows again)", async () => {
  let reloaded = 0;
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={null}
      propagation="disabled"
      isOwner
      apply={noop}
      onApplied={() => {
        reloaded += 1;
      }}
      enablePropagation={async () => ({ ok: true, applyErrorCode: "plugin_unreachable" })}
    />,
  );
  await click(host.querySelector('[data-action="worker-propagation-enable"]')!);
  assert.equal(reloaded, 1);
  assert.ok(host.querySelector('[data-worker-propagation-result="apply-failed"]'));
  assert.match(host.textContent ?? "", /plugin_unreachable/);
  await cleanup();
});

test("an apply request answered with 409 worker_propagation_disabled shows an explanation and how to turn it on instead of the raw code", async () => {
  let reloaded = 0;
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={WARN}
      isOwner
      apply={async () => ({ ok: false, errorCode: "worker_propagation_disabled" })}
      onApplied={() => {
        reloaded += 1;
      }}
      onRecheck={() => {}}
    />,
  );
  await click(buttonText(host, /^적용$/)!);
  const text = host.textContent ?? "";
  assert.equal(reloaded, 0);
  assert.ok(!host.querySelector('[data-worker-plugin-result="error"]'));
  assert.ok(host.querySelector('[data-worker-propagation="disabled"]'));
  assert.doesNotMatch(text, /worker_propagation_disabled/);
  assert.match(text, /hermes config set/);
  await cleanup();
});

test("non-owners get only the explanation — no command or button", async () => {
  const { host, cleanup } = await render(
    <WorkerPluginLine
      warning={null}
      propagation="disabled"
      isOwner={false}
      apply={noop}
      onApplied={() => {}}
      onRecheck={() => {}}
    />,
  );
  assert.ok(host.querySelector('[data-worker-propagation="disabled"]'));
  assert.equal(host.querySelectorAll("button").length, 0);
  assert.doesNotMatch(host.textContent ?? "", /hermes config set/);
  await cleanup();
});

test("when propagation is on or unknown (old plugin), it behaves as before", async () => {
  for (const propagation of ["enabled", null, undefined] as const) {
    const { host, cleanup } = await render(
      <WorkerPluginLine
        warning={null}
        propagation={propagation}
        isOwner
        apply={noop}
        onApplied={() => {}}
      />,
    );
    assert.ok(!host.querySelector("[data-worker-plugin-line]"));
    await cleanup();
  }
});
