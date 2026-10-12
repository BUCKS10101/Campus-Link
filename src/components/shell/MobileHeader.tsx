import * as React from "react";
import { Link } from "react-router-dom";

import { BrandMark } from "./BrandMark";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { MessagesLink } from "./MessagesLink";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Mobile has no persistent top bar today (DesktopNav is `md:hidden`,
 * MobileNav is only the bottom tab bar) - see the Phase 3C spec's mobile
 * decision. This is deliberately minimal: the mark + wordmark for
 * orientation, and the one persistent entry point mobile needs that
 * doesn't fit in the bottom bar's fixed slots.
 */
export function MobileHeader() {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b-2 border-foreground bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden">
      <Link
        to="/"
        className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <BrandMark size={20} />
        <span className="font-display text-[20px] leading-none text-foreground">CampusLink</span>
      </Link>
      <div className="flex items-center">
        <ThemeToggle />
        <MessagesLink />
        <NotificationBell />
      </div>
    </header>
  );
}
