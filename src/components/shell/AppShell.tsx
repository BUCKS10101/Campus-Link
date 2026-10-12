import * as React from "react";
import { Outlet } from "react-router-dom";

import { DesktopNav } from "./DesktopNav";
import { MobileHeader } from "./MobileHeader";
import { MobileNav } from "./MobileNav";
import { PageContainer } from "./PageContainer";
import { ThemeNotice } from "./ThemeNotice";

/**
 * The one application frame every authenticated page renders inside of.
 *
 * Mounted once, above <Outlet/>, in App.tsx's protected layout route —
 * not imported per-page. Previously every page (Home, PostRequest,
 * MyOrders ×4 return paths, Profile) rendered its own <Header/>,
 * <MobileNav/>, and page-width wrapper independently; four slightly
 * different implementations of the same frame. This is the single one.
 *
 * SupportChat is deliberately not mounted here — see the 2B report for
 * why (it was a fully mocked widget with no real backend behind it, not
 * part of the approved IA).
 */
export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <ThemeNotice />
      <DesktopNav />
      <MobileHeader />
      <main className="flex-1">
        <PageContainer className="pt-6 pb-24 md:pt-8 md:pb-12">
          <Outlet />
        </PageContainer>
      </main>
      <MobileNav />
    </div>
  );
}
