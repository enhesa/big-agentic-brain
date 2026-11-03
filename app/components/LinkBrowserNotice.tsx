import Link from "next/link";
import { linkNeededReason } from "@/lib/link-notice";

/**
 * The one notice for a signed-in viewer BAB cannot key yet (short alias or other address, no
 * link): what is missing, the one step that fixes it, and what it unlocks. Text: lib/link-notice.ts.
 */
export default function LinkBrowserNotice({ then, className }: { then: string; className?: string }) {
  return (
    <p className={className} data-testid="link-browser-notice">
      {linkNeededReason()} Confirm it once on <Link href="/me/devices">Your devices</Link>, then {then}. This browser stays linked
      after that.
    </p>
  );
}
