/**
 * Presentation settings derived from config(): org name, accent colour, plugin marketplace and
 * the date format. Server-only (it reads config()); client components get what they need as props.
 */
import { config } from "./config";

export interface Branding {
  orgName: string;
  accentColor: string;
  /** The accent at 12% alpha, as an 8-digit hex. */
  accentSoft: string;
  marketplace: string;
  marketplaceName: string;
  installCommands: { marketplace: string; install: string };
  /** Optional landing-page install screenshot (BAB_INSTALL_SCREENSHOT), with its alt text. */
  installScreenshot: { src: string; alt: string } | null;
}

export function branding(): Branding {
  const b = config().branding;
  return {
    orgName: b.orgName,
    accentColor: b.accentColor,
    accentSoft: `${b.accentColor}1f`,
    marketplace: b.pluginMarketplace,
    marketplaceName: b.pluginMarketplaceName,
    installCommands: {
      marketplace: `/plugin marketplace add ${b.pluginMarketplace}`,
      install: `/plugin install bab@${b.pluginMarketplaceName}`,
    },
    installScreenshot: b.installScreenshot ? { src: b.installScreenshot, alt: b.installScreenshotAlt } : null,
  };
}

/** Formats a date in the configured locale and time zone (BAB_LOCALE, BAB_TIMEZONE). */
export function formatDate(d: Date, opts?: Intl.DateTimeFormatOptions): string {
  const { locale, timeZone } = config().branding;
  return new Intl.DateTimeFormat(locale, { timeZone, ...opts }).format(d);
}

/** Date plus time, the equivalent of toLocaleString(), for tooltips. */
export const DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "medium" };
