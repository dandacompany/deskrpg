/** A bare code (`not_member`, `gatewayGone`) rather than a sentence someone already translated. */
const CODE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The meeting entry error to show. The state holds either a reason code from the server or a
 * message already translated on this side. A known code is translated; an unknown code gets the
 * generic reason instead of its raw spelling; a message is shown as it is.
 */
export function meetingErrorDisplay(value: string, t: (key: string) => string): string {
  const key = `meeting.reason.${value}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return CODE.test(value) ? t("meeting.reason.unknown") : value;
}
