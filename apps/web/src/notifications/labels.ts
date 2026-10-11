import { formatCurrency, type Locale, type Notification } from '@profitbash/shared';
import { i18n } from '../i18n';

/**
 * Titel und Text einer Benachrichtigung (5.2b) aus `notifications.kind.<kind>` und den Parametern des Servers.
 * Fehlt ein Parameter (ältere Zeilen, neue Arten), bleibt der Text lesbar.
 */
export function notificationTexts(
  notification: Notification,
  locale: Locale = 'de-DE',
): { title: string; text: string } {
  const { t, te } = i18n.global;
  const { kind, params, profileName } = notification;
  const key = `notifications.kind.${kind}`;
  const str = (name: string) => {
    const value = params[name];
    return value === undefined ? '' : String(value);
  };
  const num = (name: string) => {
    const value = Number(params[name] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const money = (name: string) =>
    str(name) && str('currencyCode') ? formatCurrency(str(name), str('currencyCode'), locale) : '';
  const channel = str('channel');
  const channelKey = `changes.channel.${channel}`;
  const where = [profileName, channel && te(channelKey) ? t(channelKey) : null]
    .filter(Boolean)
    .join(', ');
  const named: Record<string, string | number> = {
    fileName: str('fileName'),
    profile: profileName ? ` (${profileName})` : '',
    profileName: profileName ?? t('notifications.thisProfile'),
    error: str('error') || t('notifications.importFailedFallback'),
    where: where || t('notifications.submission'),
    applied: num('applied'),
    failed: num('failed'),
    // `{count}` liefert vue-i18n aus dem Plural; ein eigener Parameter `count` überschriebe ihn.
    days: num('days'),
    account: str('account') || t('notifications.thisConnection'),
    // Budget-Caps (5.9b)
    percent: num('percent'),
    amount: money('amount'),
    actual: money('actual'),
    forecast: money('forecast'),
  };
  const plural =
    kind === 'submission_failed'
      ? num('failed')
      : kind === 'submission_finished'
        ? num('applied')
        : kind === 'automation_proposals' || kind === 'automation_findings'
          ? num('count')
          : num('days');
  return { title: t(`${key}.title`), text: t(`${key}.text`, named, plural) };
}
