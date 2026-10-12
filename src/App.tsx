import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import ProtectedRoute from "@/components/ProtectedRoute";
import { AppShell } from "@/components/shell";
import { ActivityRedirect } from "@/components/ActivityRedirect";
import { LoadingRegion } from "@/components/primitives";
import { AuthProvider } from "@/hooks/useAuth";
import { NotificationsProvider } from "@/hooks/useNotifications";
import { PreferencesProvider } from "@/hooks/usePreferences";
import { ConversationsProvider } from "@/hooks/useConversations";

// Login stays eager: it is the cold-start destination for every signed-out
// visitor (ProtectedRoute redirects there), so lazy-loading it would cost
// that path a second sequential round trip.
import Login from "./pages/Login";

// Everything behind auth is split per route.
const Home = lazy(() => import("./pages/Home"));
const PostRequest = lazy(() => import("./pages/PostRequest"));
const OrderingActive = lazy(() => import("./pages/activity/OrderingActive"));
const OrderingHistory = lazy(() => import("./pages/activity/OrderingHistory"));
const DeliveringActive = lazy(() => import("./pages/activity/DeliveringActive"));
const DeliveringHistory = lazy(() => import("./pages/activity/DeliveringHistory"));
const Profile = lazy(() => import("./pages/Profile"));
const Insights = lazy(() => import("./pages/Insights"));
const Friends = lazy(() => import("./pages/Friends"));
const Messages = lazy(() => import("./pages/Messages"));
const Settings = lazy(() => import("./pages/Settings"));
const VerifyEmail = lazy(() => import("./pages/VerifyEmail"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            {/* One shared auth listener for the whole app - see useAuth.tsx
                for why per-component listeners caused both duplicate
                profile fetches and a real deadlock on reload. */}
            <AuthProvider>
            {/* Needs useAuth(), so nested inside AuthProvider - only
                subscribes/fetches while a user is signed in (see
                useNotifications.tsx). */}
            <NotificationsProvider>
            {/* Same reasoning as NotificationsProvider above - Settings and
                Home (and any future consumer) must share one live copy of
                the user's preferences, not each fetch and hold their own,
                so a change made on one page is visible on the other
                immediately, not only after a remount. */}
            <PreferencesProvider>
            <ConversationsProvider>
              <Suspense fallback={<LoadingRegion label="Loading CampusLink" />}>
                <Routes>
                  <Route path="/login" element={<Login />} />

                  {/* Every route below shares one auth guard and one
                      application shell (nav, page frame) — mounted once
                      here rather than imported per page. */}
                  <Route
                    element={
                      <ProtectedRoute>
                        <AppShell />
                      </ProtectedRoute>
                    }
                  >
                    <Route path="/" element={<Home />} />
                    <Route path="/post-request" element={<PostRequest />} />
                    {/* Activity restructure (Ordering/Delivering split) -
                        /my-orders and bare /activity both redirect to the
                        default sub-view, preserving any ?order= deep-link. */}
                    <Route path="/my-orders" element={<ActivityRedirect />} />
                    <Route path="/activity" element={<ActivityRedirect />} />
                    <Route path="/activity/ordering" element={<OrderingActive />} />
                    <Route path="/activity/ordering/history" element={<OrderingHistory />} />
                    <Route path="/activity/delivering" element={<DeliveringActive />} />
                    <Route path="/activity/delivering/history" element={<DeliveringHistory />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/insights" element={<Insights />} />
                    <Route path="/friends" element={<Friends />} />
                    <Route path="/messages" element={<Messages />} />
                    <Route path="/messages/:conversationId" element={<Messages />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/verify-email" element={<VerifyEmail />} />
                    <Route path="/reset-password" element={<ResetPassword />} />
                  </Route>

                  {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </ConversationsProvider>
            </PreferencesProvider>
            </NotificationsProvider>
            </AuthProvider>
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
